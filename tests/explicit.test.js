import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPLICIT_OPTION_KEY,
  hasExplicitRoute,
  patchStartActivation,
  stampExplicitRoute,
} from "../lib/explicit.js";

test("纯继承调用不创建 agentOptions，也不打标", () => {
  const spec = { provider: "spawn", request: { prompt: [] } };
  assert.equal(stampExplicitRoute(spec), spec);
  assert.equal(spec.request.agentOptions, undefined);
});

test("显式同路由在合并后仍可识别", () => {
  const parent = { provider: "c2a", model: "Intelligence" };
  const spec = {
    provider: "spawn",
    request: { agentOptions: { ...parent } },
  };
  const stamped = stampExplicitRoute(spec);
  assert.equal(stamped.request.agentOptions[EXPLICIT_OPTION_KEY], true);
  // 模拟内核对继承值与显式值的合并。
  const resolved = { ...parent, ...stamped.request.agentOptions };
  assert.equal(hasExplicitRoute({ options: resolved }), true);
  assert.deepEqual(
    { provider: resolved.provider, model: resolved.model },
    parent,
  );
});

test("内部标记不会通过父代理的已知路由字段遗传给孙代理", () => {
  const stamped = stampExplicitRoute({
    request: { agentOptions: { provider: "c2a", model: "chosen" } },
  });
  const parentOptions = stamped.request.agentOptions;
  // 与 resolveChildAgentOptions 一致：孙代只复制父代这些已知字段。
  const grandchild = {
    provider: parentOptions.provider,
    model: parentOptions.model,
  };
  assert.equal(hasExplicitRoute({ options: grandchild }), false);
});

test("startActivation 包装覆盖工具与 workflow 共用的调用边界", async () => {
  class Subagents {
    async startActivation(spec) { return spec; }
  }
  const service = new Subagents();
  const restore = patchStartActivation(service);
  assert.equal(typeof restore, "function");
  const result = await service.startActivation({
    request: { agentOptions: { provider: "c2a", model: "chosen" } },
  });
  assert.equal(result.request.agentOptions[EXPLICIT_OPTION_KEY], true);
  restore();
  restore();
  assert.equal(Object.hasOwn(service, "startActivation"), false);
});

test("不支持安全包装时明确失败，由调用方停用池分配", () => {
  const service = { startActivation: async (spec) => spec };
  assert.equal(patchStartActivation(service), undefined);
  assert.equal(patchStartActivation(undefined), undefined);
});
