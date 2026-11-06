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

// ---- 会话分组 ----

test("子代理挂到主会话下面", () => {
  const { groupSessions } = loadTestExports();
  const rows = groupSessions([
    { sessionId: "p", isSubagent: false, requests: 1, tokens: {}, routes: [] },
    { sessionId: "c1", isSubagent: true, parentSessionId: "p", requests: 1, tokens: {}, routes: [] },
    { sessionId: "c2", isSubagent: true, parentSessionId: "p", requests: 1, tokens: {}, routes: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.session.sessionId), ["p", "c1", "c2"]);
  assert.equal(rows[0].kind, "parent");
  assert.equal(rows[1].kind, "child");
});

test("父会话不在账本里的孤儿子代理仍单独成行", () => {
  const { groupSessions } = loadTestExports();
  const rows = groupSessions([
    { sessionId: "c1", isSubagent: true, parentSessionId: "gone", requests: 1, tokens: {}, routes: [] },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "child");
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
