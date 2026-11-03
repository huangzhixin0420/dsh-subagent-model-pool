// 设置页纯逻辑测试：不依赖 DOM 与宿主模块加载器。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** 取出 factory 导出的 __test 出口。 */
function loadTestExports() {
  let captured;
  const windowStub = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  const runtime = { jsx: () => null, jsxs: () => null };
  const requireStub = () => runtime;
  new Function("window", "document", source)(windowStub, undefined);
  assert.ok(captured, "模块未被 __ModuleLoader__ 捕获");
  const module = captured.factory(requireStub);
  return module.__test;
}

test("client 声明插件 id 与 inject", () => {
  let captured;
  const windowStub = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  new Function("window", "document", source)(windowStub, undefined);
  assert.equal(captured.id, "dsh-subagent-model-pool");
});

test("inject 声明 slots / remote / configForms", () => {
  let captured;
  const windowStub = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
  new Function("window", "document", source)(windowStub, undefined);
  const module = captured.factory(() => ({ jsx: () => null, jsxs: () => null }));
  // remote / remote.session 是读模型目录的前置，漏了会让整个条目 boot 失败。
  assert.deepEqual(module.inject, ["slots", "remote", "remote.session", "configForms"]);
});

// ---- normalizePools ----

test("normalizePools 保留合法项", () => {
  const { normalizePools } = loadTestExports();
  const out = normalizePools([
    { provider: "c2a", model: "subagent", maxConcurrent: 3 },
    { provider: "c2a", model: "free", maxConcurrent: 5 },
  ]);
  assert.deepEqual(out, [
    { provider: "c2a", model: "subagent", maxConcurrent: 3, weight: 1 },
    { provider: "c2a", model: "free", maxConcurrent: 5, weight: 1 },
  ]);
});

test("normalizePools 保留合法权重，非法回落 1", () => {
  const { normalizePools } = loadTestExports();
  const out = normalizePools([
    { provider: "c2a", model: "a", maxConcurrent: 3, weight: 8 },
    { provider: "c2a", model: "b", maxConcurrent: 3, weight: 0 },
    { provider: "c2a", model: "c", maxConcurrent: 3, weight: -2 },
    { provider: "c2a", model: "d", maxConcurrent: 3, weight: 2.5 },
  ]);
  assert.deepEqual(out.map((e) => e.weight), [8, 1, 1, 1]);
});

test("normalizePools 缺 maxConcurrent 时补默认值", () => {
  const { normalizePools, DEFAULT_MAX_CONCURRENT } = loadTestExports();
  const out = normalizePools([{ provider: "c2a", model: "x" }]);
  assert.equal(out[0].maxConcurrent, DEFAULT_MAX_CONCURRENT);
});

test("normalizePools 丢弃非法项而不是整体失败", () => {
  const { normalizePools } = loadTestExports();
  const out = normalizePools([
    { provider: "c2a", model: "ok" },
    { provider: "", model: "bad" },
    { model: "no-provider" },
    null,
    "junk",
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].model, "ok");
});

test("normalizePools 对非数组返回空数组", () => {
  const { normalizePools } = loadTestExports();
  assert.deepEqual(normalizePools(undefined), []);
  assert.deepEqual(normalizePools(null), []);
  assert.deepEqual(normalizePools({ provider: "c2a" }), []);
});

test("normalizePools 修正非法 maxConcurrent（0 / 小数 / 负数）", () => {
  const { normalizePools, DEFAULT_MAX_CONCURRENT } = loadTestExports();
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const out = normalizePools([{ provider: "c2a", model: "x", maxConcurrent: bad }]);
    assert.equal(out[0].maxConcurrent, DEFAULT_MAX_CONCURRENT, `bad=${String(bad)}`);
  }
});

// ---- buildGroups ----

/** 造一份模型目录。 */
const catalog = [
  {
    id: "c2a",
    name: "c2a",
    models: [
      { id: "subagent", name: "Subagent" },
      { id: "free", name: "Free" },
      { id: "vision", name: "Vision" },
    ],
  },
  { id: "deepseek-official", name: "DeepSeek", models: [{ id: "chat", name: "Chat" }] },
];

test("buildGroups 按目录分组并标注选中态", () => {
  const { buildGroups } = loadTestExports();
  const groups = buildGroups(catalog, [{ provider: "c2a", model: "free", maxConcurrent: 4 }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].id, "c2a");
  assert.equal(groups[0].rows.length, 3);
  const free = groups[0].rows.find((r) => r.model === "free");
  assert.equal(free.selected, true);
  assert.equal(free.maxConcurrent, 4);
  const other = groups[0].rows.find((r) => r.model === "subagent");
  assert.equal(other.selected, false);
});

test("buildGroups 未选中的候选给默认并发上限", () => {
  const { buildGroups, DEFAULT_MAX_CONCURRENT } = loadTestExports();
  const groups = buildGroups(catalog, []);
  assert.equal(groups[0].rows[0].maxConcurrent, DEFAULT_MAX_CONCURRENT);
});

test("buildGroups 保留已下线的候选并标记 stale", () => {
  const { buildGroups } = loadTestExports();
  const groups = buildGroups(catalog, [{ provider: "c2a", model: "retired", maxConcurrent: 2 }]);
  const stale = groups.find((g) => g.name === "已不在模型目录中");
  assert.ok(stale, "应出现下线分组");
  assert.equal(stale.rows.length, 1);
  assert.equal(stale.rows[0].selected, true);
  assert.equal(stale.rows[0].stale, true);
});

test("buildGroups 目录为空时只显示下线候选", () => {
  const { buildGroups } = loadTestExports();
  const groups = buildGroups([], [{ provider: "c2a", model: "x", maxConcurrent: 3 }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows[0].stale, true);
});

test("buildGroups 全空时返回空数组", () => {
  const { buildGroups } = loadTestExports();
  assert.deepEqual(buildGroups([], []), []);
});

test("buildGroups 跳过没有模型的 provider 分组", () => {
  const { buildGroups } = loadTestExports();
  const groups = buildGroups([{ id: "empty", name: "Empty", models: [] }], []);
  assert.equal(groups.length, 0);
});

// ---- poolKey ----

test("poolKey 不会因分隔符碰撞", () => {
  const { poolKey } = loadTestExports();
  // NUL 拼接会让这两组撞成同一个键；JSON 编码不会。
  assert.notEqual(poolKey("a", "b\u0000c"), poolKey("a\u0000b", "c"));
  assert.equal(poolKey("c2a", "subagent"), poolKey("c2a", "subagent"));
  assert.notEqual(poolKey("c2a", "subagent"), poolKey("c2a", "free"));
});

test("poolKey 的键能被 buildGroups 正确回填选中态", () => {
  const { buildGroups, poolKey } = loadTestExports();
  const groups = buildGroups(catalog, [{ provider: "deepseek-official", model: "chat", maxConcurrent: 2 }]);
  const ds = groups.find((g) => g.id === "deepseek-official");
  assert.equal(ds.rows[0].key, poolKey("deepseek-official", "chat"));
  assert.equal(ds.rows[0].selected, true);
});
