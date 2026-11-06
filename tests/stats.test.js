// 统计账本纯逻辑测试：不依赖 cordis 运行时。
import test from "node:test";
import assert from "node:assert/strict";
import { PoolStats, routeKey, parseRouteKey, MAX_TRACKED_SESSIONS } from "../lib/stats.js";

/**
 * 造一个最小会话头。
 *
 * 默认是**子代理会话**（origin=subagent）——账本只统计子代理，
 * 主代理会话的消耗不进池的账（见 lib/stats.js 的 isSubagentSession）。
 * @param {string} id - 会话 id。
 * @param {object} extra - 追加到 header 的字段。
 * @returns {object} 会话。
 */
function sessionOf(id, extra = {}) {
  return {
    id,
    header: { id, createdAt: 1, cwd: "/tmp", origin: "subagent", ...extra },
  };
}

/**
 * 造一个主代理会话（origin 不为 subagent）。
 * @param {string} id - 会话 id。
 * @param {object} extra - 追加到 header 的字段。
 * @returns {object} 会话。
 */
function parentSessionOf(id, extra = {}) {
  return {
    id,
    header: { id, createdAt: 1, cwd: "/tmp", ...extra },
  };
}

// ---- routeKey ----

test("routeKey 不因分隔符碰撞", () => {
  assert.notEqual(routeKey("a", "b\u0000c"), routeKey("a\u0000b", "c"));
  assert.equal(routeKey("c2a", "free"), routeKey("c2a", "free"));
});

test("parseRouteKey 能还原 routeKey", () => {
  const key = routeKey("c2a", "subagent");
  assert.deepEqual(parseRouteKey(key), { provider: "c2a", model: "subagent" });
});

// ---- 分配 / 释放 / 回退 / 探测失败 ----

test("分配与释放按路由分别计数", () => {
  const stats = new PoolStats();
  stats.recordAssignment("c2a", "subagent");
  stats.recordAssignment("c2a", "subagent");
  stats.recordAssignment("c2a", "free");
  stats.recordRelease("c2a", "subagent");
  const snap = stats.snapshot();
  assert.equal(snap.totals.assignments, 3);
  const subagent = snap.routes.find((r) => r.model === "subagent");
  const free = snap.routes.find((r) => r.model === "free");
  assert.equal(subagent.assignments, 2);
  assert.equal(subagent.releases, 1);
  assert.equal(free.assignments, 1);
  assert.equal(free.releases, 0);
});

test("回退与探测失败计入合计", () => {
  const stats = new PoolStats();
  stats.recordFallback();
  stats.recordFallback();
  stats.recordProbeFailure("c2a", "free");
  const snap = stats.snapshot();
  assert.equal(snap.totals.fallbacks, 2);
  assert.equal(snap.totals.probeFailures, 1);
  assert.equal(snap.routes.find((r) => r.model === "free").probeFailures, 1);
});

// ---- token ----

test("token 四桶分开累计", () => {
  const stats = new PoolStats();
  stats.recordUsage("c2a", "free", {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 5,
  });
  const snap = stats.snapshot();
  const route = snap.routes.find((r) => r.model === "free");
  assert.deepEqual(route.tokens, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 5,
  });
  assert.equal(route.totalTokens, 425);
  assert.equal(snap.totals.requests, 1);
  assert.equal(snap.totals.tokens.totalTokens, 425);
});

test("缺省的缓存桶按零处理", () => {
  const stats = new PoolStats();
  stats.recordUsage("c2a", "free", { inputTokens: 10, outputTokens: 2 });
  const route = stats.snapshot().routes[0];
  assert.equal(route.tokens.cacheReadTokens, 0);
  assert.equal(route.tokens.cacheWriteTokens, 0);
  assert.equal(route.totalTokens, 12);
});

test("非法 usage 字段被忽略", () => {
  const stats = new PoolStats();
  stats.recordUsage("c2a", "free", { inputTokens: Number.NaN, outputTokens: -5 });
  const route = stats.snapshot().routes[0];
  assert.equal(route.tokens.inputTokens, 0);
  assert.equal(route.tokens.outputTokens, 0);
});

// ---- 会话归属 ----

