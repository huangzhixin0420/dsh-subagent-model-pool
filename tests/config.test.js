// 插件入口的 Config 校验与配置读取测试。
//
// 两条硬约束（都曾踩坑）：
// 1. Config 顶层必须带 .volatile()，否则 dsh-settings 的 volatileForm 过滤掉
//    本命名空间，设置页根本不出现（dsh-settings/lib/index.js:122-131）。
// 2. 带 volatile 后 cordis 传给 apply 的不是普通对象，而是 cosmokit 的
//    volatile 引用 { get(), [write] }（schemastery:480 → createVolatile）。
//    直接读 config.pools 永远是 undefined，必须走 readConfig() 解包。
import test from "node:test";
import assert from "node:assert/strict";
import { Config, name, inject, apply, readConfig } from "../index.js";
import { ModelPool, VALIDATED_TTL_MS, REJECTED_TTL_MS } from "../lib/pool.js";

/** 按 cordis 的方式校验配置（resolveConfig 用 ~standard）。 */
function validate(input) {
  return Config["~standard"].validate(input);
}

test("Config 带顶层 volatile，否则设置页不可见", () => {
  assert.equal(Config.meta.volatile, true);
});

test("插件名与注入依赖", () => {
  assert.equal(name, "subagent-model-pool");
  assert.deepEqual(inject, ["llm", "agents"]);
});

test("合法配置不被拒绝", () => {
  const result = validate({
    enabled: true,
    strategy: "fewest-active",
    pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }],
  });
  assert.equal(result.issues, undefined);
});

test("strategy 用基础字符串类型（union 会让设置页保存失败）", () => {
  assert.equal(Config.dict.strategy.type, "string");
});

test("缺少 provider 被拒", () => {
  assert.notEqual(validate({ pools: [{ model: "x" }] }).issues, undefined);
});

test("maxConcurrent 小于 1 被拒", () => {
  assert.notEqual(
    validate({ pools: [{ provider: "c2a", model: "x", maxConcurrent: 0 }] }).issues,
    undefined,
  );
});

test("maxConcurrent 非整数被拒", () => {
  assert.notEqual(
    validate({ pools: [{ provider: "c2a", model: "x", maxConcurrent: 1.5 }] }).issues,
    undefined,
  );
});

// ---- apply 的兜底行为 ----

/** 造一个最小 ctx 桩，记录注册的监听。 */
function stubCtx() {
  const handlers = new Map();
  const logs = [];
  const probeCalls = [];
  const probeState = { impl: () => true };
  class Subagents {
    async startActivation(spec) { return spec; }
    getProvider() { return undefined; }
  }
  const subagents = new Subagents();
  const scope = {
    handlers,
    logs,
    probeCalls,
    subagents,
    set probeImpl(fn) { probeState.impl = fn; },
    ctx: {
      logger: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
      },
      on: (event, fn, opts) => { handlers.set(event, { fn, opts }); },
      inject: (_services, fn) => fn(scope.ctx),
      effect: () => {},
      // 可编程探测桩：probeImpl 决定 prepareCall 的行为，probeCalls 记录每次探测。
      get: (svc) => {
        if (svc === "llm") {
          return {
            prepareCall: async (config) => {
              probeCalls.push(`${config.provider}/${config.model}`);
              if (!probeState.impl(config)) {
                throw new Error("探测桩：模拟上游不可达");
              }
              return {
                config: { provider: config.provider, model: config.model },
                stream: async function* () {
                  yield { type: "text" };
                },
              };
            },
          };
        }
        if (svc === "agents") return { get: () => undefined };
        if (svc === "subagents") return subagents;
        return undefined;
      },
    },
  };
  return scope;
}

test("apply 始终注册监听（池空时在回调里放行，便于配置热更新）", () => {
  const { ctx, handlers, logs } = stubCtx();
  apply(ctx, { enabled: true, pools: [] });
  assert.ok(handlers.has("agent/created"), "池为空也要注册，否则改配置后无法生效");
  assert.ok(logs.some(([, m]) => /未启用或模型池为空/.test(m)));
});

test("apply 在 enabled=false 时也注册监听但日志说明不分配", () => {
  const { ctx, handlers, logs } = stubCtx();
  apply(ctx, { enabled: false, pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(handlers.has("agent/created"));
  assert.ok(logs.some(([, m]) => /未启用或模型池为空/.test(m)));
});

test("apply 缺省 enabled 视为启用", () => {
  const { ctx, logs } = stubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(logs.some(([, m]) => /装配 1 个候选/.test(m)));
});

test("apply 注册创建期分配与生命周期监听，不再改写 agent/request", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "x", maxConcurrent: 1 }] });
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ["agent/created", "agent/disposed", "subagent/end", "subagent/start"],
  );
  assert.equal(handlers.has("agent/request"), false);
});

test("apply 缺省 strategy 回落到 fewest-active", () => {
  const { ctx, logs } = stubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(logs.some(([, m]) => /fewest-active/.test(m)));
});

