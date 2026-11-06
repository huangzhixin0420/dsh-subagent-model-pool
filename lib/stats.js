/**
 * 模型池使用统计账本。
 *
 * 与 {@link module:dsh-subagent-model-pool/pool} 的分工：
 * - `pool` 管「当下谁占着谁的名额」，池实例随配置热更新整体替换；
 * - `stats` 管「一共用了多少」，必须跨池替换存活，所以独立于池实例，
 *   由插件入口的 `apply` 闭包持有。
 *
 * 路由键用 JSON 编码的 `[provider, model]`：NUL 拼接在 provider/model
 * 自带分隔符时会碰撞（与 client.js 的 `poolKey` 同一口径）。
 *
 * token 口径对齐 DSH 的 `TokenUsage`（dsh-llm/lib/types/types.d.ts:167）：
 * `inputTokens` 是未缓存输入，缓存读写另计两个桶——与
 * `dsh-token-meter` 的四桶投影同义，UI 上不能把它们混成一个「输入」。
 *
 * @module dsh-subagent-model-pool/stats
 */

/** 单个会话在账本里最多保留的明细条数上限（超出按最久未更新淘汰）。 */
export const MAX_TRACKED_SESSIONS = 200;

/** 空 token 桶。 */
function emptyBuckets() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 路由键：JSON 编码，避免分隔符碰撞。 */
export function routeKey(provider, model) {
  return JSON.stringify([provider, model]);
}

/** 解析路由键。 */
export function parseRouteKey(key) {
  const parts = JSON.parse(String(key));
  return { provider: parts[0], model: parts[1] };
}

/** 两桶相减（用于同 turn/step 的替换语义）。 */
function subtractBuckets(left, right) {
  return {
    inputTokens: left.inputTokens - right.inputTokens,
    outputTokens: left.outputTokens - right.outputTokens,
    cacheReadTokens: left.cacheReadTokens - right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens - right.cacheWriteTokens,
  };
}

/** 桶是否全为零。 */
function isZeroBuckets(buckets) {
  return (
    buckets.inputTokens === 0 &&
    buckets.outputTokens === 0 &&
    buckets.cacheReadTokens === 0 &&
    buckets.cacheWriteTokens === 0
  );
}

/**
 * 判断一个会话是不是子代理会话。
 *
 * 依据 DSH 的 `origin === 'subagent'`（见 dsh-session 的 SessionHeader）：
 * `parentSession` 单独存在**不能**说明是子代理——普通 fork 也可能保留
 * 来源会话 id，官方注释明确写了「Presence alone does not classify a
 * Session as a subagent; use `origin` for that distinction」。
 *
 * @param {object} session - 会话。
 * @returns {boolean} 是否子代理会话。
 */
export function isSubagentSession(session) {
  const header = session?.header;
  if (header !== undefined && header !== null) {
    return header.origin === "subagent";
  }
  // 没有 header 的场景（测试桩、裸对象）退回读会话自身的 origin。
  return session?.origin === "subagent";
}

/**
 * 使用情况账本。
 *
 * 全部方法同步完成：统计不能反过来影响分配时序。
 */
export class PoolStats {
  /** 路由键 → 累计数据。 */
  #routes = new Map();

  /** 累计分配次数。 */
  #assignments = 0;

  /** 累计回退父路由次数（池无可用候选或探测全失败）。 */
  #fallbacks = 0;

  /** 累计探测失败次数。 */
  #probeFailures = 0;

  /** 累计观测到的模型请求次数。 */
  #requests = 0;

  /** 累计 token 四桶。 */
  #tokens = emptyBuckets();

  /** sessionId → 会话明细。 */
  #sessions = new Map();

  /** `sessionId|turn|step` → 上一次计入的桶（用于同一步的替换语义）。 */
  #usageSlots = new Map();

  /** childId → 已分配路由（池实例会被热更新替换，释放时仍要能归因）。 */
  #childRoutes = new Map();

  /** sessionId → 该会话「下一次请求」要走的路由（`request/header` 事件给的）。 */
  #sessionRoutes = new Map();

