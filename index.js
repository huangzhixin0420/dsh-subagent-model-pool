/**
 * 插件入口：子代理模型池。
 *
 * 分配时机（2026-11-06 重构，适配 DSH 0.2.2 的 step preparation）
 * ---------------------------------------------------------------
 * DSH 0.2.2 在 `prepareRequest()` 里加了硬校验
 * （dsh-agent-loop/lib/index.js:1000-1001）：`agent/request` waterfall 返回的
 * provider/model/effort 必须与 step preparation 时固定的 selection 完全一致，
 * 否则抛 `use agent.model.select() before step preparation`。
 *
 * 所以本插件改在 **`agent/created`**（serial，await 完成才继续）里完成
 * 「挑候选 → 真实探测 → 占用 → `agent.model.select(route)`」。`agent/created`
 * 位于 `dsh-agent-loop/lib/index.js:1579`，早于 `initializeAgent` 返回、
 * 也早于子代理把初始 prompt 投进 inbox（dsh-subagent/lib/index.js:1460 起），
 * 满足「初始 prompt 释放前完成选择」。
 *
 * `agent/request` 上不再注册任何改模型的逻辑。
 *
 * 关键约束（全部经源码核实，行号见 README）：
 * - 无可用候选时不 select，selection 保持空 → `model.current()` 回退
 *   `agent.options`（父路由），即「回退父路由」。
 * - 显式指定 provider/model 的子代理绝不覆盖，显式性取自
 *   `subagents.startActivation()` 的原始调用参数（见 lib/explicit.js）。
 * - fork 子代理排除（它继承父对话前缀，换模型会作废 KV 缓存）。
 * - 冷恢复（source !== "startup"）不重新分配：持久化里已有路由就沿用。
 * - 选、占、记三步同步完成，中途不得 await；探测失败要回滚占用。
 *
 * @module dsh-subagent-model-pool
 */

import z from "@deepseek-ai/schemastery";
import { ModelPool, DEFAULT_MAX_CONCURRENT } from "./lib/pool.js";
import { PoolStats } from "./lib/stats.js";
import { STRATEGIES } from "./lib/strategy.js";
import { isPoolableSubagent, persistedRouteOf, sameRoute } from "./lib/identity.js";
import { hasExplicitRoute, patchStartActivation } from "./lib/explicit.js";

/** 单次探测的超时毫秒数。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 探测请求的最大输出 token——够收到首个 chunk 即可。 */
const PROBE_MAX_TOKENS = 8;

/**
 * 统计视图的取数路由（Connection 的精确 Fetch 路由）。
 *
 * 走 Connection 而不是自建 HTTP 服务：Connection 已经把
 * 「Host/Origin 围栏 + 浏览器会话鉴权」做完了
 * （dsh-client-connection/lib/index.js:742 `admit()`、
 * :777 `isTrusted()`），第三方插件自己开路由等于重写一遍鉴权。
 */
const STATS_PATH = "/api/subagent-pool.stats";

/**
 * 一条 Assistant 结算事件报告的 usage。
 *
 * `assistant/message` 直接带 `usage`；`assistant/attempt`（没有可见消息的
 * 失败/中断尝试）把 usage 藏在内嵌 stream 的最后一个 usage chunk 里
 * （dsh-token-meter/lib/types/usage-projection.js:62 `usageOf()`）。
 * @param {object} event - 会话事件。
 * @returns {object|undefined} usage 对象。
 */
function usageOfEvent(event) {
  if (event?.type === "assistant/message") return event.data?.usage;
  if (event?.type !== "assistant/attempt") return undefined;
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type !== "chunk" || record.chunk?.type !== "usage") continue;
    return record.chunk.usage;
  }
  return undefined;
}

export const name = "subagent-model-pool";
export const inject = ["llm", "agents"];

/** 单条池定义。 */
const PoolEntry = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  maxConcurrent: z.number().min(1).step(1).default(DEFAULT_MAX_CONCURRENT),
  weight: z.number().min(1).step(1).default(1),
});

