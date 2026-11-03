/**
 * 子代理识别：判断某个 agent 是否是「应被池化的子代理」。
 *
 * 三条硬判据（缺一不可，判错会否决主会话的模型切换）：
 * 1. `header.origin === "subagent"`
 * 2. `header.parentSession !== undefined`
 * 3. 不是 fork 子代理
 *
 * fork 的排除优先级最高：它继承父对话前缀，换模型会作废 KV 缓存。
 *
 * @module dsh-subagent-model-pool/identity
 */

/**
 * 从子代理会话的 descriptor 事件里读 provider。
 *
 * descriptor 只在 `create` 时 append；fork 走 `resume` 不追加新 descriptor，
 * 所以读不到时不能断言「不是 fork」——需要看父路由是否被继承。
 * @param {object} session - 子代理 Session。
 * @returns {string|undefined} descriptor 的 provider，或 undefined。
 */
export function descriptorProvider(session) {
  try {
    const events = session.snapshotEvents?.() ?? [];
    for (const event of events) {
      if (event?.type === "subagent/descriptor") {
        const provider = event.data?.provider;
        if (typeof provider === "string") return provider;
      }
    }
  } catch {
    // 读不到就当作未知，交给后续判据决定。
  }
  return undefined;
}

/**
 * 判断该 agent 是否应参与模型池分配。
 *
 * @param {object} agent - 候选 agent。
 * @returns {{ok: boolean, reason?: string}} 判定结果，reason 用于诊断日志。
 */
export function isPoolableSubagent(agent) {
  const header = agent?.session?.header;
  if (header === undefined) return { ok: false, reason: "no-header" };
  if (header.origin !== "subagent") return { ok: false, reason: "not-subagent" };
  if (header.parentSession === undefined) return { ok: false, reason: "no-parent" };
  if (descriptorProvider(agent.session) === "fork") return { ok: false, reason: "fork" };
  return { ok: true };
}

/**
 * 读该子代理「显式指定」的模型。
 *
 * 只有在它和父会话当前路由**不同**时才算显式——descriptor 的 agentModel
 * 恒有值（含继承自父的路由），不能直接拿来判断。
 *
 * @param {object} agent - 子代理。
 * @param {object|undefined} parent - 父 agent。
 * @returns {{provider: string, model: string}|undefined} 显式路由，或 undefined 表示继承父。
 */
export function explicitRouteOf(agent, parent) {
  const options = agent?.options;
  if (options?.provider === undefined || options?.model === undefined) return undefined;
  const parentConfig = parent?.session?.requestHeader?.()?.config;
  const parentProvider = parentConfig?.provider ?? parent?.options?.provider;
  const parentModel = parentConfig?.model ?? parent?.options?.model;
  if (options.provider === parentProvider && options.model === parentModel) return undefined;
  return { provider: options.provider, model: options.model };
}
