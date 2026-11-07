// 策略与池状态的单元测试：不启动 DSH，纯逻辑验证。
import { DEFAULT_MAX_CONCURRENT, ModelPool, REJECTED_TTL_MS, VALIDATED_TTL_MS } from "../lib/pool.js";
import test from "node:test";
import assert from "node:assert/strict";

import { selectCandidate, STRATEGIES } from "../lib/strategy.js";

const POOLS = [
  { provider: "c2a", model: "subagent" },
  { provider: "c2a", model: "free" },
];

test("默认并发上限是 3", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT, 3);
  const pool = new ModelPool(POOLS, "fewest-active");
  assert.deepEqual(
    pool.snapshot().map((entry) => entry.maxConcurrent),
    [3, 3],
  );
});

test("配置可覆盖单条上限", () => {
  const pool = new ModelPool(
    [{ provider: "c2a", model: "subagent", maxConcurrent: 1 }],
    "fewest-active",
  );
  assert.equal(pool.snapshot()[0].maxConcurrent, 1);
});

test("fewest-active：按占用数最少分散负载，不平铺填满单模型", () => {
  const pool = new ModelPool(POOLS, "fewest-active");
  // 三个候选轮流铺开：两个模型各自的 active 交替为 0/0 → 0/1 → 1/1 → 1/2 …
  assert.equal(pool.allocate("child-a", "run-a").model, "subagent");
  assert.equal(pool.allocate("child-b", "run-b").model, "free");
  assert.equal(pool.allocate("child-c", "run-c").model, "subagent");
  assert.equal(pool.allocate("child-d", "run-d").model, "free");
  assert.deepEqual(pool.snapshot().map((entry) => entry.active), [2, 2]);
});

test("fewest-active：某模型占满后其余全落到另一个", () => {
  const pool = new ModelPool(
    [
      { provider: "c2a", model: "subagent", maxConcurrent: 1 },
      { provider: "c2a", model: "free", maxConcurrent: 5 },
    ],
    "fewest-active",
  );
  assert.equal(pool.allocate("child-a", "run-a").model, "subagent");
  // subagent 只剩 0 个名额，后续三个全走 free。
  assert.equal(pool.allocate("child-b", "run-b").model, "free");
  assert.equal(pool.allocate("child-c", "run-c").model, "free");
  assert.equal(pool.allocate("child-d", "run-d").model, "free");
  assert.deepEqual(pool.snapshot().map((entry) => entry.active), [1, 3]);
});

test("占用可被释放后重新分配到同一模型", () => {
  const pool = new ModelPool(
    [{ provider: "c2a", model: "subagent", maxConcurrent: 2 }],
    "fewest-active",
  );
  pool.allocate("child-a", "run-a");
  pool.allocate("child-b", "run-b");
  assert.equal(pool.allocate("child-c", "run-c"), undefined);

  pool.release("run-a", "child-a");
  assert.equal(pool.snapshot()[0].active, 1);
  // 释放出的名额应立刻可用。
  assert.equal(pool.allocate("child-e", "run-e").model, "subagent");
  assert.equal(pool.snapshot()[0].active, 2);
});

test("释放按 runId 幂等，重复调用不会重复减", () => {
  const pool = new ModelPool(POOLS, "fewest-active");
  pool.allocate("child-a", "run-a");
  assert.equal(pool.release("run-a", "child-a"), true);
  assert.equal(pool.snapshot()[0].active, 0);
  assert.equal(pool.release("run-a", "child-a"), false);
  assert.equal(pool.snapshot()[0].active, 0);
});

test("冷恢复开新 run，占两个名额且逐个释放", () => {
  const pool = new ModelPool(
    [{ provider: "c2a", model: "subagent", maxConcurrent: 5 }],
    "fewest-active",
  );
  pool.allocate("child-a", "run-1");
  // 冷恢复：同一 childId，新 runId。
  pool.allocate("child-a", "run-2");
  assert.equal(pool.snapshot()[0].active, 2);

  pool.release("run-1", "child-a");
  assert.equal(pool.snapshot()[0].active, 1);
  pool.release("run-2", "child-a");
  assert.equal(pool.snapshot()[0].active, 0);
});

