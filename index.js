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
import { STRATEGIES } from "./lib/strategy.js";
import { isPoolableSubagent, persistedRouteOf, sameRoute } from "./lib/identity.js";
import { hasExplicitRoute, patchStartActivation } from "./lib/explicit.js";

/** 单次探测的超时毫秒数。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 探测请求的最大输出 token——够收到首个 chunk 即可。 */
const PROBE_MAX_TOKENS = 8;

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
  });

  // 兜底释放：agent 销毁但没等到 subagent/end（例如创建中途失败）。
  ctx.on("agent/disposed", ({ agent }) => {
    if (agent?.session?.header?.origin !== "subagent") return;
    pool?.releaseChild(agent.id);
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
        ctx.logger?.info?.(`subagent-model-pool: 无可用候选，${childId} 回退父路由`);
        return;
      }
      try {
        agent.model.select(route);
      } catch (error) {
        pool_.discard(childId, undefined);
        throw error;
      }
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
}