// 顶层 .volatile() 是设置页可见性的开关：dsh-settings 的 describe() 用
// volatileForm(schema) 过滤命名空间（dsh-settings/lib/index.js:122-131），
// 不含 volatile 的 schema 根本不会出现在设置里。代价是 Config.validate({})
// 返回 {}——真实值由 profile 层与运行时补全，不影响功能。
export const Config = z.object({
  enabled: z.boolean().default(true),
  // 用 z.string()（不是 z.union/z.const）：设置页的字段投影与回写只支持
  // 基础类型，union 会让保存被 schema 拒绝。取值合法性由 apply() 兜底回落。
  strategy: z.string().default("fewest-active"),
  pools: z.array(PoolEntry).default([]),
}).volatile();

/**
 * 读取当前配置。
 *
 * Config 带顶层 `.volatile()`，cordis 传给 apply 的不是普通对象，而是
 * cosmokit 的 volatile 引用：`{ get(), [cosmokit.volatile.write] }`
 * （schemastery/lib/index.mjs:480 → cosmokit createVolatile）。
 * 直接读 config.pools 永远是 undefined，必须走 get()。
 * 设置页保存后，dsh-settings 通过 [write] 更新引用，get() 即返回新值。
 * @param {unknown} config - apply 收到的配置（可能是 volatile 引用或普通对象）。
 * @returns {object} 解包后的配置对象。
 */
export function readConfig(config) {
  if (config !== null && typeof config === "object" && typeof config.get === "function") {
    return config.get() ?? {};
  }
  return config ?? {};
}

/**
 * 由配置构建模型池；未启用或池为空时返回 undefined。
 * @param {object} config - 解包后的配置。
 * @returns {ModelPool|undefined} 可用的池。
 */
function buildPool(config) {
  const pools = Array.isArray(config?.pools) ? config.pools : [];
  if (config?.enabled === false || pools.length === 0) return undefined;
  const strategy = STRATEGIES.includes(config?.strategy) ? config.strategy : "fewest-active";
  return new ModelPool(pools, strategy);
}

/**
 * 配置指纹：用于侦测 volatile 引用是否被写入过新值。
 *
 * 只覆盖影响分配行为的字段，避免无关字段变化导致无谓重建。
 * @param {object} config - 解包后的配置。
 * @returns {string} 稳定的指纹串。
 */
function signatureOf(config) {
  const pools = Array.isArray(config?.pools) ? config.pools : [];
  return JSON.stringify([
    config?.enabled !== false,
    config?.strategy,
    pools.map((item) => [item?.provider, item?.model, item?.weight, item?.maxConcurrent]),
  ]);
}

/** 路由折成 `provider/model`，用于日志。 */
function routeLabel(route) {
  return `${route.provider}/${route.model}`;
}

