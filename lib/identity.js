/**
 * 子代理识别：判断某个 agent 是否是「应被池化的子代理」，以及它的路由现状。
 *
 * 三条硬判据（缺一不可，判错会否决主会话的模型切换）：
 * 1. `header.origin === "subagent"`
 * 2. `header.parentSession !== undefined`
 * 3. 自有事件里有 `subagent/descriptor`，且其 provider 不是 fork 类后端
 *
 * fork 的排除优先级最高：它继承父对话前缀，换模型会作废 KV 缓存。
 * fork 判定不靠 provider 名字硬编码，而是读 provider 的
 * `inheritsParentContext`（dsh-subagent-fork-in-process/lib/index.js:37），
 * 名字判定只作兜底。
 *
 * **这里刻意不再提供「显式指定」判定。** v0.3.0 的 `explicitRouteOf()`
 * 用「agent.options 与父路由不同」冒充显式，缺陷是：显式指定了与父相同的
 * 路由会被当成继承而覆盖（本版修复）。`agent.options` 由
 * `resolveChildAgentOptions()`（dsh-subagent/lib/index.js:309-331）产出，
 * 继承与显式两条路径的产物完全相同，**任何基于它的比较都无法区分两者**。
 * 显式性改由 `lib/explicit.js` 在 `subagents.startActivation()` 的调用参数
 * 上取原始标记。
 *
 * @module dsh-subagent-model-pool/identity
 */

/** fork 后端的默认 provider 名（provider 元数据不可读时的兜底判据）。 */
export const FORK_PROVIDER_NAME = "fork";

/**
 * 读该 Session 自有（非 fork 继承）的事件。
 *
 * 继承前缀属于父对话，里面的 descriptor/selection 不是这个子代理的。
 * @param {object} session - 目标 Session。
 * @returns {Array<object>} 自有事件数组；读不到时返回空数组。
 */
export function ownEvents(session) {
  try {
    const from = session?.inheritedEventCount ?? 0;
    return session?.snapshotEvents?.(from) ?? [];
  } catch {
    // 读不到就当作「无自有事件」，由调用方按不可判定处理。
    return [];
  }
}

/**
 * 取该子代理的 descriptor（只认第一条，与内核 fold 规则一致）。
 *
 * descriptor 由 provider 在 `setup` 内 append，早于 `agent/created`
 * （dsh-subagent/lib/index.js:1806 与 dsh-agent-loop/lib/index.js:1574-1579），
 * 所以 created 时一定能读到。
 * @param {object} session - 目标 Session。
 * @returns {object|undefined} descriptor 数据，或 undefined。
 */
export function descriptorOf(session) {
  for (const event of ownEvents(session)) {
    if (event?.type === "subagent/descriptor") return event.data;
  }
  return undefined;
}

/**
 * 判断 descriptor 是否来自「继承父上下文」的后端（fork 类）。
 * @param {object|undefined} descriptor - 子代理 descriptor。
 * @param {(name: string) => object|undefined} [lookupProvider] - provider 元数据查询。
 * @returns {boolean} 是否应排除。
 */
export function isForkDescriptor(descriptor, lookupProvider) {
  if (descriptor === undefined) return false;
  if (descriptor.provider === FORK_PROVIDER_NAME) return true;
  const provider = lookupProvider?.(descriptor.provider);
  // fork 后端独占 inheritsParentContext；换模型会让它继承的前缀失效。
  return provider?.inheritsParentContext === true;
}

/**
 * 判断该 agent 是否应参与模型池分配。
 *
 * @param {object} agent - 候选 agent。
 * @param {(name: string) => object|undefined} [lookupProvider] - provider 元数据查询。
 * @returns {{ok: boolean, reason?: string, descriptor?: object}} 判定结果，reason 用于诊断日志。
 */
export function isPoolableSubagent(agent, lookupProvider) {
  const header = agent?.session?.header;
  if (header === undefined) return { ok: false, reason: "no-header" };
  if (header.origin !== "subagent") return { ok: false, reason: "not-subagent" };
  if (header.parentSession === undefined) return { ok: false, reason: "no-parent" };
  const descriptor = descriptorOf(agent.session);
  // 没有 descriptor 的子会话无法安全归类（可能是别的 provider 的历史格式）。
  if (descriptor === undefined) return { ok: false, reason: "no-descriptor" };
  if (isForkDescriptor(descriptor, lookupProvider)) return { ok: false, reason: "fork" };
  return { ok: true, descriptor };
}

/** 路由是否形状完整。 */
function isRoute(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0
  );
}

/** 只保留 provider/model，剥掉 effort 等其余字段。 */
function asRoute(value) {
  return { provider: value.provider, model: value.model };
}

/**
 * 读该子代理「当前实际在用的路由」。
 *
 * 冷恢复时用它决定是否沿用既有模型：已落盘的 `request/header` 最权威
 * （真实发过的请求），其次才是尚未消费的 `model/selection`。两者都没有
 * 说明这个子代理从未发过请求，交给调用方按「不可判定」处理。
 *
 * @param {object} session - 目标 Session。
 * @returns {{provider: string, model: string}|undefined} 路由，或 undefined。
 */
export function persistedRouteOf(session) {
  try {
    const config = session?.requestHeader?.()?.config;
    if (isRoute(config)) return asRoute(config);
  } catch {
    // 读不到 header 就退到 selection。
  }
  let selection;
  for (const event of ownEvents(session)) {
    if (event?.type === "model/selection") selection = event.data;
  }
  return isRoute(selection) ? asRoute(selection) : undefined;
}

/**
 * 两条路由是否完全相同。
 * @param {{provider: string, model: string}|undefined} left - 路由。
 * @param {{provider: string, model: string}|undefined} right - 路由。
 * @returns {boolean} 是否相同。
 */
export function sameRoute(left, right) {
  if (left === undefined || right === undefined) return false;
  return left.provider === right.provider && left.model === right.model;
}
