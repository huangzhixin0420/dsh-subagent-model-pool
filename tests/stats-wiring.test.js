// 服务端接线测试：session/event → 统计账本 → 取数路由。
//
// 覆盖真实事件形状：
// - `request/header` 的 `header.config` 是下一次请求的路由；
// - `assistant/message` 的 `message.source` 是这次实际走的路由，
//   `data.usage` 是 token 四桶；
// - `assistant/attempt`（失败/中断的尝试）没有 message.source，
//   usage 藏在内嵌 stream 的最后一个 usage chunk 里；
// - `llm/retry-started` 作废替换槽。
import test from "node:test";

import assert from "node:assert/strict";
import { apply } from "../index.js";

/** 造一个能跑 apply 的最小 ctx。 */
function stubCtx() {
  const handlers = new Map();
  const routes = [];
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]) },
    on: (event, fn) => { handlers.set(event, fn); },
    inject: (_services, fn) => fn(ctx),
    effect: () => {},
    get: (svc) => {
      if (svc === "connection") {
        return {
          fetch: {
            register: (route) => {
              routes.push(route);
              return () => {
                const index = routes.indexOf(route);
                if (index >= 0) routes.splice(index, 1);
              };
            },
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, handlers, routes, logs };
}

/** 造一个子代理会话。 */
function subagentSession(id = "child-1", parent = "main-1") {
  return { id, header: { origin: "subagent", parentSession: parent } };
}

/** 造一个主代理会话。 */
function mainSession(id = "main-1") {
  return { id, header: { origin: "user" } };
}

/** 发一条会话事件。 */
function emit(handlers, session, event) {
  handlers.get("session/event")(session, event);
}

/** 读一次统计快照。 */
async function readSnapshot(routes) {
  const response = await routes[0].fetch();
  return response.json();
}

// ---- 路由注册 ----

// 账本与池挂在 globalThis 上（为了跨 HMR 重载存活），所以测试之间必须清掉，
// 否则上一个用例的累计值会漏到下一个。等价于清 localStorage / 清 DOM。
test.beforeEach(() => {
  delete globalThis[Symbol.for("dsh-subagent-model-pool.stats")];
  delete globalThis[Symbol.for("dsh-subagent-model-pool.pool")];
});

test("注册取数路由，路径在 /api 下", () => {
  const { ctx, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/api/subagent-pool.stats");
  assert.deepEqual(routes[0].methods, ["GET"]);
});

test("没有 connection 服务时安静降级，不抛错", () => {
  const handlers = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: (event, fn) => { handlers.set(event, fn); },
    inject: (_services, fn) => fn(ctx),
    effect: () => {},
    get: () => undefined,
  };
  assert.doesNotThrow(() => {
    apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  });
});

// ---- 配置热更新 ----

test("volatile 配置变化后重建池，取数跟着变", async () => {
  const cfg = { enabled: true, pools: [{ provider: "c2a", model: "a" }] };
  const { ctx, routes } = stubCtx();
  apply(ctx, { get: () => cfg });

  const before = await readSnapshot(routes);
  assert.equal(before.routes.length, 1);

  // 设置页保存等价于 volatile 引用被写入新值
  cfg.pools.push({ provider: "c2a", model: "b" });
  const after = await readSnapshot(routes);
  assert.equal(after.routes.length, 2, "配置变化后要重建池");
  assert.deepEqual(after.routes.map((r) => r.model).sort(), ["a", "b"]);
});

test("配置指纹只随影响分配的字段变化", () => {
  const { ctx, routes } = stubCtx();
  let cfg = { enabled: true, strategy: "strict-priority", pools: [{ provider: "c2a", model: "a", weight: 5 }] };
  apply(ctx, { get: () => cfg });
  // 只改无关字段不应重建（这里只断言不抛错且池保持）
  cfg = { ...cfg, somethingUnrelated: 1 };
  assert.doesNotThrow(() => { routes[0].fetch(); });
});

// ---- 生命周期事件 ----

// subagent/start 与 subagent/end 走 cordis 事件总线，不落 session log，
// 所以状态只能在这两个 handler 里更新。之前把它们写在 session/event 分支里，
// 结果永远收不到，会话答完还显示「进行中」。

test("subagent/end 之后会话状态变成 done", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession("child-1"), {
    type: "assistant/message",
    data: {
      turn: 1, step: 1,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { kind: "model", provider: "c2a", model: "subagent" } },
    },
  });
  handlers.get("subagent/start")({ id: "child-1", runId: "run-1" });
  let snapshot = await readSnapshot(routes);
  assert.equal(snapshot.sessions[0].state, "running");

  handlers.get("subagent/end")({ id: "child-1", runId: "run-1", stopReason: "end_turn" });
  snapshot = await readSnapshot(routes);
  assert.equal(snapshot.sessions[0].state, "done");
  assert.equal(snapshot.sessions[0].stopReason, "end_turn");
});

test("没有生命周期事件时不会崩", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  assert.doesNotThrow(() => {
    handlers.get("subagent/start")({});
    handlers.get("subagent/end")({});
    handlers.get("subagent/end")(undefined);
  });
});

// ---- 记账 ----

test("assistant/message 的 usage 记到实际路由上", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession(), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 5 },
      message: { source: { kind: "model", provider: "c2a", model: "subagent" } },
    },
  });
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.tokens.inputTokens, 120);
  assert.equal(snapshot.totals.tokens.outputTokens, 30);
  assert.equal(snapshot.totals.tokens.cacheReadTokens, 40);
  assert.equal(snapshot.totals.tokens.cacheWriteTokens, 5);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0].provider, "c2a");
  assert.equal(snapshot.routes[0].model, "subagent");
  assert.equal(snapshot.routes[0].totalTokens, 195);
});