export function apply(ctx, config) {
  const initial = readConfig(config);
  ctx.logger?.info?.(
    `subagent-model-pool: apply 收到配置 ${JSON.stringify(initial)}（${typeof config?.get === "function" ? "volatile 引用" : "普通对象"}）`,
  );

  // 池是可变的：配置热更新时整体换掉，监听器只装一次。
  let pool = buildPool(initial);

  // 使用统计账本：独立于池实例，跨配置热更新存活（池一换，历史就丢了）。
  const stats = new PoolStats();

  // 会话标题读取器：`sessionTitle` 服务可用时用它读会话日志里折叠出的
  // 最新标题；不可用时为 undefined，统计页退化成只显示会话 id。
  let titleOfSession = undefined;

  // in-flight 探测去重：key → Promise<boolean>。探测完成后自行移除。
  const probing = new Map();

  // 只有成功保留原始显式标记时才允许池分配；否则宁可全部回退父路由。
  let explicitTrackingReady = false;

  if (pool === undefined) {
    ctx.logger?.info?.("subagent-model-pool: 未启用或模型池为空，不装配分配逻辑");
  } else {
    ctx.logger?.info?.(
      `subagent-model-pool: 装配 ${pool.snapshot().length} 个候选，策略 ${pool.strategy}`,
    );
  }

  // volatile 引用的写入无法订阅，所以在每次分配前比对快照，
  // 配置变了就原地换池——设置页保存后无需重启即生效。
  let lastSignature = signatureOf(initial);
  const currentPool = () => {
    const next = readConfig(config);
    const signature = signatureOf(next);
    if (signature === lastSignature) return pool;
    lastSignature = signature;
    const previous = pool;
    pool = buildPool(next);
    if (pool === undefined) {
      ctx.logger?.info?.("subagent-model-pool: 配置变更后池为空，停止分配");
    } else {
      ctx.logger?.info?.(
        `subagent-model-pool: 配置热更新，现 ${pool.snapshot().length} 个候选，策略 ${pool.strategy}`,
      );
    }
    // 旧池的占用记录带不过来，让新池从零开始计数；已分配的子代理靠
    // selection 锁定模型，不受影响。
    void previous;
    return pool;
  };

  // ---- 显式标记拦截：subagents.startActivation ----
  //
  // 这是唯一能同时覆盖 `subagent` 工具与 `workflow` 的 `agent()` 两条创建
  // 路径的拦截点，也是唯一能拿到「原始显式参数」的地方（见 lib/explicit.js）。
  ctx.inject(["subagents"], (subagentsCtx) => {
    const subagents = subagentsCtx.get("subagents");
    const restore = patchStartActivation(subagents);
    if (restore === undefined) {
      ctx.logger?.warn?.("subagent-model-pool: 无法保留显式路由标记，安全起见停止池分配");
      return;
    }
    explicitTrackingReady = true;
    subagentsCtx.effect(() => () => {
      explicitTrackingReady = false;
      restore();
    }, "subagent-model-pool.patchStartActivation()");
  });

  // ---- 占用记账：run 生命周期 ----

  // subagent/start 晚于 agent/created（dsh-subagent/lib/index.js:1889 在
  // agents.create 返回之后才 observer.start()），把占位键迁到真实 runId。
  ctx.on("subagent/start", (identity) => {
    if (identity?.id === undefined) return;
    const pool_ = currentPool();
    if (pool_ === undefined) return;
    pool_.bindRun(identity.id, identity.runId);
  });

  // 正常释放：一轮 run 结束。
  ctx.on("subagent/end", (identity) => {
    if (identity?.id === undefined) return;
    pool?.release(identity.runId, identity.id);
    const route = stats.routeOfChild(identity.id);
    if (route !== undefined) stats.recordRelease(route.provider, route.model, identity.id);
  });

  // 兜底释放：agent 销毁但没等到 subagent/end（例如创建中途失败）。
  ctx.on("agent/disposed", ({ agent }) => {
    if (agent?.session?.header?.origin !== "subagent") return;
    pool?.releaseChild(agent.id);
    const route = stats.routeOfChild(agent.id);
    if (route !== undefined) stats.recordRelease(route.provider, route.model, agent.id);
  });

  // ---- 用量记账：session/event ----
  //
  // DSH 每条会话日志事件落盘后都发 `session/event`
  // （dsh-session/lib/types/index.d.ts:63）。主代理与子代理同进程，
  // 监听器装在无 scope tag 的插件 ctx 上即可收到全部会话。
  //
  // 记两件事：
  // 1. token 四桶 —— `assistant/message` 的 `data.usage`；
  //    `assistant/attempt`（没有可见消息的失败/中断尝试）的 usage 藏在
  //    内嵌 stream 里，取最后一个 usage chunk
  //    （dsh-token-meter/lib/types/usage-projection.js:62 `usageOf()`）。
  // 2. 这次请求实际走的 provider/model —— `request/header` 的
  //    `header.config` 是「下一次请求要用的路由」，每个 step 一条；
  //    `assistant/message` 的 `message.source` 是「这一次实际走的路由」，
  //    两者在正常路径上一致（dsh-agent-loop/lib/index.js:943）。
  //
  // `llm/retry-started` 要作废上一个 turn/step 的替换槽，与
  // dsh-token-meter 的 tokenUsage 投影同口径
  // （dsh-token-meter/lib/types/usage-projection.js:92）。
  ctx.on("session/event", (session, event) => {
    try {
      const type = event?.type;
      if (type === "llm/retry-started") {
        stats.invalidateUsageSlot(session, event.data);
        return;
      }
      if (type === "request/header") {
        // 记住这条会话「下一次请求」的路由：失败重试时没有 message.source，
        // 只能靠它归因。
        const config = event.data?.header?.config;
        if (typeof config?.provider === "string" && typeof config?.model === "string") {
          stats.rememberRoute(session, config.provider, config.model);
        }
        return;
      }
      if (type === "session/title") {
        // 会话标题：用户改名、模型自动生成、兜底标题都写一条（latest-wins）。
        stats.rememberTitle(session, event.data?.title);
        return;
      }
      if (type === "subagent/start" || type === "subagent/end") {
        // 子代理生命周期。这两个事件走 cordis 事件总线（createLifecycleEmitter），
        // 不落 session log，所以可能收不到——PoolStats 里有启发式兜底。
        const childId = event.data?.id;
        if (typeof childId === "string") {
          const now = Date.now();
          if (type === "subagent/start") stats.rememberRunStart(childId, now);
          else stats.rememberRunEnd(childId, event.data?.stopReason, now);
        }
        return;
      }
      if (type === "subagent/catalog") {
        // 子代理的名字：父会话在派发子代理时记下 `label`，值是调用方给的
        // description（「核实主会话模型池可行性」这种）。DSH 自己的子代理下拉
        // 显示的就是它，比 session/title 的提示词截断可读得多——而且子代理
        // 永远拿不到 LLM 标题（标题提供方只对无父会话的会话自动运行）。
        const label = event.data?.label;
        const childId = event.data?.childId;
        if (typeof label === "string" && typeof childId === "string") {
          stats.rememberLabel(childId, label);
        }
        return;
      }
      if (type === "assistant/message" || type === "assistant/attempt") {
        // 记账前补一次标题：插件挂载前就命名的会话也能显示标题。
        if (titleOfSession !== undefined) {
          const title = titleOfSession(session);
          if (typeof title === "string") stats.rememberTitle(session, title);
        }
      }
      if (type !== "assistant/message" && type !== "assistant/attempt") return;
      const usage = usageOfEvent(event);
      if (usage === undefined) return;
      const source = event.data?.message?.source;
      const provider = source?.provider;
      const model = source?.model;
      if (typeof provider === "string" && typeof model === "string") {
        stats.recordSessionUsage(
          session,
          provider,
          model,
          { turn: event.data?.turn, step: event.data?.step },
          usage,
          Date.now(),
        );
        return;
      }
      // 没有 message.source（失败/中断的尝试）：用会话记住的路由归因。
      const remembered = stats.routeOfSession(session);
      if (remembered === undefined) return;
      stats.recordSessionUsage(
        session,
        remembered.provider,
        remembered.model,
        { turn: event.data?.turn, step: event.data?.step },
        usage,
        Date.now(),
      );
    } catch (error) {
      ctx.logger?.warn?.(
        `subagent-model-pool: 统计记账失败：${error?.message ?? String(error)}`,
      );
    }
  });

  /**
   * 对候选发一条最小真实请求，验证端到端可用。
   *
   * prepareCall 会复用该 provider 的全部配置（baseURL/凭据都在 adapter
   * 内部解析，插件不经手凭据）。流式拿到首个 chunk 即判存活，不等完整
   * 回复——探测目的只是「这条路由现在能不能跑」。
   * @param {{provider: string, model: string}} route - 待探测路由。
   * @param {object} llm - dsh-llm 服务。
   * @returns {Promise<boolean>} 是否可用。
   */
  async function probeRoute(route, llm) {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const call = await llm.prepareCall({
      provider: route.provider,
      model: route.model,
      maxTokens: PROBE_MAX_TOKENS,
    }, signal);
    const options = {
      ...call.config,
      messages: [{ role: "user", content: "ping" }],
      purpose: "subagent-model-pool-probe",
      signal,
    };
    for await (const chunk of call.stream(options)) {
      void chunk;
      break; // 首块即存活
    }
    return true;
  }

  /**
   * 校验一条候选路由是否可用：validated 5min 内直接放行，rejected 60s 内
   * 直接拒绝，其余发一次真实探测（in-flight 去重）。
   * @param {{provider: string, model: string}} route - 待校验路由。
   * @returns {Promise<boolean>} 是否可用。
   */
  async function validate(route, pool_) {
    const key = `${route.provider}\u0000${route.model}`;
    if (pool_.isValidated(key)) return true;
    if (pool_.isRejected(key)) return false;
    const llm = ctx.get("llm");
    if (llm === undefined) return false;
    // 并发去重：N 个子代理同时 spawn 只对同一候选发一次探测。
    let inflight = probing.get(key);
    if (inflight === undefined) {
      inflight = probeRoute(route, llm)
        .then((ok) => {
          if (ok) pool_.markValidated(key);
          return ok;
        }, (error) => {
          pool_.markRejected(key);
          stats.recordProbeFailure(route.provider, route.model);
          ctx.logger?.warn?.(
            `subagent-model-pool: ${route.provider}/${route.model} 探测失败，换下一个候选：${error?.message ?? String(error)}`,
          );
          return false;
        })
        .finally(() => probing.delete(key));
      probing.set(key, inflight);
    }
    return inflight;
  }

  /**
   * 逐候选重试分配：前一个候选预检失败就换下一个，全都不行才落回父路由。
   *
   * 每个候选的占用都同步登记、失败即回滚，不会留下幽灵占用。
   * @param {string} childId - 子代理会话 id。
   * @returns {Promise<{provider: string, model: string}|undefined>} 可用路由，或 undefined 表示回退父路由。
   */
  async function allocateValidated(childId, pool_) {
    for (;;) {
      const route = pool_.allocate(childId, undefined);
      if (route === undefined) return undefined;
      if (await validate(route, pool_)) return route;
      pool_.discard(childId, undefined);
      if (pool_.allRejected()) return undefined;
    }
  }

  /**
   * `agent/created`：子代理发布后、初始 prompt 投递前确定路由。
   *
   * 顺序敏感：本监听器是 serial 且被 await（dsh-agent/lib/index.js:348），
   * 返回时 `model.select()` 已落盘，`initializeAgent` 才会返回，子代理才
   * 能投递初始 prompt。
   */
  ctx.on("agent/created", async ({ agent, source }) => {
    try {
      const pool_ = currentPool();
      if (pool_ === undefined || !explicitTrackingReady) return;

      const subagents = ctx.get("subagents");
      const verdict = isPoolableSubagent(agent, (providerName) =>
        subagents?.getProvider?.(providerName),
      );
      if (!verdict.ok) {
        if (verdict.reason === "fork") {
          ctx.logger?.info?.(`subagent-model-pool: ${agent.id} 是 fork 子代理，跳过分配`);
        }
        return;
      }

      const childId = agent.id;

      // 硬约束：显式指定的 provider/model 绝不覆盖，即使它恰好等于父路由
      // （v0.3.0 的缺陷正是把这种情形当成继承）。
      if (hasExplicitRoute(agent)) {
        ctx.logger?.info?.(
          `subagent-model-pool: ${childId} 显式指定 ${agent.options.provider}/${agent.options.model}，不覆盖`,
        );
        return;
      }

      // 冷恢复：绝不重新分配。持久化里有路由就沿用（模型锁定跨重启仍然成立）。
      if (source !== "startup") {
        const persisted = persistedRouteOf(agent.session);
        if (persisted !== undefined) {
          pool_.adopt(childId, undefined, persisted);
          const current = agent.model?.current?.();
          if (!sameRoute(current, persisted)) agent.model.select(persisted);
          ctx.logger?.info?.(
            `subagent-model-pool: ${childId} 冷恢复沿用 ${routeLabel(persisted)}，不重新分配`,
          );
        } else {
          ctx.logger?.info?.(
            `subagent-model-pool: ${childId} 冷恢复但无持久化路由（从未发过请求），保持原样不分配`,
          );
        }
        return;
      }

      // 同进程重复发布（理论上不会发生）：已有分配就沿用。
      const assigned = pool_.assignmentOf(childId);
      if (assigned !== undefined) {
        pool_.adopt(childId, undefined, assigned);
        if (!sameRoute(agent.model?.current?.(), assigned)) agent.model.select(assigned);
        return;
      }

      // 首次分配：真实探测通过的候选才用。
      const route = await allocateValidated(childId, pool_);
      if (route === undefined) {
        stats.recordFallback();
        ctx.logger?.info?.(`subagent-model-pool: 无可用候选，${childId} 回退父路由`);
        return;
      }
      try {
        agent.model.select(route);
      } catch (error) {
        pool_.discard(childId, undefined);
        throw error;
      }
      stats.recordAssignment(route.provider, route.model, childId);
      ctx.logger?.info?.(
        `subagent-model-pool: ${childId} → ${routeLabel(route)}（活跃分配 ${pool_.activeCount}）`,
      );
    } catch (error) {
      // 监听器抛错会让子代理创建失败，这里必须完全吞掉。
      ctx.logger?.warn?.(
        `subagent-model-pool: ${agent?.id ?? "<unknown>"} 分配失败，回退父路由：${error?.message ?? String(error)}`,
      );
    }
  });

  ctx.effect(() => () => {
    probing.clear();
  }, "subagent-model-pool.teardown()");

  // 会话标题：优先读 `session/title` 事件；插件挂载前就已命名的会话，
  // 靠 `sessionTitle.get(session)` 读会话日志折叠出的最新标题快照补上。
  //
  // `sessionTitle` 同样不进顶层 inject（headless 等 profile 可能没有），
  // 嵌套 inject 拿不到就退化成「只显示会话 id」。
  ctx.inject(["sessionTitle"], (titleCtx) => {
    const titleService = titleCtx.get?.("sessionTitle") ?? titleCtx.sessionTitle;
    if (titleService === undefined) {
      ctx.logger?.warn?.("subagent-model-pool: sessionTitle 服务不可用，会话明细只显示会话 id");
      return;
    }
    titleOfSession = (session) => {
      try {
        return titleService.get(session)?.title;
      } catch {
        return undefined;
      }
    };
  });

  // ---- 统计视图取数路由 ----
  //
  // 注册在 Connection 的精确 Fetch 路由表里：路径必须以 /api 开头，
  // 且只有 owner Peer 能到达（dsh-client-connection/lib/index.js:830）。
  // 浏览器侧同源 fetch 会带上会话 cookie。
  //
  // `connection` 不在顶层 inject 里：非 Web profile（headless/avb-lab）没有
  // 这个服务，顶层声明会让插件整体不挂载。改成嵌套 inject，Web 环境下
  // 自动补上，其他环境安静地不提供统计页。
  ctx.inject(["connection"], (connectionCtx) => {
    // cordis 的 `ctx.get` 对未提交的服务返回 undefined；这里再兜一层直接取属性。
    const connection = connectionCtx.get?.("connection") ?? connectionCtx.connection;
    if (connection?.fetch === undefined) {
      ctx.logger?.warn?.("subagent-model-pool: Connection 的 Fetch 路由表不可用，统计页不提供取数");
      return;
    }
    connection.fetch.register({
      path: STATS_PATH,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: () => {
        const pool_ = currentPool();
        const live = pool_?.snapshot() ?? [];
        // health：把「分配链路是否真的在工作」摊到 API 上。
        // 没有它，池分配失效时页面只会安静地显示「空闲」，看不出是没分配
        // 还是真的没人用。
        const health = {
          poolReady: pool_ !== undefined,
          explicitTrackingReady,
          activeCount: pool_?.activeCount ?? 0,
          trackedSessions: stats.snapshot().sessions.length,
        };
        return Response.json({ ...stats.snapshot(live), health }, {
          headers: { "cache-control": "no-store" },
        });
      },
    });
  });
}
