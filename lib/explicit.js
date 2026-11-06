/**
 * 从子代理原始调用参数保留「显式指定模型」语义。
 *
 * `resolveChildAgentOptions()` 会把继承值与显式值合并；当显式路由恰好等于
 * 父路由时，合并后的 agent.options 无法区分两者。因此必须在合并前标记。
 *
 * `subagent` 工具与 workflow 都经过 `subagents.startActivation(spec)`；
 * 仅当 spec.request.agentOptions 原本就含 provider/model 时附加一个未知字段。
 * 该字段随 `...requested` 进入当前子代理的 options；再次派生孙代理时，
 * `resolveChildAgentOptions()` 只复制父代理的 provider/model/effort/maxTokens，
 * 不会把这个内部标记继续遗传下去。
 *
 * @module dsh-subagent-model-pool/explicit
 */

/** 只存在于当前子代理 AgentOptions 的内部标记。 */
export const EXPLICIT_OPTION_KEY = "subagentModelPoolExplicit";

/** cordis traceable 代理暴露原始服务实例的符号。 */
const CORDIS_ORIGINAL = Symbol.for("cordis.original");

/**
 * 给显式携带路由的调用打标；纯继承调用原样返回。
 * @param {object} spec - startActivation 入参。
 * @returns {object} 原对象或带内部标记的拷贝。
 */
export function stampExplicitRoute(spec) {
  const request = spec?.request;
  const agentOptions = request?.agentOptions;
  if (agentOptions === null || typeof agentOptions !== "object") return spec;
  if (agentOptions.provider === undefined && agentOptions.model === undefined) return spec;
  return {
    ...spec,
    request: {
      ...request,
      agentOptions: { ...agentOptions, [EXPLICIT_OPTION_KEY]: true },
    },
  };
}

/**
 * 判断当前子代理是否在原始调用中显式指定了路由。
 * @param {object} agent - 已创建的 Agent。
 * @returns {boolean} 是否显式指定。
 */
export function hasExplicitRoute(agent) {
  return agent?.options?.[EXPLICIT_OPTION_KEY] === true;
}

/**
 * 包装 startActivation，在父子路由合并前保留显式性。
 *
 * 安装失败返回 undefined。调用方必须据此停用池分配，不能退化成覆盖显式路由。
 *
 * @param {object} subagents - subagents 服务或其 cordis traceable 代理。
 * @returns {(() => void)|undefined} 幂等还原函数；失败时 undefined。
 */
export function patchStartActivation(subagents) {
  if (subagents === null || subagents === undefined) return undefined;
  const target = subagents[CORDIS_ORIGINAL] ?? subagents;
  const base = Object.getPrototypeOf(target)?.startActivation;
  if (typeof base !== "function" || Object.hasOwn(target, "startActivation")) return undefined;
  try {
    const wrapped = function startActivation(spec) {
      return Reflect.apply(base, this, [stampExplicitRoute(spec)]);
    };
    Object.defineProperty(target, "startActivation", {
      value: wrapped,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      if (target.startActivation === wrapped) delete target.startActivation;
    };
  } catch {
    return undefined;
  }
}