  /** sessionId → 会话标题（`session/title` 事件给的）。 */
  #sessionTitles = new Map();

  /** 记住某个会话下一次请求的路由。 */
  rememberRoute(session, provider, model) {
    const sessionId = session?.id ?? session?.header?.id;
    if (sessionId === undefined) return;
    this.#sessionRoutes.set(sessionId, { provider, model });
  }

  /** 读某个会话记住的路由。 */
  routeOfSession(session) {
    const sessionId = session?.id ?? session?.header?.id;
    if (sessionId === undefined) return undefined;
    return this.#sessionRoutes.get(sessionId);
  }

  /**
   * 记住一个会话的标题。
   *
   * 标题来自 `session/title` 事件（`dsh-session-title` 的落盘事件）：
   * 用户改名、模型自动生成、兜底标题都会写一条，latest-wins。
   * @param {object} session - 会话。
   * @param {string} title - 标题文本。
   */
  rememberTitle(session, title) {
    const sessionId = session?.id ?? session?.header?.id;
    if (sessionId === undefined) return;
    if (typeof title !== "string" || title.length === 0) return;
    this.#sessionTitles.set(sessionId, title);
  }

  /** 读某个会话的标题。 */
  titleOfSession(session) {
    const sessionId = session?.id ?? session?.header?.id;
    if (sessionId === undefined) return undefined;
    return this.#sessionTitles.get(sessionId);
  }

