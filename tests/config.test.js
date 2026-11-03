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
  return {
    handlers,
    logs,
    ctx: {
      logger: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
      },
      on: (event, fn, opts) => { handlers.set(event, { fn, opts }); },
      get: (svc) =>
        svc === "llm"
          ? { resolveModelInfo: async () => ({ id: "ok" }) }
          : svc === "agents"
            ? { get: () => undefined }
            : undefined,
    },
  };
}

test("apply 始终注册监听（池空时在回调里放行，便于配置热更新）", () => {
  const { ctx, handlers, logs } = stubCtx();
  apply(ctx, { enabled: true, pools: [] });
  assert.ok(handlers.has("agent/request"), "池为空也要注册，否则改配置后无法生效");
  assert.ok(logs.some(([, m]) => /未启用或模型池为空/.test(m)));
});

test("apply 在 enabled=false 时也注册监听但日志说明不分配", () => {
  const { ctx, handlers, logs } = stubCtx();
  apply(ctx, { enabled: false, pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(handlers.has("agent/request"));
  assert.ok(logs.some(([, m]) => /未启用或模型池为空/.test(m)));
});

test("apply 缺省 enabled 视为启用", () => {
  const { ctx, logs } = stubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(logs.some(([, m]) => /装配 1 个候选/.test(m)));
});

test("apply 注册四个监听，agent/request 带 prepend", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "x", maxConcurrent: 1 }] });
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ["agent/disposed", "agent/request", "subagent/end", "subagent/start"],
  );
  assert.deepEqual(handlers.get("agent/request").opts, { prepend: true });
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

// ---- volatile 引用解包（关键回归） ----

/** 造一个 cosmokit 风格的 volatile 引用。 */
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