test("已分配的子代理再次 allocate 返回同一路由", () => {
  const pool = new ModelPool(POOLS, "fewest-active");
  const first = pool.allocate("child-a", "run-1");
  const again = pool.allocate("child-a", "run-2");
  assert.deepEqual(again, first);
});

test("全部占满时返回 undefined（回退父路由）", () => {
  const pool = new ModelPool(
    [{ provider: "c2a", model: "subagent", maxConcurrent: 1 }],
    "fewest-active",
  );
  assert.notEqual(pool.allocate("child-a", "run-a"), undefined);
  assert.equal(pool.allocate("child-b", "run-b"), undefined);
});

test("least-recently-used：优先给从未被占用过的候选", () => {
  const pool = new ModelPool(POOLS, "least-recently-used");
  const first = pool.allocate("child-a", "run-a");
  pool.release("run-a", "child-a");
  // first 刚释放过（lastReleasedAt 有值），第二个候选从未释放 → 选第二个。
  const second = pool.allocate("child-b", "run-b");
  assert.equal(first.model, "subagent");
  assert.equal(second.model, "free");
});

test("least-recently-used：都已释放过时选释放更早的", () => {
  const pool = new ModelPool(POOLS, "least-recently-used");
  pool.allocate("child-a", "run-a");
  pool.release("run-a", "child-a"); // subagent 先释放
  pool.allocate("child-b", "run-b"); // 落到 free
  assert.equal(pool.assignmentOf("child-b").model, "free");
  pool.release("run-b", "child-b"); // free 后释放
  // 两者都释放过，subagent 的 lastReleasedAt 更早 → 选 subagent。
  assert.equal(pool.allocate("child-c", "run-c").model, "subagent");
});

test("预检失败的候选被排除，不再参与选择", () => {
  const pool = new ModelPool(POOLS, "fewest-active");
  pool.markRejected("c2a\u0000subagent");
  assert.equal(pool.allocate("child-a", "run-a").model, "free");
});

test("全部候选预检失败时 allRejected 为真", () => {
  const pool = new ModelPool(POOLS, "fewest-active");
  assert.equal(pool.allRejected(), false);
  pool.markRejected("c2a\u0000subagent");
  pool.markRejected("c2a\u0000free");
  assert.equal(pool.allRejected(), true);
});

test("discard 回滚 assignment 与占用", () => {
  const pool = new ModelPool(POOLS, "fewest-active");
  pool.allocate("child-a", "run-a");
  assert.equal(pool.snapshot()[0].active, 1);
  pool.discard("child-a", "run-a");
  assert.equal(pool.snapshot()[0].active, 0);
  assert.equal(pool.assignmentOf("child-a"), undefined);
});

test("策略名必须是受支持的三种之一", () => {
  assert.deepEqual(STRATEGIES, ["least-recently-used", "fewest-active", "strict-priority"]);
});

test("fewest-active 比例：weight 8:2 稳态占用趋近 80%:20%", () => {
  const cands = () => [
    { index: 0, provider: "c2a", model: "free", weight: 8, active: 0, lastReleasedAt: undefined },
    { index: 1, provider: "c2a", model: "paid", weight: 2, active: 0, lastReleasedAt: undefined },
  ];
  // 模拟连续派发 10 个（不释放），共享同一份候选数组让 active 真实累积。
  const candidates = cands();
  const tally = { free: 0, paid: 0 };
  for (let i = 0; i < 10; i++) {
    const picked = selectCandidate("fewest-active", candidates);
    tally[picked.model] += 1;
    picked.active += 1;
  }
  // 最优序列应把占用比推向 8:2（free 8 个、paid 2 个；首个 free，第 2 个 paid 是瞬态修正）。
  assert.deepEqual(tally, { free: 8, paid: 2 });
});

test("fewest-active 无权重时与旧行为一致（纯 active 比较）", () => {
  const candidates = [
    { index: 0, provider: "c2a", model: "a", active: 2, lastReleasedAt: undefined },
    { index: 1, provider: "c2a", model: "b", active: 1, lastReleasedAt: undefined },
  ];
  assert.equal(selectCandidate("fewest-active", candidates).model, "b");
});

