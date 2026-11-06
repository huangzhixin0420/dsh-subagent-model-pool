/**
 * 模型池的占用状态管理。
 *
 * 语义要点（2026-11-06 定稿，配合 DSH 0.2.2 的 step preparation）：
 * - `maxConcurrent` 是并发占用量，不是累计次数。
 * - 占用单位是「活跃 run」而非 childId：同一子代理被冷恢复会开新 run，
 *   用 childId 去重会把第二轮 resume 的释放吃掉，导致名额泄漏。
 * - 分配发生在 `agent/created`，那时 `subagent/start` 还没发、runId 未知，
 *   所以先用 `child:<id>` 占位键登记；`subagent/start` 到达后由
 *   {@link ModelPool#bindRun} 把占位迁到真实 runId。
 * - 释放由 `subagent/end` 驱动，按 runId 幂等；`agent/disposed` 兜底清全部。
 * - `assignments` 是 childId → 路由的永久记录（进程生命周期内），保证
 *   「同一子代理被派发后模型不再变」。
 *
 * @module dsh-subagent-model-pool/pool
 */

import { selectCandidate } from "./strategy.js";

/** 默认并发上限。 */
export const DEFAULT_MAX_CONCURRENT = 3;

/** 探测通过后的有效期：过期后派发前重新探测（防「验证过但渠道后来挂了」）。 */
export const VALIDATED_TTL_MS = 5 * 60 * 1000;

/** 探测失败后的拉黑时长：到期自动重探，恢复即回池（替代进程内永久拉黑）。 */
export const REJECTED_TTL_MS = 60 * 1000;

/** 把路由折成稳定键。 */
function routeKey(provider, model) {
  return `${provider}\u0000${model}`;
}

/** 未绑定 runId 时使用的占位占用键。 */
function placeholderKey(childId) {
  return `child:${childId}`;
}

/**
 * 运行期模型池。
 *
 * 所有变更方法都是同步的：选、占、记必须在同一个同步块内完成，否则
 * workflow 并发 fan out 时会超发。
 */
export class ModelPool {
  /** 池定义，按配置顺序。 */
  #pools = [];

  /** childId → 已分配路由。进程生命周期内不变。 */
  #assignments = new Map();

  /** 占用键（runId 或 `child:<id>` 占位）→ 池下标。按占用键幂等。 */
  #occupancy = new Map();

  /** childId → 当前活跃 runId。 */
  #currentRun = new Map();

  /** childId → 该 child 名下所有占用键，供兜底释放。 */
  #keysOfChild = new Map();

  /** 预检通过的键 → 通过时刻。TTL 内视为可用，过期重新探测。 */
  #validated = new Map();

  /** 预检失败的键 → 失败时刻。TTL 内跳过，到期自动重探。 */
  #rejected = new Map();

  /** 单调递增序号，供策略比较释放先后。 */
  #tick = 0;