test("主代理会话的消耗不进池的账，只记子代理", () => {
  const stats = new PoolStats();
  const parent = parentSessionOf("parent-1");
  const child = sessionOf("child-1", { parentSession: "parent-1" });
  stats.recordSessionUsage(parent, "c2a", "paid", { turn: 1, step: 1 }, { inputTokens: 50, outputTokens: 10 }, 1000);
  stats.recordSessionUsage(child, "c2a", "free", { turn: 1, step: 1 }, { inputTokens: 70, outputTokens: 20 }, 2000);
  const snap = stats.snapshot();
  // 主代理会话根本不该出现在账本里。
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions.find((s) => s.sessionId === "parent-1"), undefined);
  const childRow = snap.sessions.find((s) => s.sessionId === "child-1");
  assert.equal(childRow.isSubagent, true);
  assert.equal(childRow.parentSessionId, "parent-1");
  // 总量只含子代理的 70+20，不含主代理的 50+10。
  assert.equal(snap.totals.requests, 1);
  assert.equal(snap.totals.tokens.inputTokens, 70);
  assert.equal(snap.totals.tokens.outputTokens, 20);
  // 路由统计里也不该出现主代理的 paid 路由。
  assert.equal(snap.routes.length, 1);
  assert.equal(snap.routes[0].model, "free");
  assert.equal(childRow.routes.length, 1);
  assert.equal(childRow.routes[0].model, "free");
  assert.equal(childRow.totalTokens, 90);
});

test("子代理会话带上父会话标题（主代理不进账但标题照记）", () => {
  const stats = new PoolStats();
  const parent = parentSessionOf("p1");
  const child = sessionOf("c1", { parentSession: "p1" });
  // 主代理的标题事件照样要记：列表里得能看出子代理是被哪个会话派出去的。
  stats.rememberTitle(parent, "子代理模型池统计视图");
  stats.rememberTitle(child, "请回答：6+6等于几？");
  stats.recordSessionUsage(child, "c2a", "free", { turn: 1, step: 1 }, { inputTokens: 70, outputTokens: 20 }, 1000);
  const snap = stats.snapshot();
  const row = snap.sessions.find((s) => s.sessionId === "c1");
  assert.equal(row.title, "请回答：6+6等于几？");
  assert.equal(row.parentTitle, "子代理模型池统计视图");
  // 主代理本身仍然不进会话列表。
  assert.equal(snap.sessions.find((s) => s.sessionId === "p1"), undefined);
});

test("父会话没有标题时 parentTitle 为 undefined", () => {
  const stats = new PoolStats();
  const child = sessionOf("c1", { parentSession: "p1" });
  stats.recordSessionUsage(child, "c2a", "free", { turn: 1, step: 1 }, { inputTokens: 10, outputTokens: 1 }, 1000);
  const snap = stats.snapshot();
  assert.equal(snap.sessions[0].parentTitle, undefined);
});

test("主代理会话完全不影响统计", () => {
  const stats = new PoolStats();
  stats.recordSessionUsage(
    parentSessionOf("p1"),
    "c2a",
    "paid",
    { turn: 1, step: 1 },
    { inputTokens: 9999, outputTokens: 9999 },
    1000,
  );
  const snap = stats.snapshot();
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.totals.requests, 0);
  assert.equal(snap.totals.tokens.inputTokens, 0);
  assert.equal(snap.routes.length, 0);
});

test("origin 是判定子代理的唯一依据（parentSession 不作数）", () => {
  const stats = new PoolStats();
  // 普通 fork：带 parentSession 但 origin 不是 subagent → 不算子代理。
  const forked = sessionOf("fork-1", { origin: undefined, parentSession: "root-1" });
  stats.recordSessionUsage(forked, "c2a", "paid", { turn: 1, step: 1 }, { inputTokens: 50, outputTokens: 10 }, 1000);
  const snap = stats.snapshot();
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.totals.tokens.inputTokens, 0);
});

test("同一 turn/step 重复结算按替换语义（总量取最新值）", () => {
  const stats = new PoolStats();
  const session = sessionOf("s1");
  stats.recordSessionUsage(session, "c2a", "free", { turn: 1, step: 1 }, { inputTokens: 100, outputTokens: 10 }, 1000);
  stats.recordSessionUsage(session, "c2a", "free", { turn: 1, step: 1 }, { inputTokens: 130, outputTokens: 10 }, 1100);
  const snap = stats.snapshot();
  // 与 dsh-token-meter 同口径：同 turn/step 的再次结算替换上一次，总量 = 130。
  assert.equal(snap.totals.tokens.inputTokens, 130);
  assert.equal(snap.totals.tokens.outputTokens, 10);
  assert.equal(snap.totals.requests, 2);
});

