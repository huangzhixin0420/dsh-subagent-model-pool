// 换池迁移的集成测试：走真实的 apply() 链路。
//
// 覆盖的路径：volatile 配置变更 → currentPool() 发现指纹变化 → 重建池 →
// inherit(旧池) → 此后取数看到的 active 与并发上限。
//
// 不 mock 被测代码：index.js、lib/pool.js、lib/identity.js 都是真的，只 fake
// 宿主服务（llm 探测、subagents 拦截点、connection 取数路由）。
//
// 为什么必须做这一层：单元测试只证明 ModelPool.inherit 本身对，证明不了
// index.js 在换池时真的调了它。之前把 inherit 命名成 adopt 时，正是池上已
// 有同名方法导致它被静默覆盖——单元测试全绿，接线是断的。
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";

/** 让探测必过的假 llm：prepareCall 返回一个立刻吐首块的 stream。 */
function fakeLlm() {
  return {
    async prepareCall() {
      return {
        config: {},
        async *stream() {
          yield { type: "text", text: "pong" };
        },
      };
    },
  };
}

/**
 * 假的 subagents 服务。
 *
 * patchStartActivation 有两个硬条件：原型上有 startActivation、实例上没有
 * 自有同名属性。所以必须用 class 定义，不能用对象字面量。
 */
class FakeSubagents {
  startActivation(...args) {
    // 真实实现在这里选择 provider/model；测试只要它存在且可被包装。
    void args;
    return undefined;
  }

  getProvider(name) {
    // 不返回 inheritsParentContext，子代理解析为可池化，不是 fork。
    return { name };
  }
}

/** 造一个能跑 apply 的最小 ctx（比 stats-wiring 的更全：带 llm 与 subagents）。 */
function stubCtx() {
  const handlers = new Map();
  const routes = [];
  const subagents = new FakeSubagents();
  const llm = fakeLlm();
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: (event, fn) => { handlers.set(event, fn); },
    inject: (_services, fn) => fn(ctx),
    effect: () => {},
    get: (svc) => {
      if (svc === "llm") return llm;
      if (svc === "subagents") return subagents;
      if (svc === "connection") {
        return {
          fetch: {
            register: (route) => {
              routes.push(route);
              return () => {
                const i = routes.indexOf(route);
                if (i >= 0) routes.splice(i, 1);
              };
            },
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, handlers, routes };
}

/** 造一个可池化的子代理 agent。 */
function subagentAgent(id, provider = "c2a", model = "a") {
  const selected = [];
  return {
    id,
    session: {
      header: { origin: "subagent", parentSession: "main-1" },
      inheritedEventCount: 0,
      snapshotEvents: () => [
        { type: "subagent/descriptor", data: { provider, model } },
      ],
    },
    options: {},
    model: {
      current: () => undefined,
      select: (route) => { selected.push(route); },
    },
    selected,
  };
}

/** 读一次统计快照。 */
async function readSnapshot(routes) {
  const response = await routes[0].fetch();
  return response.json();
}

/** 造一份 volatile 配置：改动它等价于设置页保存。 */
function volatileConfig(initial) {
  let value = initial;
  return {
    get: () => value,
    set: (next) => { value = next; },
    current: () => value,
  };
}

const POOLS = [{ provider: "c2a", model: "a", maxConcurrent: 2 }];

test("改配置后池占用不丢（真实 apply 链路）", async () => {
  const config = volatileConfig({ enabled: true, strategy: "strict-priority", pools: [...POOLS] });
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, config);

  // 派一个子代理 → 分配成功，active 变 1
  const agent = subagentAgent("child-1");
  await handlers.get("agent/created")({ agent, source: "startup" });
  let snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].active, 1, "分配后应有 1 个占用");

  // 改配置（设置页保存）→ 下一次取数时 currentPool() 换池
  config.set({ enabled: true, strategy: "strict-priority", pools: [{ provider: "c2a", model: "a", maxConcurrent: 5 }] });
  snapshot = await readSnapshot(routes);

  assert.equal(snapshot.routes[0].maxConcurrent, 5, "配置应已生效");
  assert.equal(snapshot.routes[0].active, 1, "换池后占用不能归零");
  assert.equal(snapshot.health.migratedOccupancy, 1, "迁移计数应为 1");
  assert.equal(snapshot.health.poolGeneration, 1, "应记录换过 1 次池");
});

