/**
 * 模型池选择策略。
 *
 * 纯函数，不依赖 cordis 运行时，便于单测。
 * @module dsh-subagent-model-pool/strategy
 */

/** 支持的策略名。 */
export const STRATEGIES = ["least-recently-used", "fewest-active"];

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
 * 「占用数最少」：优先选当前活跃占用数最少的；平手时比较最近释放时间，再平手按下标。
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
    if (candidate.active < best.active) {
      best = candidate;
      continue;
    }
    if (candidate.active > best.active) continue;
    const a = candidate.lastReleasedAt;
    const b = best.lastReleasedAt;
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
 * 按策略从有空闲名额的候选里挑一个。
 * @param {string} strategy - STRATEGIES 中的一项。
 * @param {Array} candidates - 已过滤出有空闲名额的候选；每项含 {index, provider, model, active, lastReleasedAt}。
 * @returns {object|undefined} 选中的候选；无候选时 undefined。
 */
export function selectCandidate(strategy, candidates) {
  if (candidates.length === 0) return undefined;
  if (strategy === "least-recently-used") return leastRecentlyUsed(candidates);
  return fewestActive(candidates);
}