test("同 turn/step 结算到桶相同时不重复累计", () => {
  const stats = new PoolStats();
  const session = sessionOf("s1");
  stats.recordSessionUsage(session, "c2a", "free", { turn: 2, step: 1 }, { inputTokens: 40, outputTokens: 5 }, 1000);
  stats.recordSessionUsage(session, "c2a", "free", { turn: 2, step: 1 }, { inputTokens: 40, outputTokens: 5 }, 1100);
  assert.equal(stats.snapshot().totals.tokens.inputTokens, 40);
});

test("retry-started 作废上一个槽，重试的尝试按新值叠加（与 token-meter 同口径）", () => {
  const stats = new PoolStats();
  const session = sessionOf("s1");
  stats.recordSessionUsage(session, "c2a", "free", { turn: 3, step: 1 }, { inputTokens: 100, outputTokens: 10 }, 1000);
  stats.invalidateUsageSlot(session, { turn: 3, step: 1 });
  stats.recordSessionUsage(session, "c2a", "free", { turn: 3, step: 1 }, { inputTokens: 120, outputTokens: 12 }, 1100);
  // dsh-token-meter 的口径：retry-started 关闭替换槽，重试的那次请求全额计入。
  assert.equal(stats.snapshot().totals.tokens.inputTokens, 220);
  assert.equal(stats.snapshot().totals.tokens.outputTokens, 22);
});

// ---- 池实时状态合并 ----

test("快照合并池的实时占用，并列出未分配的候选", () => {
  const stats = new PoolStats();
  stats.recordAssignment("c2a", "subagent");
  const snap = stats.snapshot([
    { provider: "c2a", model: "subagent", active: 2, maxConcurrent: 3, weight: 1 },
    { provider: "c2a", model: "free", active: 0, maxConcurrent: 3, weight: 8 },
  ]);
  const subagent = snap.routes.find((r) => r.model === "subagent");
  const free = snap.routes.find((r) => r.model === "free");
  assert.equal(subagent.active, 2);
  assert.equal(subagent.maxConcurrent, 3);
  assert.equal(free.assignments, 0);
  assert.equal(free.weight, 8);
  assert.equal(snap.routes.length, 2);
  assert.equal(subagent.inPool, true, "池内候选要标记出来");
});

test("池外的路由（主代理自己的模型）标记为不在池内", () => {
  const stats = new PoolStats();
  stats.recordUsage("c2a", "paid", { inputTokens: 10, outputTokens: 2 });
  const snap = stats.snapshot([
    { provider: "c2a", model: "free", active: 0, maxConcurrent: 3, weight: 1 },
  ]);
  const paid = snap.routes.find((r) => r.model === "paid");
  assert.equal(paid.inPool, false, "不在池配置里的路由不该出现在「池占用」面板");
});

test("路由按分配次数降序排列", () => {
  const stats = new PoolStats();
  stats.recordAssignment("c2a", "b");
  stats.recordAssignment("c2a", "a");
  stats.recordAssignment("c2a", "a");
  const snap = stats.snapshot();
  assert.equal(snap.routes[0].model, "a");
  assert.equal(snap.routes[1].model, "b");
});

// ---- 会话上限 ----

test("会话明细超过上限时淘汰最久未更新的", () => {
  const stats = new PoolStats();
  for (let i = 0; i < MAX_TRACKED_SESSIONS + 5; i += 1) {
    stats.recordSessionUsage(sessionOf(`s${i}`), "c2a", "free", { turn: 1, step: 1 }, { inputTokens: 1 }, i);
  }
  const snap = stats.snapshot();
  assert.equal(snap.sessions.length, MAX_TRACKED_SESSIONS);
  // 最旧的被淘汰，最新的还在。
  assert.equal(snap.sessions.some((s) => s.sessionId === "s0"), false);
  assert.equal(snap.sessions.some((s) => s.sessionId === `s${MAX_TRACKED_SESSIONS + 4}`), true);
});