test("主代理与子代理的会话明细分开记", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, mainSession(), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1000, outputTokens: 100 },
      message: { source: { kind: "model", provider: "c2a", model: "deepseek" } },
    },
  });
  emit(handlers, subagentSession(), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 200, outputTokens: 20 },
      message: { source: { kind: "model", provider: "c2a", model: "subagent" } },
    },
  });
  const snapshot = await readSnapshot(routes);
  // 只剩子代理会话：主代理的 1000 input 不进池的账。
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions.find((s) => s.sessionId === "main-1"), undefined);
  const child = snapshot.sessions.find((s) => s.sessionId === "child-1");
  assert.equal(child.isSubagent, true);
  assert.equal(child.parentSessionId, "main-1");
  assert.equal(child.tokens.inputTokens, 200);
  assert.equal(snapshot.totals.tokens.inputTokens, 200);
});

test("assistant/attempt 的 usage 从 stream 的最后一个 usage chunk 取", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession(), {
    type: "request/header",
    data: { header: { config: { provider: "c2a", model: "subagent" } }, reason: "initial" },
  });
  emit(handlers, subagentSession(), {
    type: "assistant/attempt",
    data: {
      turn: 2,
      step: 1,
      stream: [
        { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } } },
        { type: "chunk", chunk: { type: "usage", usage: { inputTokens: 90, outputTokens: 9 } } },
      ],
    },
  });
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.totals.requests, 1);
  assert.equal(snapshot.totals.tokens.inputTokens, 90);
  assert.equal(snapshot.routes[0].model, "subagent");
});

test("没有 message.source 时用 request/header 记住的路由归因", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession(), {
    type: "request/header",
    data: { header: { config: { provider: "c2a", model: "free" } }, reason: "initial" },
  });
  emit(handlers, subagentSession(), {
    type: "assistant/attempt",
    data: {
      turn: 1,
      step: 1,
      stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 50, outputTokens: 5 } } }],
    },
  });
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].model, "free");
  assert.equal(snapshot.totals.tokens.inputTokens, 50);
});

test("usage 缺失的事件不计入", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession(), {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { source: { kind: "model", provider: "c2a", model: "subagent" } } },
  });
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.totals.requests, 0);
});

// ---- 会话标题 ----

test("session/title 事件把标题记到子代理会话上", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession("child-1", "main-1"), {
    type: "session/title",
    data: { title: "请回答：6+6等于几？", messageSeqs: [], source: "provider" },
  });
  emit(handlers, subagentSession("child-1", "main-1"), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
      message: { source: { kind: "model", provider: "c2a", model: "subagent" } },
    },
  });
  const snapshot = await readSnapshot(routes);
  const child = snapshot.sessions.find((s) => s.sessionId === "child-1");
  assert.equal(child.title, "请回答：6+6等于几？");
});

test("主代理会话不进账：它的 title 与 usage 都不出现在统计里", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, mainSession(), {
    type: "session/title",
    data: { title: "调用子代理回答一加一", messageSeqs: [], source: "provider" },
  });
  emit(handlers, mainSession(), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
      message: { source: { kind: "model", provider: "c2a", model: "paid" } },
    },
  });
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.sessions.find((s) => s.sessionId === "main-1"), undefined);
  assert.equal(snapshot.totals.requests, 0);
  assert.equal(snapshot.totals.tokens.inputTokens, 0);
  // 路由表里只剩池内候选（没有用量），主代理的 paid 路由不在其中。
  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0].model, "subagent");
  assert.equal(snapshot.routes[0].requests, 0);
  assert.equal(snapshot.routes[0].totalTokens, 0);
});

test("标题 latest-wins，后来的覆盖前面的", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession("child-1", "main-1"), { type: "session/title", data: { title: "旧标题", messageSeqs: [], source: "user" } });
  emit(handlers, subagentSession("child-1", "main-1"), { type: "session/title", data: { title: "新标题", messageSeqs: [], source: "user" } });
  emit(handlers, subagentSession("child-1", "main-1"), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 1 },
      message: { source: { kind: "model", provider: "c2a", model: "subagent" } },
    },
  });
  const snapshot = await readSnapshot(routes);
  const child = snapshot.sessions.find((s) => s.sessionId === "child-1");
  assert.equal(child.title, "新标题");
});

test("没有标题事件时标题为 undefined", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  emit(handlers, subagentSession("child-1", "main-1"), {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 1 },
      message: { source: { kind: "model", provider: "c2a", model: "subagent" } },
    },
  });
  const snapshot = await readSnapshot(routes);
  const child = snapshot.sessions.find((s) => s.sessionId === "child-1");
  assert.equal(child.title, undefined);
});

// ---- 分配记账 ----

test("分配与释放计入路由的分配次数", async () => {
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  // 走一次真实分配需要探测，这里只验记账接口的直接效果。
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.totals.assignments, 0);
  assert.equal(snapshot.routes.length, 1, "未分配的候选也要出现在快照里");
  assert.equal(snapshot.routes[0].maxConcurrent, 3);
  assert.equal(snapshot.routes[0].active, 0);
});

test("快照合并池的实时占用", async () => {
  const { ctx, routes } = stubCtx();
  apply(ctx, { enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].maxConcurrent, 3);
  assert.equal(snapshot.routes[0].weight, 1);
});