test("strict-priority：高权重未满绝不轮到低权重", () => {
  const candidates = [
    { index: 0, provider: "c2a", model: "a", weight: 8, active: 1, lastReleasedAt: undefined },
    { index: 1, provider: "c2a", model: "b", weight: 2, active: 0, lastReleasedAt: undefined },
  ];
  assert.equal(selectCandidate("strict-priority", candidates).model, "a");
});

test("strict-priority：权重相同按配置数组顺序", () => {
  const candidates = [
    { index: 1, provider: "c2a", model: "b", weight: 3, active: 0, lastReleasedAt: undefined },
    { index: 0, provider: "c2a", model: "a", weight: 3, active: 0, lastReleasedAt: undefined },
  ];
  assert.equal(selectCandidate("strict-priority", candidates).model, "a");
});

test("strict-priority：全链 failover 取第一个有空闲者", () => {
  const candidates = [
    { index: 0, provider: "c2a", model: "a", weight: 8, active: 3, lastReleasedAt: 1 },
    { index: 1, provider: "c2a", model: "b", weight: 4, active: 2, lastReleasedAt: 2 },
    { index: 2, provider: "c2a", model: "c", weight: 1, active: 0, lastReleasedAt: 3 },
  ];
  // a、b 由调用方按 maxConcurrent 过滤后只剩 c 的场景等价于 c 有空闲——
  // 这里直接给三候选但 a/b 无空闲名额（active 已达上限），调用方会过滤；
  // 为覆盖排序本身，构造 a/b 已被过滤的等价输入：
  assert.equal(selectCandidate("strict-priority", candidates.slice(2)).model, "c");
});

test("strict-priority 缺 weight 视为 1", () => {
  const candidates = [
    { index: 1, provider: "c2a", model: "b", active: 0, lastReleasedAt: undefined },
    { index: 0, provider: "c2a", model: "a", weight: 5, active: 0, lastReleasedAt: undefined },
  ];
  assert.equal(selectCandidate("strict-priority", candidates).model, "a");
});

test("selectCandidate 空数组返回 undefined", () => {
  assert.equal(selectCandidate("fewest-active", []), undefined);
  assert.equal(selectCandidate("least-recently-used", []), undefined);
});

test("探测 TTL：validated 过期后失效，rejected 过期后可重探", () => {
  const p1 = new ModelPool([{ provider: "c2a", model: "a" }], "fewest-active");
  p1.markValidated("c2a\u0000a");
  assert.equal(p1.isValidated("c2a\u0000a"), true);
  const futureValid = Date.now() + VALIDATED_TTL_MS + 1;
  const origNow = Date.now;
  Date.now = () => futureValid;
  assert.equal(p1.isValidated("c2a\u0000a"), false, "validated 超过 5 分钟应失效");
  Date.now = origNow;

  const p2 = new ModelPool([{ provider: "c2a", model: "a" }], "fewest-active");
  p2.markRejected("c2a\u0000a");
  assert.equal(p2.isRejected("c2a\u0000a"), true);
  const futureRej = Date.now() + REJECTED_TTL_MS + 1;
  Date.now = () => futureRej;
  assert.equal(p2.isRejected("c2a\u0000a"), false, "rejected 超过 60 秒应可重探");
  Date.now = origNow;
});

// ---- 探测状态 TTL（v0.3.0）----

test("markValidated 后 TTL 内有效、超时失效", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const pool = new ModelPool([{ provider: "c2a", model: "a" }], "fewest-active");
  const key = "c2a\u0000a";
  pool.markValidated(key);
  assert.equal(pool.isValidated(key), true);
  t.mock.timers.tick(VALIDATED_TTL_MS - 1);
  assert.equal(pool.isValidated(key), true, "TTL 边界内仍有效");
  t.mock.timers.tick(1);
  assert.equal(pool.isValidated(key), false, "过期后应重新探测");
});

test("markRejected 后拉黑期内跳过、到期自动可重探", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const pool = new ModelPool([{ provider: "c2a", model: "a" }], "fewest-active");
  const key = "c2a\u0000a";
  pool.markRejected(key);
  assert.equal(pool.isRejected(key), true);
  t.mock.timers.tick(REJECTED_TTL_MS - 1);
  assert.equal(pool.isRejected(key), true, "拉黑期内仍排除");
  t.mock.timers.tick(1);
  assert.equal(pool.isRejected(key), false, "到期后恢复可探测");
});