test("apply 遇到未知 strategy 也回落到 fewest-active", () => {
  const { ctx, logs } = stubCtx();
  apply(ctx, { strategy: "bogus", pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(logs.some(([, m]) => /fewest-active/.test(m)));
});

function volatileRef(value) {
  let current = value;
  return {
    get: () => current,
    [Symbol.for("cosmokit.volatile.write")]: (next) => { current = next; },
    __set: (next) => { current = next; },
  };
}

test("apply 能从 volatile 引用读到配置（否则插件形同虚设）", () => {
  const { ctx, logs } = stubCtx();
  apply(ctx, volatileRef({ enabled: true, pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] }));
  assert.ok(
    logs.some(([, m]) => /装配 1 个候选/.test(m)),
    `config 未被解包，实际日志：${JSON.stringify(logs)}`,
  );
});

test("apply 日志标明收到的是 volatile 引用", () => {
  const { ctx, logs } = stubCtx();
  apply(ctx, volatileRef({ enabled: true, pools: [] }));
  assert.ok(logs.some(([, m]) => /volatile 引用/.test(m)));
});

test("readConfig 对普通对象原样返回", () => {
  assert.deepEqual(readConfig({ a: 1 }), { a: 1 });
});

test("readConfig 对 volatile 引用解包", () => {
  assert.deepEqual(readConfig(volatileRef({ a: 1 })), { a: 1 });
});

test("readConfig 对 null/undefined 返回空对象", () => {
  assert.deepEqual(readConfig(null), {});
  assert.deepEqual(readConfig(undefined), {});
});
// ---- 真实请求探测（v0.3.0）----

/** 构造可编程 llm 桩：记录 prepareCall 次数，按模型决定探测成败。 */
function probeStubCtx({ failModels = [], delay = 0 } = {}) {
  const handlers = new Map();
  const logs = [];
  const activationSpecs = [];
  let prepareCalls = 0;
  const inflightSeen = [];
  class Subagents {
    async startActivation(spec) { activationSpecs.push(spec); return spec; }
    getProvider() { return undefined; }
  }
  const subagents = new Subagents();
  const ctx = {
    logger: {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
    },
    on: (event, fn, opts) => { handlers.set(event, { fn, opts }); },
    inject: (_services, fn) => fn(ctx),
    effect: () => {},
    get: (svc) =>
      svc === "llm"
        ? {
            async prepareCall(config) {
              prepareCalls += 1;
              inflightSeen.push(config.model);
              if (delay > 0) await new Promise((r) => setTimeout(r, delay));
              if (failModels.includes(config.model)) {
                throw new Error("upstream 503");
              }
              return {
                config: { provider: config.provider, model: config.model },
                async *stream() { yield { type: "text" }; },
              };
            },
          }
        : svc === "agents"
          ? { get: () => undefined }
          : svc === "subagents"
            ? subagents
            : undefined,
  };
  return {
    ctx, handlers, logs, subagents, activationSpecs,
    get prepareCalls() { return prepareCalls; },
  };
}

/** 构造刚创建、尚未准备首个 step 的子代理。 */
function childAgent(childId, options = {}) {
  let selected;
  const inherited = { provider: "c2a", model: "parent" };
  const agent = {
    id: childId,
    options: { ...inherited, ...options },
    session: {
      header: { origin: "subagent", parentSession: "parent-x" },
      requestHeader: () => undefined,
      snapshotEvents: () => [{ type: "subagent/descriptor", data: { provider: "spawn" } }],
    },
    model: {
      current: () => selected ?? agent.options,
      select: (route) => { selected = { provider: route.provider, model: route.model }; },
    },
  };
  return { agent, selected: () => selected };
}

/** 触发创建期分配，返回实际选中的路由。 */
async function allocate(ctx, handlers, childId, options = {}) {
  const { agent, selected } = childAgent(childId, options);
  await handlers.get("agent/created").fn({ agent, source: "startup" });
  return selected() ?? { provider: agent.options.provider, model: agent.options.model };
}

test("探测通过 → 分配该候选", async () => {
  const { ctx, handlers } = probeStubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 1 }] });
  const routed = await allocate(ctx, handlers, "child-1");
  assert.deepEqual(routed, { provider: "c2a", model: "subagent" });
});

test("探测失败 → 拉黑并换下一候选，全败回退父路由", async () => {
  const { ctx, handlers } = probeStubCtx({ failModels: ["subagent", "free"] });
  apply(ctx, {
    pools: [
      { provider: "c2a", model: "subagent", maxConcurrent: 1 },
      { provider: "c2a", model: "free", maxConcurrent: 1 },
    ],
  });
  const routed = await allocate(ctx, handlers, "child-1");
  assert.deepEqual(routed, { provider: "c2a", model: "parent" }, "全败应回退父路由");
});

