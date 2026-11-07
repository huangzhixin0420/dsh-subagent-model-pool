// 统计视图的客户端纯逻辑测试：口径排序、槽位图、分组、格式化。
// 不依赖 DOM 与宿主模块加载器（client.js 是手写 ModuleLoader 客户端）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** 取出 factory 导出的 __test 出口。 */
function loadTestExports() {
  let captured;
  const windowStub = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  const runtime = { jsx: () => null, jsxs: () => null };
  const requireStub = (name) => {
    if (name === "react") return { useState: () => null, useEffect: () => null, useMemo: () => null };
    if (name === "react/jsx-runtime") return runtime;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconGaugeOutlineRegular: () => null };
    return runtime;
  };
  new Function("window", "document", source)(windowStub, undefined);
  assert.ok(captured, "模块未被 __ModuleLoader__ 捕获");
  return captured.factory(requireStub).__test;
}

/** 造一条路由统计项。 */
function route(provider, model, extra = {}) {
  return {
    provider,
    model,
    assignments: 0,
    releases: 0,
    probeFailures: 0,
    requests: 0,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    totalTokens: 0,
    active: 0,
    maxConcurrent: 3,
    weight: 1,
    // 默认是池内候选；回退路由用 inPool: false 表示。
    inPool: true,
    ...extra,
  };
}

// ---- 口径 ----

test("三种口径各自取对应的度量", () => {
  const { measureOf, MODES } = loadTestExports();
  const r = route("c2a", "free", { requests: 7, assignments: 2, totalTokens: 900 });
  assert.deepEqual(MODES, ["tokens", "requests", "assignments"]);
  assert.equal(measureOf(r, "tokens"), 900);
  assert.equal(measureOf(r, "requests"), 7);
  assert.equal(measureOf(r, "assignments"), 2);
});

test("缺字段按 0 计", () => {
  const { measureOf } = loadTestExports();
  assert.equal(measureOf({}, "tokens"), 0);
  assert.equal(measureOf({}, "requests"), 0);
  assert.equal(measureOf({}, "assignments"), 0);
});

// ---- 排序与占比 ----

test("按口径排序并给占比", () => {
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes(
    [
      route("c2a", "a", { totalTokens: 100 }),
      route("c2a", "b", { totalTokens: 300 }),
      route("c2a", "c", { totalTokens: 600 }),
    ],
    "tokens",
  );
  assert.deepEqual(ranked.map((r) => r.model), ["c", "b", "a"]);
  assert.equal(Math.round(ranked[0].ratio * 100), 60);
  assert.equal(Math.round(ranked[2].ratio * 100), 10);
});

test("度量相同时按 provider/model 名字定序", () => {
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes(
    [route("z", "b", { totalTokens: 5 }), route("a", "c", { totalTokens: 5 })],
    "tokens",
  );
  assert.deepEqual(ranked.map((r) => r.provider), ["a", "z"]);
});

test("全零度量时占比为 0 不报 NaN", () => {
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes([route("c2a", "a"), route("c2a", "b")], "tokens");
  assert.equal(ranked[0].ratio, 0);
});

test("每条路由拿到一个稳定的配色槽", () => {
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes(
    [
      route("c2a", "a", { totalTokens: 4 }),
      route("c2a", "b", { totalTokens: 3 }),
      route("c2a", "c", { totalTokens: 2 }),
      route("c2a", "d", { totalTokens: 1 }),
      route("c2a", "e", { totalTokens: 0.5 }),
    ],
    "tokens",
  );
  assert.equal(ranked[0].tone, "t0");
  assert.equal(ranked[1].tone, "t1");
  assert.equal(ranked[4].tone, "t0");
});

// ---- 槽位图 ----

test("槽位图按 maxConcurrent 画格，占用的画 busy", () => {
  const { slotStates } = loadTestExports();
  const states = slotStates(route("c2a", "free", { maxConcurrent: 3, active: 2 }));
  assert.deepEqual(states, ["busy", "busy", "idle"]);
});

test("占用数超过容量时不多画格", () => {
  const { slotStates } = loadTestExports();
  const states = slotStates(route("c2a", "free", { maxConcurrent: 2, active: 5 }));
  assert.equal(states.length, 2);
  assert.deepEqual(states, ["busy", "busy"]);
});