  /**
   * @param {Array<{provider: string, model: string, weight?: number, maxConcurrent?: number}>} pools - 池定义。
   * @param {string} strategy - 选择策略。
   */
  constructor(pools, strategy) {
    this.strategy = strategy;
    this.#pools = pools.map((entry, index) => {
      const weight = entry.weight;
      return {
        index,
        provider: entry.provider,
        model: entry.model,
        maxConcurrent: entry.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        // 权重：比例策略下是期望占用占比；主备策略下是优先级。缺省/非法回落 1。
        weight: typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 1,
        active: 0,
        lastReleasedAt: undefined,
      };
    });
  }

  /** 池状态快照，供诊断与设置页读取。 */
  snapshot() {
    return this.#pools.map((pool) => ({
      provider: pool.provider,
      model: pool.model,
      weight: pool.weight,
      maxConcurrent: pool.maxConcurrent,
      active: pool.active,
      lastReleasedAt: pool.lastReleasedAt,
    }));
  }

  /** 当前总占用。 */
  get activeCount() {
    return this.#pools.reduce((sum, pool) => sum + pool.active, 0);
  }

  /** 读某个子代理已分配的路由。 */
  assignmentOf(childId) {
    return this.#assignments.get(childId);
  }

  /** 读某个子代理当前活跃的 runId。 */
  currentRunId(childId) {
    return this.#currentRun.get(childId);
  }

  /**
   * 把一个占位占用迁移到真实 runId。
   *
   * `agent/created` 阶段 runId 还不存在，只能先用 `child:<id>` 占位；
   * `subagent/start` 到达时调用本方法迁移，保证并发计数不重复。
   * @param {string} childId - 子代理会话 id。
   * @param {string|undefined} runId - 新 run 的 id。
   */
  bindRun(childId, runId) {
    if (runId === undefined) return;
    const placeholder = placeholderKey(childId);
    const poolIndex = this.#occupancy.get(placeholder);
    if (poolIndex !== undefined && !this.#occupancy.has(runId)) {
      this.#occupancy.delete(placeholder);
      this.#occupancy.set(runId, poolIndex);
      const keys = this.#keysOfChild.get(childId);
      if (keys !== undefined) {
        keys.delete(placeholder);
        keys.add(runId);
      }
    }
    this.#currentRun.set(childId, runId);
  }

  /**
   * 为一个尚未分配的子代理挑路由并占用一个名额。
   *
   * 同步完成选择、占用与记录三步，中途不得 await。
   * @param {string} childId - 子代理会话 id。
   * @param {string|undefined} runId - 当前 run（created 阶段通常 undefined）。
   * @returns {{provider: string, model: string}|undefined} 选中路由；无空闲名额时 undefined。
   */
  allocate(childId, runId) {
    const existing = this.#assignments.get(childId);
    if (existing !== undefined) {
      this.#occupy(childId, runId, routeKey(existing.provider, existing.model));
      return existing;
    }
    const candidates = this.#pools.filter(
      (pool) =>
        pool.active < pool.maxConcurrent &&
        !this.isRejected(routeKey(pool.provider, pool.model)),
    );
    const picked = selectCandidate(this.strategy, candidates);
    if (picked === undefined) return undefined;
    const route = { provider: picked.provider, model: picked.model };
    this.#assignments.set(childId, route);
    this.#occupy(childId, runId, routeKey(route.provider, route.model));
    return route;
  }

  /**
   * 为一个已分配的子代理登记占用（冷恢复、或沿用持久化路由）。
   *
   * 一致性优先于名额：已分配的子代理即使目标池当前已满也保持原模型，
   * 因为「被派发后模型不再变」是硬承诺。
   * @param {string} childId - 子代理会话 id。
   * @param {string|undefined} runId - 当前 run。
   * @param {{provider: string, model: string}} route - 已分配路由。
   */
  adopt(childId, runId, route) {
    this.#assignments.set(childId, route);
    this.#occupy(childId, runId, routeKey(route.provider, route.model));
  }

  /** 内部：把某个占用键记到一个池上，按占用键幂等。 */
  #occupy(childId, runId, key) {
    const pool = this.#pools.find((entry) => routeKey(entry.provider, entry.model) === key);
    if (pool === undefined) return;
    const occupancyKey = runId ?? placeholderKey(childId);
    if (this.#occupancy.has(occupancyKey)) return;
    this.#occupancy.set(occupancyKey, pool.index);
    pool.active += 1;
    const keys = this.#keysOfChild.get(childId) ?? new Set();
    keys.add(occupancyKey);
    this.#keysOfChild.set(childId, keys);
    if (runId !== undefined) this.#currentRun.set(childId, runId);
  }

  /** 内部：释放一个占用键。 */
  #releaseKey(key) {
    const poolIndex = this.#occupancy.get(key);
    if (poolIndex === undefined) return false;
    this.#occupancy.delete(key);
    const pool = this.#pools[poolIndex];
    if (pool !== undefined && pool.active > 0) {
      pool.active -= 1;
      pool.lastReleasedAt = ++this.#tick;
    }
    return true;
  }

  /**
   * 释放一个 run 的占用。按 runId 幂等，重复调用不重复减。
   * @param {string|undefined} runId - 结束的 run。
   * @param {string|undefined} childId - 兜底键。
   * @returns {boolean} 是否真的减了。
   */
  release(runId, childId) {
    const keys = [];
    if (runId !== undefined) keys.push(runId);
    if (childId !== undefined) keys.push(placeholderKey(childId));
    let released = false;
    for (const key of keys) {
      if (this.#releaseKey(key)) released = true;
      if (childId !== undefined) this.#keysOfChild.get(childId)?.delete(key);
    }
    if (runId !== undefined && childId !== undefined && this.#currentRun.get(childId) === runId) {
      this.#currentRun.delete(childId);
    }
    return released;
  }

  /**
   * 兜底释放某个 child 名下的全部占用（agent 被销毁但没等到 `subagent/end`）。
   * @param {string} childId - 子代理会话 id。
   * @returns {boolean} 是否真的减了。
   */
  releaseChild(childId) {
    const keys = this.#keysOfChild.get(childId);
    let released = false;
    if (keys !== undefined) {
      for (const key of [...keys]) if (this.#releaseKey(key)) released = true;
      this.#keysOfChild.delete(childId);
    }
    this.#currentRun.delete(childId);
    return released;
  }

  /**
   * 丢弃一次尚未兑现的分配（预检失败路径）。
   *
   * 回滚占用与 assignment，不触碰其他 run。
   * @param {string} childId - 子代理会话 id。
   * @param {string|undefined} runId - 占用的 run。
   */
  discard(childId, runId) {
    this.#assignments.delete(childId);
    this.release(runId, childId);
    this.releaseChild(childId);
  }

  /**
   * 该键是否在探测有效期内。
   *
   * 探测通过超过 {@link VALIDATED_TTL_MS} 后返回 false，下次派发前会重新探测。
   * @param {string} key - `provider\0model` 键。
   * @returns {boolean} 是否视为可用。
   */
  isValidated(key) {
    const at = this.#validated.get(key);
    return at !== undefined && Date.now() - at < VALIDATED_TTL_MS;
  }

  /**
   * 该键是否仍在探测失败的拉黑期内。
   *
   * 失败超过 {@link REJECTED_TTL_MS} 后返回 false——候选恢复可重探，
   * 上游恢复后自动回池，不再需要重启进程。
   * @param {string} key - `provider\0model` 键。
   * @returns {boolean} 是否仍被拉黑。
   */
  isRejected(key) {
    const at = this.#rejected.get(key);
    return at !== undefined && Date.now() - at < REJECTED_TTL_MS;
  }

  /** 记录一次探测通过。 */
  markValidated(key) {
    this.#validated.set(key, Date.now());
    this.#rejected.delete(key);
  }

  /** 记录一次探测失败。 */
  markRejected(key) {
    this.#rejected.set(key, Date.now());
    this.#validated.delete(key);
  }

  /** 该路由是否属于池内候选（用于判断冷恢复的持久化路由是否可沿用）。 */
  hasRoute(route) {
    if (route === undefined) return false;
    const key = routeKey(route.provider, route.model);
    return this.#pools.some((pool) => routeKey(pool.provider, pool.model) === key);
  }

  /** 是否所有候选都在探测失败的拉黑期内（或池为空）。过期的候选不算。 */
  allRejected() {
    if (this.#pools.length === 0) return true;
    return this.#pools.every((pool) => this.isRejected(routeKey(pool.provider, pool.model)));
  }
}