test("并发分配同一候选只探测一次（in-flight 去重）", async () => {
  const stub = probeStubCtx({ delay: 30 });
  const { ctx, handlers } = stub;
  apply(ctx, { pools: [{ provider: "c2a", model: "subagent", maxConcurrent: 3 }] });
  await Promise.all([
    allocate(ctx, handlers, "child-a"),
    allocate(ctx, handlers, "child-b"),
    allocate(ctx, handlers, "child-c"),
  ]);
  assert.equal(stub.prepareCalls, 1, "三个并发分配应只发一次探测");
});

test("显式指定与父路由相同也绝不覆盖", async () => {
  const stub = probeStubCtx();
  const { ctx, handlers, subagents, activationSpecs } = stub;
  apply(ctx, { pools: [{ provider: "c2a", model: "free", maxConcurrent: 1 }] });
  await subagents.startActivation({
    provider: "spawn",
    request: { agentOptions: { provider: "c2a", model: "parent" } },
  });
  const options = activationSpecs[0].request.agentOptions;
  const routed = await allocate(ctx, handlers, "child-explicit-same", options);
  assert.deepEqual(routed, { provider: "c2a", model: "parent" });
  assert.equal(stub.prepareCalls, 0, "显式子代理不应触发池探测");
});

test("显式指定不同路由同样不覆盖", async () => {
  const stub = probeStubCtx();
  const { ctx, handlers, subagents, activationSpecs } = stub;
  apply(ctx, { pools: [{ provider: "c2a", model: "free", maxConcurrent: 1 }] });
  await subagents.startActivation({
    provider: "spawn",
    request: { agentOptions: { provider: "c2a", model: "chosen" } },
  });
  const routed = await allocate(
    ctx, handlers, "child-explicit-other", activationSpecs[0].request.agentOptions,
  );
  assert.deepEqual(routed, { provider: "c2a", model: "chosen" });
  assert.equal(stub.prepareCalls, 0);
});

test("显式标记拦截安装失败时停用池分配，不误覆盖", async () => {
  const stub = probeStubCtx();
  const { ctx, handlers } = stub;
  // own startActivation 让安全包装拒绝安装，模拟未来内核不兼容。
  Object.defineProperty(stub.subagents, "startActivation", {
    value: async (spec) => spec,
    configurable: true,
  });
  apply(ctx, { pools: [{ provider: "c2a", model: "free", maxConcurrent: 1 }] });
  const routed = await allocate(ctx, handlers, "child-untracked");
  assert.deepEqual(routed, { provider: "c2a", model: "parent" });
  assert.equal(stub.prepareCalls, 0);
});

test("冷恢复沿用已落盘路由，不重新探测或分配", async () => {
  const stub = probeStubCtx();
  const { ctx, handlers } = stub;
  apply(ctx, { pools: [{ provider: "c2a", model: "free", maxConcurrent: 1 }] });
  const { agent, selected } = childAgent("child-resume");
  const persisted = { provider: "c2a", model: "free" };
  agent.session.requestHeader = () => ({ config: persisted });
  agent.model.current = () => persisted;
  await handlers.get("agent/created").fn({ agent, source: "resume" });
  assert.equal(selected(), undefined);
  assert.equal(stub.prepareCalls, 0);
});

test("fork 子代理不参与池分配", async () => {
  const stub = probeStubCtx();
  const { ctx, handlers } = stub;
  apply(ctx, { pools: [{ provider: "c2a", model: "free", maxConcurrent: 1 }] });
  const { agent, selected } = childAgent("child-fork");
  agent.session.snapshotEvents = () => [
    { type: "subagent/descriptor", data: { provider: "fork" } },
  ];
  await handlers.get("agent/created").fn({ agent, source: "startup" });
  assert.equal(selected(), undefined);
  assert.equal(stub.prepareCalls, 0);
});

test("探测结果 60s 后过期可重探（REJECTED_TTL）", async (t) => {
  const { REJECTED_TTL_MS } = await import("../lib/pool.js");
  const { ModelPool } = await import("../lib/pool.js");
  const pool = new ModelPool([{ provider: "c2a", model: "x" }], "fewest-active");
  pool.markRejected("c2a\0x");
  assert.equal(pool.isRejected("c2a\0x"), true);
  // 把时间戳拨回 TTL 之前
  t.mock.timers.enable({ now: Date.now() + REJECTED_TTL_MS + 1000 });
  assert.equal(pool.isRejected("c2a\0x"), false, "过期后应允许重探");
});

test("探测通过 5min 后过期需重探（VALIDATED_TTL）", async (t) => {
  const { VALIDATED_TTL_MS, ModelPool } = await import("../lib/pool.js");
  const pool = new ModelPool([{ provider: "c2a", model: "x" }], "fewest-active");
  pool.markValidated("c2a\0x");
  assert.equal(pool.isValidated("c2a\0x"), true);
  t.mock.timers.enable({ now: Date.now() + VALIDATED_TTL_MS + 1000 });
  assert.equal(pool.isValidated("c2a\0x"), false, "过期后应重新探测");
});
