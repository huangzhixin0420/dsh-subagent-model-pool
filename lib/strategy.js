/**
 * 模型池选择策略。
 *
 * 纯函数，不依赖 cordis 运行时，便于单测。
 * @module dsh-subagent-model-pool/strategy
 */

/** 支持的策略名。 */
export const STRATEGIES = ["least-recently-used", "fewest-active", "strict-priority"];

/**
 * 读候选权重；缺省/非法一律回落 1（与无权重时代的行为一致）。
 * @param {object} candidate - 候选。
 * @returns {number} 大于 0 的权重。
 */
function weightOf(candidate) {
  const weight = candidate?.weight;
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * 稳定 tiebreak：按候选在配置数组中的原始下标升序。
 * 并发首次派发时所有候选的空闲度相等，必须靠它避免随机打散。
 * @param {Array<{provider: string, model: string}>} candidates - 过滤后的候选。
 * @returns {Array} 按下标升序排好的副本。
 */
function byConfigOrder(candidates) {
  return [...candidates].sort((a, b) => a.index - b.index);
}

/**
 * 「最久未被使用」：优先选从未被使用过的，其次选最近一次释放最早的那个。
 * 释放时间用「最后一次占用结束的序号」表达；正在占用中的候选已被调用方过滤。
 * @param {Array} candidates - 有空闲名额的候选。
 * @returns {object|undefined} 选中的候选。
 */
function leastRecentlyUsed(candidates) {
  const ordered = byConfigOrder(candidates);
  let best;
  for (const candidate of ordered) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const a = candidate.lastReleasedAt;
    const b = best.lastReleasedAt;
    // 从未释放过（undefined）的最优先——它从未被占用。
    if (a === undefined && b !== undefined) {
      best = candidate;
      continue;
    }
    if (a === undefined || b === undefined) continue;
    if (a < b) best = candidate;
  }
  return best;
}

/**
 * 「占用数最少」：优先选 `活跃占用 / 权重` 比值最小的；平手时比较最近释放时间，再平手按下标。
 *
 * 权重解读为「稳态并发占用的期望比例」：weight=8:2 时长期占用约 80%:20%。
 * 全部 weight=1 时退化为纯粹的占用数比较——与无权重时代行为一致。
 * @param {Array} candidates - 有空闲名额的候选。
 * @returns {object|undefined} 选中的候选。
 */
function fewestActive(candidates) {
  const ordered = byConfigOrder(candidates);
  let best;
  for (const candidate of ordered) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const a = candidate.active / weightOf(candidate);
    const b = best.active / weightOf(best);
    if (a < b) {
      best = candidate;
      continue;
    }
    if (a > b) continue;
    const ra = candidate.lastReleasedAt;
    const rb = best.lastReleasedAt;
    if (ra === undefined && rb !== undefined) {
      best = candidate;
      continue;
    }
    if (ra === undefined || rb === undefined) continue;
    if (ra < rb) best = candidate;
  }
  return best;
}

/**
 * 「严格主备」：按权重从大到小排（相同按配置序），取第一个有空闲名额的。
 *
 * 权重解读为优先级：高权重候选未满自己的 maxConcurrent 时绝不轮到低权重。
 * 「用完」= 并发占满（瞬时状态），与历史累计派发次数无关；高优先级释放后
 * 新派发即回到它，已落低优先级的存量 run 不迁移（分配锁定由池层保证）。
 * @param {Array} candidates - 有空闲名额的候选。
 * @returns {object|undefined} 选中的候选。
 */
function strictPriority(candidates) {
  const ordered = [...candidates].sort((a, b) => {
    const diff = weightOf(b) - weightOf(a);
    return diff !== 0 ? diff : a.index - b.index;
  });
  return ordered[0];
}

/**
 * 按策略从有空闲名额的候选里挑一个。
 * @param {string} strategy - STRATEGIES 中的一项。
 * @param {Array} candidates - 已过滤出有空闲名额的候选；每项含 {index, provider, model, weight, active, lastReleasedAt}。
 * @returns {object|undefined} 选中的候选；无候选时 undefined。
 */
export function selectCandidate(strategy, candidates) {
  if (candidates.length === 0) return undefined;
  if (strategy === "least-recently-used") return leastRecentlyUsed(candidates);
  if (strategy === "strict-priority") return strictPriority(candidates);
  return fewestActive(candidates);
}