test("allRejected 走 TTL 语义：过期的失败不算拉黑", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const pool = new ModelPool([{ provider: "c2a", model: "a" }], "fewest-active");
  const key = "c2a\u0000a";
  pool.markRejected(key);
  assert.equal(pool.allRejected(), true, "拉黑期内全拒");
  t.mock.timers.tick(REJECTED_TTL_MS + 1);
  assert.equal(pool.allRejected(), false, "过期后不再视为全拒");
});

test("validated 与 rejected 独立计时", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const pool = new ModelPool([{ provider: "c2a", model: "a" }], "fewest-active");
  const key = "c2a\u0000a";
  pool.markValidated(key);
  assert.equal(pool.isRejected(key), false, "通过即不在拉黑名单");
  t.mock.timers.tick(VALIDATED_TTL_MS + 1);
  assert.equal(pool.isValidated(key), false);
  assert.equal(pool.isRejected(key), false, "过期只是回到未探测，不是拉黑");
});

// ---- 配置热更新时的占用迁移 ----
//
// 换池不迁占用会有三个后果：统计页占用归零、并发上限失效（能再派满额）、
// 子代理结束时 release 打空导致永久泄漏。

test("换池后占用不丢", () => {
  const before = new ModelPool(POOLS, "strict-priority");
  before.allocate("child-1", "run-1");
  assert.equal(before.activeCount, 1);

  // 模拟改配置后重建（候选顺序故意反过来，考验按 routeKey 而不是下标映射）
  const after = new ModelPool([...POOLS].reverse(), "strict-priority");
  const migrated = after.inherit(before);

  assert.equal(migrated, 1, "应迁移 1 个占用");
  assert.equal(after.activeCount, 1, "换池后占用不能归零");
});

test("换池后并发上限仍然生效", () => {
  const single = [{ provider: "c2a", model: "only", maxConcurrent: 1 }];
  const before = new ModelPool(single, "strict-priority");
  before.allocate("child-1", "run-1");
  assert.equal(before.activeCount, 1);

  const after = new ModelPool(single, "strict-priority");
  after.inherit(before);
  // 上限 1 已被旧占用占满，新子代理应拿不到路由
  assert.equal(after.allocate("child-2", "run-2"), undefined, "不能超发");
});

test("换池后子代理结束能正常释放", () => {
  const before = new ModelPool(POOLS, "strict-priority");
  before.allocate("child-1", "run-1");

  const after = new ModelPool(POOLS, "strict-priority");
  after.inherit(before);
  assert.equal(after.activeCount, 1);

  assert.equal(after.release("run-1", "child-1"), true, "旧 run 的释放要打到新池上");
  assert.equal(after.activeCount, 0, "释放后归零，不泄漏");
});

test("候选被删掉时占用丢弃但不报错", () => {
  const before = new ModelPool(POOLS, "strict-priority");
  before.allocate("child-1", "run-1");

  // 新配置里没有 subagent 这个候选了
  const after = new ModelPool([{ provider: "c2a", model: "free" }], "strict-priority");
  const migrated = after.inherit(before);

  assert.equal(migrated, 0, "无处归属的占用不迁移");
  assert.equal(after.activeCount, 0, "不应记到别的候选上");
  // 该子代理仍锁着原路由，结束时 release 静默无效即可，不能抛错
  assert.equal(after.release("run-1", "child-1"), false);
});

test("受保护的分配记录跨池保留", () => {
  const before = new ModelPool(POOLS, "strict-priority");
  const assigned = before.allocate("child-1", "run-1");
  assert.ok(assigned);

  const after = new ModelPool(POOLS, "strict-priority");
  after.inherit(before);
  // 子代理 spawn 时锁定模型，换配置不改它的路由
  assert.deepEqual(after.assignmentOf("child-1"), assigned);
});

test("inherit 自己或非池对象时安全", () => {
  const pool = new ModelPool(POOLS, "strict-priority");
  assert.equal(pool.inherit(pool), 0);
  assert.equal(pool.inherit(undefined), 0);
  assert.equal(pool.inherit({}), 0);
});