  /** 取（或建）一条路由的统计项。 */
  #entry(provider, model) {
    const key = routeKey(provider, model);
    let entry = this.#routes.get(key);
    if (entry === undefined) {
      entry = {
        provider,
        model,
        assignments: 0,
        releases: 0,
        probeFailures: 0,
        requests: 0,
        tokens: emptyBuckets(),
      };
      this.#routes.set(key, entry);
    }
    return entry;
  }

  /** 记一次成功分配。 */
  recordAssignment(provider, model, childId) {
    this.#entry(provider, model).assignments += 1;
    this.#assignments += 1;
    if (childId !== undefined) this.#childRoutes.set(childId, { provider, model });
  }

  /** 记一次释放。 */
  recordRelease(provider, model, childId) {
    this.#entry(provider, model).releases += 1;
    if (childId !== undefined) this.#childRoutes.delete(childId);
  }

  /** 读某个子代理已分配的路由（池实例被热更新替换后仍要能归因释放）。 */
  routeOfChild(childId) {
    return this.#childRoutes.get(childId);
  }

  /** 记一次探测失败。 */
  recordProbeFailure(provider, model) {
    this.#entry(provider, model).probeFailures += 1;
    this.#probeFailures += 1;
  }

  /** 记一次回退父路由。 */
  recordFallback() {
    this.#fallbacks += 1;
  }

  /**
   * 记一次模型请求的 token 用量。
   *
   * `usage` 是 DSH 的 `TokenUsage`：`inputTokens` 是未缓存输入，
   * `cacheReadTokens`/`cacheWriteTokens` 可缺省。
   * @param {string} provider - provider 名。
   * @param {string} model - model 名。
   * @param {object} usage - 用量记录。
   */
  recordUsage(provider, model, usage) {
    if (usage === null || typeof usage !== "object") return;
    const entry = this.#entry(provider, model);
    entry.requests += 1;
    this.#requests += 1;
    const add = (bucket, value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
      entry.tokens[bucket] += value;
      this.#tokens[bucket] += value;
    };
    add("inputTokens", usage.inputTokens);
    add("outputTokens", usage.outputTokens);
    add("cacheReadTokens", usage.cacheReadTokens);
    add("cacheWriteTokens", usage.cacheWriteTokens);
  }

  /**
   * 记一次带会话归属的模型请求。
   *
   * 与 {@link PoolStats#recordUsage} 的差别是额外归属到会话，并实现
   * 「同 turn/step 替换」语义：DSH 对同一个 turn/step 可能结算多次
   * （重试、max-tokens 续写），重复累计会让 token 虚高。
   *
   * **只统计子代理会话**：本插件管的是「子代理模型池」，主代理走自己的
   * 路由，与池无关。若把主代理的消耗也算进来，池的 token 会被主会话的
   * 量级淹没（实测主代理占 93.8%），看不出池本身跑了多少。
   * 判定依据是 DSH 的 `origin === 'subagent'`（见 dsh-session 的
   * SessionHeader：`parentSession` 单独存在不说明是子代理，普通 fork 也有）。
   *
   * @param {object} session - 事件所属会话（读 header 判定主/子代理）。
   * @param {string} provider - provider 名。
   * @param {string} model - model 名。
   * @param {{turn?: number, step?: number}} position - turn/step 序号。
   * @param {object} usage - 用量记录。
   * @param {number} now - 记账时刻（毫秒时间戳）。
   */
  recordSessionUsage(session, provider, model, position, usage, now) {
    if (usage === null || typeof usage !== "object") return;
    const sessionId = session?.id ?? session?.header?.id;
    if (sessionId === undefined) return;
    // 主代理会话不进池的账。
    if (!isSubagentSession(session)) return;
    const buckets = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    };
    const slotKey = `${sessionId}|${position?.turn ?? 0}|${position?.step ?? 0}`;
    const previous = this.#usageSlots.get(slotKey);
    const delta = previous === undefined ? buckets : subtractBuckets(buckets, previous);
    this.#usageSlots.set(slotKey, buckets);
    if (isZeroBuckets(delta)) {
      // 桶没变也要更新活跃度，但不必重复计入总量。
      this.#touchSession(session, now);
      return;
    }
    this.#entry(provider, model).requests += 1;
    this.#requests += 1;
    for (const bucket of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      const value = delta[bucket];
      if (!Number.isFinite(value) || value <= 0) continue;
      this.#entry(provider, model).tokens[bucket] += value;
      this.#tokens[bucket] += value;
    }
    const detail = this.#touchSession(session, now);
    detail.requests += 1;
    for (const bucket of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      const value = delta[bucket];
      if (!Number.isFinite(value) || value <= 0) continue;
      detail.tokens[bucket] += value;
    }
    const key = routeKey(provider, model);
    let route = detail.routes.get(key);
    if (route === undefined) {
      route = { provider, model, requests: 0, tokens: emptyBuckets() };
      detail.routes.set(key, route);
    }
    route.requests += 1;
    for (const bucket of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
      const value = delta[bucket];
      if (!Number.isFinite(value) || value <= 0) continue;
      route.tokens[bucket] += value;
    }
  }

  /**
   * 清掉一个 turn/step 的替换槽。
   *
   * DSH 在重试开始时发 `llm/retry-started`（见 dsh-token-meter 的同名
   * 投影）：上一次结算的桶要作废，下一次结算才是最终值。
   * @param {object} session - 事件所属会话。
   * @param {{turn?: number, step?: number}} position - turn/step 序号。
   */
  invalidateUsageSlot(session, position) {
    const sessionId = session?.id ?? session?.header?.id;
    if (sessionId === undefined) return;
    this.#usageSlots.delete(`${sessionId}|${position?.turn ?? 0}|${position?.step ?? 0}`);
  }

  /**
   * 取（或建）一个会话的明细。
   * @param {object} session - 会话。
   * @param {number} now - 记账时刻。
   * @returns {object} 会话明细。
   */
  #touchSession(session, now) {
    const sessionId = session?.id ?? session?.header?.id;
    const header = session?.header ?? {};
    let detail = this.#sessions.get(sessionId);
    if (detail === undefined) {
      detail = {
        sessionId,
        parentSessionId: header.parentSession,
        origin: header.origin,
        cwd: header.cwd,
        isSubagent: isSubagentSession(session),
        requests: 0,
        tokens: emptyBuckets(),
        routes: new Map(),
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.#sessions.set(sessionId, detail);
    }
    detail.lastSeenAt = now;
    this.#evictSessions();
    return detail;
  }

  /** 超出上限时淘汰最久未更新的会话。 */
  #evictSessions() {
    if (this.#sessions.size <= MAX_TRACKED_SESSIONS) return;
    const entries = [...this.#sessions.entries()].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt);
    for (const [id] of entries) {
      if (this.#sessions.size <= MAX_TRACKED_SESSIONS) break;
      this.#sessions.delete(id);
    }
  }

  /**
   * 汇总快照。
   *
   * `live` 由调用方按池的实时占用填入——账本自己不知道当下谁占着。
   * @param {Array<{provider: string, model: string, active: number, maxConcurrent: number, weight: number}>} [live] - 池的实时状态。
   * @returns {object} 快照。
   */
  snapshot(live = []) {
    const activeByKey = new Map();
    for (const item of live) {
      activeByKey.set(routeKey(item.provider, item.model), {
        active: item.active,
        maxConcurrent: item.maxConcurrent,
        weight: item.weight,
      });
    }
    const routes = [...this.#routes.values()].map((entry) => {
      const liveState = activeByKey.get(routeKey(entry.provider, entry.model));
      return {
        provider: entry.provider,
        model: entry.model,
        assignments: entry.assignments,
        releases: entry.releases,
        probeFailures: entry.probeFailures,
        requests: entry.requests,
        tokens: { ...entry.tokens },
        totalTokens:
          entry.tokens.inputTokens +
          entry.tokens.outputTokens +
          entry.tokens.cacheReadTokens +
          entry.tokens.cacheWriteTokens,
        active: liveState?.active ?? 0,
        maxConcurrent: liveState?.maxConcurrent ?? 0,
        weight: liveState?.weight ?? 1,
        // 是否是池内候选：池外的路由（主代理自己的模型）不该出现在「池占用」里。
        inPool: liveState !== undefined,
      };
    });
    // 未被分配过的候选也要出现（否则用户看不到池里空转的模型）。
    for (const [key, liveState] of activeByKey) {
      if (this.#routes.has(key)) continue;
      const parsed = parseRouteKey(key);
      routes.push({
        provider: parsed.provider,
        model: parsed.model,
        assignments: 0,
        releases: 0,
        probeFailures: 0,
        requests: 0,
        tokens: { ...emptyBuckets() },
        totalTokens: 0,
        active: liveState.active,
        maxConcurrent: liveState.maxConcurrent,
        weight: liveState.weight,
        inPool: true,
      });
    }
    routes.sort(
      (left, right) =>
        right.assignments - left.assignments ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
    );
    const totals = { ...this.#tokens };
    totals.totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    const sessions = [...this.#sessions.values()]
      .map((detail) => ({
        sessionId: detail.sessionId,
        parentSessionId: detail.parentSessionId,
        origin: detail.origin,
        cwd: detail.cwd,
        isSubagent: detail.isSubagent,
        title: this.#sessionTitles.get(detail.sessionId),
        // 父会话标题：子代理是被哪个主会话派出去的，列表里得能看出来。
        // 主代理不进账，但它的 title 照样记在 #sessionTitles 里（rememberTitle
        // 对所有会话生效，不受子代理过滤影响）。
        parentTitle:
          detail.parentSessionId === undefined
            ? undefined
            : this.#sessionTitles.get(detail.parentSessionId),
        requests: detail.requests,
        tokens: { ...detail.tokens },
        totalTokens:
          detail.tokens.inputTokens +
          detail.tokens.outputTokens +
          detail.tokens.cacheReadTokens +
          detail.tokens.cacheWriteTokens,
        routes: [...detail.routes.values()].map((route) => ({
          provider: route.provider,
          model: route.model,
          requests: route.requests,
          tokens: { ...route.tokens },
          totalTokens:
            route.tokens.inputTokens +
            route.tokens.outputTokens +
            route.tokens.cacheReadTokens +
            route.tokens.cacheWriteTokens,
        })),
        firstSeenAt: detail.firstSeenAt,
        lastSeenAt: detail.lastSeenAt,
      }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    return {
      routes,
      totals: {
        assignments: this.#assignments,
        fallbacks: this.#fallbacks,
        probeFailures: this.#probeFailures,
        requests: this.#requests,
        tokens: totals,
      },
      sessions,
    };
  }
}