test("探测失败的路由槽位标 hot", () => {
  const { slotStates } = loadTestExports();
  const states = slotStates(route("c2a", "free", { maxConcurrent: 2, active: 1, probeFailures: 3 }));
  assert.deepEqual(states, ["hot", "idle"]);
});

// ---- 健康状态 ----

test("健康状态区分空闲、满载、探测失败", () => {
  const { routeHealth } = loadTestExports();
  assert.equal(routeHealth(route("c2a", "a", { active: 0, maxConcurrent: 3 })), "ok");
  assert.equal(routeHealth(route("c2a", "a", { active: 3, maxConcurrent: 3 })), "hot");
  assert.equal(routeHealth(route("c2a", "a", { active: 0, maxConcurrent: 3, probeFailures: 1 })), "down");
});

// ---- 会话列表 ----

test("会话平铺列出（账本只记子代理，没有父子层级）", () => {
  const { groupSessions } = loadTestExports();
  const rows = groupSessions([
    { sessionId: "c1", isSubagent: true, parentSessionId: "p", requests: 1, tokens: {}, routes: [] },
    { sessionId: "c2", isSubagent: true, parentSessionId: "p", requests: 1, tokens: {}, routes: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.session.sessionId), ["c1", "c2"]);
  assert.equal(rows[0].kind, "session");
});

test("同发起会话的子代理排在一起", () => {
  const { groupSessions } = loadTestExports();
  const rows = groupSessions([
    { sessionId: "a", parentSessionId: "p2", title: "B1", requests: 1, tokens: {}, routes: [] },
    { sessionId: "b", parentSessionId: "p1", title: "A1", requests: 1, tokens: {}, routes: [] },
    { sessionId: "c", parentSessionId: "p2", title: "B2", requests: 1, tokens: {}, routes: [] },
    { sessionId: "d", parentSessionId: "p1", title: "A2", requests: 1, tokens: {}, routes: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.session.sessionId), ["b", "d", "a", "c"]);
});

test("部分占用不能叫空闲", () => {
  const { routeHealth } = loadTestExports();
  // 2/6：探测没失败、也没满载，但它正在被用
  assert.equal(routeHealth({ active: 2, maxConcurrent: 6, probeFailures: 0 }), "busy");
  assert.equal(routeHealth({ active: 0, maxConcurrent: 6, probeFailures: 0 }), "ok");
  assert.equal(routeHealth({ active: 6, maxConcurrent: 6, probeFailures: 0 }), "hot");
  assert.equal(routeHealth({ active: 1, maxConcurrent: 6, probeFailures: 1 }), "down");
});

test("池占用按 weight 降序排（strict-priority 的派发顺序）", () => {
  const { sortSlotsByPriority } = loadTestExports();
  const sorted = sortSlotsByPriority([
    route("c2a", "subagent", { weight: 1 }),
    route("c2a", "free", { weight: 8 }),
    route("c2a", "paid", { weight: 18 }),
  ]);
  // 第一行必须是 weight 最大的——它没满就只会派给它。
  assert.deepEqual(sorted.map((r) => r.model), ["paid", "free", "subagent"]);
});

test("同 weight 保持配置顺序", () => {
  const { sortSlotsByPriority } = loadTestExports();
  const sorted = sortSlotsByPriority([
    route("c2a", "a", { weight: 5 }),
    route("c2a", "b", { weight: 5 }),
    route("c2a", "c", { weight: 5 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.model), ["a", "b", "c"]);
});

test("缺 weight 的候选按 1 处理", () => {
  const { sortSlotsByPriority } = loadTestExports();
  const sorted = sortSlotsByPriority([
    route("c2a", "noWeight", {}),
    route("c2a", "high", { weight: 9 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.model), ["high", "noWeight"]);
});

test("未归属请求数 = 累计 - 明细之和", () => {
  const { unattributedRequests } = loadTestExports();
  const totals = { requests: 149 };
  const sessions = [{ requests: 38 }, { requests: 27 }, { requests: 19 }, { requests: 12 }, { requests: 8 }];
  // 149 - 104 = 45：被 200 条上限淘汰的会话贡献的
  assert.equal(unattributedRequests(totals, sessions), 45);
});

test("明细超过累计时未归属钳到 0", () => {
  const { unattributedRequests } = loadTestExports();
  assert.equal(unattributedRequests({ requests: 10 }, [{ requests: 12 }]), 0);
});

test("空明细/空累计都不炸", () => {
  const { unattributedRequests } = loadTestExports();
  assert.equal(unattributedRequests({ requests: 0 }, []), 0);
  assert.equal(unattributedRequests(null, null), 0);
  assert.equal(unattributedRequests({ requests: 5 }, undefined), 5);
});

test("空列表返回空数组", () => {
  const { groupSessions } = loadTestExports();
  assert.deepEqual(groupSessions([]), []);
});

// ---- 回退路由 ----

test("回退路由与池内路由共用一个分母", () => {
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes(
    [
      route("c2a", "free", { totalTokens: 30 }),
      route("c2a", "paid", { totalTokens: 70, inPool: false }),
    ],
    "tokens",
  );
  const pool = ranked.filter((r) => r.isFallback !== true);
  const fallback = ranked.filter((r) => r.isFallback === true);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].model, "free");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].model, "paid");
  assert.equal(fallback[0].tone, "fb");
  // 全局分母 = 30 + 70 = 100，两段加起来正好 100%。
  assert.equal(pool[0].ratio, 0.3);
  assert.equal(fallback[0].ratio, 0.7);
  assert.equal(
    ranked.reduce((sum, r) => sum + r.ratio, 0),
    1,
  );
});

test("分组各算 100% 会让条子宽到 200%", () => {
  // 回归防线：曾经池内和回退各自按组内归一，两段相加 = 200%，
  // 被 flex 压回 100% 后回退段（真实 9%）画成近一半。
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes(
    [
      route("c2a", "free", { totalTokens: 900 }),
      route("c2a", "paid", { totalTokens: 100, inPool: false }),
    ],
    "tokens",
  );
  const sum = ranked.reduce((acc, r) => acc + r.ratio, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `两段占比之和应为 1，实际 ${sum}`);
  const fallback = ranked.find((r) => r.isFallback === true);
  assert.ok(Math.abs(fallback.ratio - 0.1) < 1e-9, "回退段应占 10%");
});

test("池外但没有用量的路由不显示为回退", () => {
  const { rankRoutes } = loadTestExports();
  const ranked = rankRoutes(
    [route("c2a", "free", { totalTokens: 10 }), route("c2a", "idle", { totalTokens: 0, inPool: false })],
    "tokens",
  );
  assert.equal(ranked.filter((r) => r.isFallback === true).length, 0);
});

// ---- 格式化 ----

test("千分位与紧凑 token 数", () => {
  const { formatCount, formatTokens } = loadTestExports();
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(120000), "120k");
  assert.equal(formatTokens(1500000), "1.5M");
  assert.equal(formatCount(undefined), "—");
  assert.equal(formatTokens(undefined), "—");
});

test("百分比去掉多余的 .0", () => {
  const { formatPercent } = loadTestExports();
  assert.equal(formatPercent(0.5), "50%");
  assert.equal(formatPercent(0.123), "12.3%");
  assert.equal(formatPercent(undefined), "—");
});

// ---- 快照校验 ----

test("形状不对的快照判为不可用", () => {
  const { parseSnapshot } = loadTestExports();
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot({}), null);
  assert.equal(parseSnapshot({ routes: [], sessions: [] }), null);
  const ok = { routes: [], sessions: [], totals: { assignments: 0 } };
  assert.deepEqual(parseSnapshot(ok), ok);
});

// ---- 注册形态 ----

test("统计面板注册为独立主页面与侧栏条目", () => {
  const { PANEL_ID, STATS_ROUTE } = loadTestExports();
  assert.equal(PANEL_ID, "subagent-model-pool");
  // 浏览器相对路径（内置 deliverables 同款写法：绝对路径去掉开头的斜杠）。
  assert.equal(STATS_ROUTE, "api/subagent-pool.stats");
});