test("改配置后并发上限仍然生效，不能超发", async () => {
  const base = { provider: "c2a", model: "a", maxConcurrent: 1, weight: 1 };
  const config = volatileConfig({ enabled: true, strategy: "strict-priority", pools: [{ ...base }] });
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, config);

  await handlers.get("agent/created")({ agent: subagentAgent("child-1"), source: "startup" });
  let snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].active, 1);

  // 必须改一个 signatureOf 覆盖得到的字段才能真正换池：只改无关字段
  // （比如加个 note）指纹不变，池根本不重建，测试会假通过。
  // weight 不影响并发上限，改它正好隔离出「换池」这一个变量。
  config.set({ enabled: true, strategy: "strict-priority", pools: [{ ...base, weight: 2 }] });
  snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].active, 1, "占用保留");

  // 上限 1 已占满，第二个子代理应拿不到路由（回退，不分配）
  const second = subagentAgent("child-2");
  await handlers.get("agent/created")({ agent: second, source: "startup" });
  snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].active, 1, "不能因为换池就超发");
  assert.equal(snapshot.totals.assignments, 1, "第二个子代理不应被分配到池");
  assert.equal(snapshot.totals.fallbacks, 1, "应记为回退");
});

test("换池后子代理结束能正常释放，不泄漏", async () => {
  const config = volatileConfig({ enabled: true, strategy: "strict-priority", pools: [...POOLS] });
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, config);

  await handlers.get("agent/created")({ agent: subagentAgent("child-1"), source: "startup" });
  config.set({ enabled: true, strategy: "strict-priority", pools: [{ provider: "c2a", model: "a", maxConcurrent: 9 }] });
  let snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].active, 1, "换池后仍占着");

  // 旧 run 结束 → 释放要打在新池上
  handlers.get("subagent/end")({ id: "child-1", runId: "run-1", stopReason: "completed" });
  snapshot = await readSnapshot(routes);
  assert.equal(snapshot.routes[0].active, 0, "释放后归零，不泄漏");
});

test("候选被删掉时占用丢弃，不记到别的候选上", async () => {
  const config = volatileConfig({
    enabled: true,
    strategy: "strict-priority",
    pools: [{ provider: "c2a", model: "a", maxConcurrent: 2 }, { provider: "c2a", model: "b", maxConcurrent: 2 }],
  });
  const { ctx, handlers, routes } = stubCtx();
  apply(ctx, config);

  await handlers.get("agent/created")({ agent: subagentAgent("child-1", "c2a", "a"), source: "startup" });

  // 把候选 a 从配置里删掉
  config.set({ enabled: true, strategy: "strict-priority", pools: [{ provider: "c2a", model: "b", maxConcurrent: 2 }] });
  const snapshot = await readSnapshot(routes);

  // 注意：快照的 routes 是「账本里出现过的路由」，不只是当前池内候选——
  // 所以按 inPool 过滤，不能用 length 判池大小。
  const inPool = snapshot.routes.filter((r) => r.inPool === true);
  assert.equal(inPool.length, 1, "当前池只剩候选 b");
  assert.equal(inPool[0].model, "b");
  assert.equal(inPool[0].active, 0, "a 的占用不能记到 b 上");
  // a 仍然在账本里（它确实被用过），只是不再是池内候选
  const stale = snapshot.routes.find((r) => r.model === "a");
  assert.ok(stale, "用过的路由留在账本里");
  assert.equal(stale.inPool, false);
  assert.equal(snapshot.health.migratedOccupancy, 0, "无处归属的占用不迁移");
});

test("配置没变时不换池", async () => {
  const config = volatileConfig({ enabled: true, strategy: "strict-priority", pools: [...POOLS] });
  const { ctx, routes } = stubCtx();
  apply(ctx, config);

  await readSnapshot(routes);
  await readSnapshot(routes);
  await readSnapshot(routes);
  const snapshot = await readSnapshot(routes);
  assert.equal(snapshot.health.poolGeneration, 0, "指纹没变就不该重建池");
});
