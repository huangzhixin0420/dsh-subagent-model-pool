// 插件入口的 Config 校验测试。
//
// 注意：Config 顶层带 .volatile()——那是设置页可见性的开关
// （dsh-settings/lib/index.js:122-131 的 volatileForm 过滤），代价是
// validate({}) 返回 {}，默认值不由 schema 填充。所以这里不测「默认值注入」，
// 而是测运行时真正依赖的约束：非法输入被拒、apply 对缺省 config 的兜底。
import test from "node:test";
import assert from "node:assert/strict";
import { Config, name, inject, apply } from "../index.js";

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

test("apply 在 pools 为空时不装配任何监听", () => {
  const { ctx, handlers, logs } = stubCtx();
  apply(ctx, { enabled: true, pools: [] });
  assert.equal(handlers.size, 0);
  assert.match(logs[0][1], /不装配/);
});

test("apply 在 enabled=false 时不装配", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, { enabled: false, pools: [{ provider: "c2a", model: "x" }] });
  assert.equal(handlers.size, 0);
});

test("apply 缺省 enabled 视为启用（volatile 下 config 可能不全）", () => {
  const { ctx, handlers } = stubCtx();
  apply(ctx, { pools: [{ provider: "c2a", model: "x" }] });
  assert.ok(handlers.has("agent/request"), "应注册 agent/request");
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
