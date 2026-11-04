/**
 * 插件入口：子代理模型池。
 *
 * 在 `agent/request` waterfall 上拦截子代理的首次模型请求，按池化策略
 * 分配一次路由，之后该子代理锁定此路由。
 *
 * 关键约束（全部经源码核实，行号见 README）：
 * - 监听必须 prepend：同一 agent 上后注册者在内层，返回会被外层覆盖。
 * - 返回值必须剥掉 `reasoningEffort`：子代理没有 installModelSelection
 *   代为剥除，保留会抛 UNSUPPORTED_REASONING_EFFORT。
 * - 选、占、记三步同步完成，中途不得 await；预检失败要回滚占用。
 * - 三态守卫：无 header → 首次分配；有 header 且等于我记录 → 放行；
 *   有 header 但不等 → 冷恢复退回了父路由，重新注入。
 *
 * @module dsh-subagent-model-pool
 */

import z from "@deepseek-ai/schemastery";
import { ModelPool, DEFAULT_MAX_CONCURRENT } from "./lib/pool.js";

/** 单次探测的超时毫秒数。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 探测请求的最大输出 token——够收到首个 chunk 即可。 */
const PROBE_MAX_TOKENS = 8;
import { STRATEGIES } from "./lib/strategy.js";
import { isPoolableSubagent, explicitRouteOf } from "./lib/identity.js";

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
 * 从 waterfall 结果里剥掉 reasoningEffort，返回只带目标路由的副本。
 *
 * 保留其余字段（maxTokens 等），只删 effort——切路由时 effort 的归属会变，
 * 内核在别处也是这么处理的（dsh-agent/lib/index.js:185 的
 * `const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort }`）。
 *
 * @param {object} resolved - `next()` 的结果。
 * @param {{provider: string, model: string}} route - 目标路由。
 * @returns {object} 新的请求配置。
 */
function withRoute(resolved, route) {
  const { reasoningEffort: _dropped, ...rest } = resolved ?? {};
  return { ...rest, provider: route.provider, model: route.model };
}

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

export function apply(ctx, config) {
  const initial = readConfig(config);
  ctx.logger?.info?.(
    `subagent-model-pool: apply 收到配置 ${JSON.stringify(initial)}（${typeof config?.get === "function" ? "volatile 引用" : "普通对象"}）`,
  );

  // 池是可变的：配置热更新时整体换掉，监听器只装一次。
  let pool = buildPool(initial);
  let active = 0;

  // in-flight 探测去重：key → Promise<boolean>。探测完成后自行移除。
  const probing = new Map();

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
    pool = buildPool(next);
    if (pool === undefined) {
      ctx.logger?.info?.("subagent-model-pool: 配置变更后池为空，停止分配");
    } else {
      active = 0;
      ctx.logger?.info?.(
        `subagent-model-pool: 配置热更新，现 ${pool.snapshot().length} 个候选，策略 ${pool.strategy}`,
      );
    }
    return pool;
  };

  // 记录本轮的 runId：subagent/start 早于首条 prompt 提交（dsh-subagent:1865 → :1460）。
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

  // 兜底释放：agent 销毁但没等到 subagent/end。与上面幂等共存。
  ctx.on("agent/disposed", ({ agent }) => {
    if (agent?.session?.header?.origin !== "subagent") return;
    pool?.release(undefined, agent.id);
  });

  /**
   * 预检候选路由是否真的可解析。
   *
   * 已失败过的路由不再重试，避免每个子代理都撞一次。
   * @param {{provider: string, model: string}} route - 待校验路由。
   * @returns {Promise<boolean>} 是否可用。
   */
  /**
   * 对候选发一条最小真实请求，验证端到端可用。
   *
   * prepareCall 会复用 agent 层该 provider 的全部配置（baseURL/凭据都在
   * adapter 内部解析，插件不经手凭据）。流式拿到首个 chunk 即判存活，
   * 不等完整回复——探测目的只是「这条路由现在能不能跑」。
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

  async function validate(route) {
    const key = `${route.provider}\u0000${route.model}`;
    if (pool === undefined) return false;
    if (pool.isValidated(key)) return true;
    if (pool.isRejected(key)) return false;
    const llm = ctx.get("llm");
    if (llm === undefined) return false;
    // 并发去重：N 个子代理同时 spawn 只对同一候选发一次探测。
    let inflight = probing.get(key);
    if (inflight === undefined) {
      inflight = probeRoute(route, llm)
        .then((ok) => {
          if (ok) pool.markValidated(key);
          return ok;
        }, (error) => {
          pool.markRejected(key);
          ctx.logger?.warn?.(
            `subagent-model-pool: ${route.provider}/${route.model} 探测失败，回退父路由：${error?.message ?? String(error)}`,
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
   * @param {string|undefined} runId - 当前 run。
   * @returns {Promise<{provider: string, model: string}|undefined>} 可用路由，或 undefined 表示回退父路由。
   */
  async function allocateValidated(childId, runId) {
    for (;;) {
      if (pool === undefined) return undefined;
      const route = pool.allocate(childId, runId);
      if (route === undefined) return undefined;
      if (await validate(route)) return route;
      pool.discard(childId, runId);
      if (pool.allRejected()) return undefined;
    }
  }

  ctx.on(
    "agent/request",
    async (payload, next) => {
      // 每轮请求前同步一次配置，设置页改完无需重启即生效。
      const pool_ = currentPool();
      if (pool_ === undefined) return next();

      const agent = payload?.agent;
      const verdict = isPoolableSubagent(agent);
      if (!verdict.ok) return next();

      const childId = agent.id;
      const persisted = agent.session?.requestHeader?.()?.config;
      const assigned = pool_.assignmentOf(childId);

      // 态二：已分配且落盘 header 与之一致 → 原样放行，不重建对象。
      if (assigned !== undefined && persisted !== undefined &&
          persisted.provider === assigned.provider && persisted.model === assigned.model) {
        return next();
      }

      // 态三：有 header 但不等我记录（冷恢复退回父路由）→ 重新注入。
      if (assigned !== undefined) {
        pool_.adopt(childId, pool_.currentRunId(childId), assigned);
        return withRoute(await next(), assigned);
      }

      // 显式指定模型的子代理不覆盖：主模型是有意为之。
      const parentId = agent.session?.header?.parentSession;
      const parent = parentId === undefined ? undefined : ctx.get("agents").get(parentId);
      if (explicitRouteOf(agent, parent) !== undefined) return next();

      // 态一：首次分配。逐候选预检，全不行才回退父路由。
      const runId = pool_.currentRunId(childId);
      const route = await allocateValidated(childId, runId);
      if (route === undefined) {
        ctx.logger?.info?.(`subagent-model-pool: 无可用候选，${childId} 回退父路由`);
        return next();
      }

      active += 1;
      ctx.logger?.info?.(
        `subagent-model-pool: ${childId} → ${route.provider}/${route.model}（活跃分配 ${active}）`,
      );
      return withRoute(await next(), route);
    },
    { prepend: true },
  );
}
