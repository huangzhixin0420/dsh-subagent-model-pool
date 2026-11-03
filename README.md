# dsh-subagent-model-pool

子代理模型池：按并发占用在多个候选模型间分配，同一子代理派发后模型锁定。

带 Web GUI 设置页，候选模型从 DSH 的实时模型目录里勾选。

![设置页](docs/settings.png)

## 行为

- 子代理**首次**发起模型请求时，从池里挑一个模型，此后全程锁定（`request/header` 落盘即基线）。
- 每个候选有独立的 `maxConcurrent`（默认 **3**），语义是**并发占用数**，不是累计次数。
- 占用由 `subagent/end` 释放，按 `runId` 幂等。冷恢复会开新 run，各自独立计数。
- 池全满、预检失败或子代理被显式指定模型时，**静默回退父会话路由**，永不阻断子代理。

## 配置

插件自带的 `cordis.patch.yml` 提供默认配置，profile 层用顶层 `- id:` 覆盖（**必须带 `name`**，原因见「安装」）：

```yaml
- id: subagent-model-pool
  name: dsh-subagent-model-pool
  config:
    enabled: true
    strategy: fewest-active      # 或 least-recently-used
    pools:
      - provider: c2a
        model: subagent
        maxConcurrent: 3
      - provider: c2a
        model: free
        maxConcurrent: 3
```

也可以直接用设置页改，无需手写 YAML。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后所有子代理沿用父路由 |
| `strategy` | `fewest-active` | `fewest-active` 挑当前占用最少的；`least-recently-used` 挑最久未被占用的 |
| `pools[].provider` / `.model` | 必填 | 候选路由 |
| `pools[].maxConcurrent` | `3` | 该模型同时可被几个子代理占用 |

策略在初始态（全员 `active=0`）按**配置数组顺序**做稳定 tiebreak，保证并发首次派发不打散。

## 排除规则

以下子代理不参与池化，直接走原路由：

- 非子代理（`header.origin !== "subagent"` 或无 `parentSession`）——保护主会话的模型切换。
- `fork` 子代理——它继承父对话前缀，换模型会作废 KV 缓存。
- 显式指定了模型的子代理（`agent.options.model` 与父路由不同）——主模型是有意为之。

## 安装

三步，缺一不可。**注册方式错了插件会静默不挂载**（服务正常启动、零报错、设置页也不出现）。

1. 建软链：

```bash
ln -s /path/to/dsh-subagent-model-pool ~/.dsh/profiles/web/node_modules/dsh-subagent-model-pool
```

2. 在 profile 的 `package.json` 里同时登记依赖与 bundle：

```json
{
  "dependencies": {
    "dsh-subagent-model-pool": "link:/path/to/dsh-subagent-model-pool"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-subagent-model-pool"]
    }
  }
}
```

`bundles` 列表决定插件自己的 `cordis.patch.yml`（里面是 `- insert:`）是否被应用；只有 `dependencies` 而没有 `bundles`，插件不会进配置树。

3. 插件 entry 由它自己的 bundle patch 注册，profile 的 `cordis.patch.yml` 里**只用顶层 `- id:` 覆盖 config**，且**必须带 `name`**：

```yaml
- id: subagent-model-pool
  name: dsh-subagent-model-pool
  config:
    enabled: true
    strategy: fewest-active
    pools:
      - provider: c2a
        model: subagent
        maxConcurrent: 3
```

两个坑都在 `dsh-config-editor` 的 `edit`：

- 带 `config` 的 `- insert:` 会让设置页保存失败——`edit` 只改顶层条目，insert 块里的旧 config 残留，触发 `overridden` 守卫。
- 顶层条目缺 `name` 会让设置页保存时追加**重复条目**——`edit`（`dsh-config-editor/lib/index.js:98`）用 `id` + `name` 双条件匹配。

自检：

```bash
dsh --dump-config --profile web | grep -c "^- id: subagent-model-pool"   # 必须是 1
dsh --dump-config --profile web | grep "^# == dsh-subagent-model-pool"   # 必须有 bundle 段
```

重启 web 服务生效（macOS launchd；其他方式启动的话重启对应进程即可）：

```bash
launchctl kickstart -k gui/$(id -u)/com.leo.dsh-web
```

## 设置页

「设置」→「子代理模型池」：

- **启用开关**
- **分配策略**：`fewest-active` / `least-recently-used`
- **候选模型**：交互式复选框列表，候选来自 `llm` 的实时模型目录（按 provider 分组）。勾选即加入池，已勾选项右侧可单独设 `maxConcurrent`。

改动后点「保存」写回 `cordis.patch.yml`。全部占满时回退父会话路由。

### 实现细节

- `Config` 必须带顶层 `.volatile()`。`dsh-settings` 的 `describe()` 用 `volatileForm` 过滤命名空间（`dsh-settings/lib/index.js:122-131`），不含 volatile 的 schema 根本不会出现在设置里。
- **带 `.volatile()` 后，`apply(ctx, config)` 收到的不是普通对象，而是 cosmokit 的 volatile 引用** `{ get(), [Symbol.for("cosmokit.volatile.write")] }`（`schemastery/lib/index.mjs:480` → `cosmokit createVolatile`）。直接读 `config.pools` 永远是 `undefined`，插件会静默不装配——必须用 `config.get()` 解包。设置页保存后 `dsh-settings` 通过 `[write]` 更新该引用，所以 `get()` 每次都能读到最新值。
- **数组字段不要走 `SettingsFormModel` 的标量 field**。它的 field 工厂只表达标量，`format` 把数组序列化成字符串后，回读时类型已经丢了。正确做法是本地草稿 + `scope.mutate([{op:"set", path:["pools"], value}])` 直接写，参照内置 `dsh-client-ui-settings-subagent` 的模型多选卡。
- `actions()` 只暴露 `edit` / `resetField` / `discard`，**没有读取待提交队列的入口**。所以标量（策略）交给 `form.save()`，数组（池）由控制器自己 `scope.mutate`，两者分开提交。
- `exports.inject` 必须包含 `remote` 和 `remote.session`，否则读 `ctx.remote.session.modelCatalog()` 会抛 `cannot get property "remote" without inject`，**整个客户端条目 boot 失败**（页面显示 `1 entry did not activate`）。
- 模型目录里已不存在的候选仍要渲染（标记「已下线」），否则用户既看不到也删不掉它。
- 候选键用 `JSON.stringify([provider, model])` 而不是 `${provider}\0${model}`：后者在任一侧自带分隔符时会碰撞。
- 配置热更新：volatile 引用的写入无法订阅，所以在每次 `agent/request` 前比对配置指纹（`signatureOf`），变了就整体换池。设置页改完**无需重启**。

## 实测验证（2026-11-02 ~ 11-03）

分配行为：

| 场景 | 分配结果 |
|---|---|
| 单独派发 | `c2a/subagent` |
| 两个并发 | `c2a/subagent` + `c2a/free` |
| 前两者释放后再派 | `c2a/subagent` |

设置页（浏览器实测）：

| 操作 | 结果 |
|---|---|
| 打开设置页 | 左侧导航出现「子代理模型池」；候选以复选框呈现，按 provider 分组，4 个 c2a 模型全部列出 |
| 勾选 `c2a/paid` | 该行右侧出现「并发上限」输入框（默认 3），汇总变「已选 3 个候选」，保存按钮启用 |
| 上限改 5 后保存 | `cordis.patch.yml` 新增 `paid / maxConcurrent: 5`；按钮回 disabled，无失败提示 |
| 取消勾选 | 该行上限框消失，保存后条目被移除 |
| 改 `maxConcurrent` 等于继承值保存 | 条目被删除，回落到 bundle 默认值——这是 `edit` 的正确语义 |

测试：`node --test tests/*.test.js`，45 项全通过。


## 实现要点

- 监听装在**无 scope tag** 的插件 ctx 上，才能收到全部子/孙代理事件（`dsh-scope/lib/index.js:332`）。
- `agent/request` 用 `{ prepend: true }` 注册——同 agent 上后注册者在内层，返回值会被外层覆盖。
- 返回值**必须剥掉 `reasoningEffort`**：子代理没有 `installModelSelection` 代为剥除，保留会抛 `UNSUPPORTED_REASONING_EFFORT`（`dsh-llm/lib/index.js:2188-2199`）。
- 三态守卫：无 `request/header` → 首次分配；有且等于记录 → 放行；有但不等（冷恢复退回父路由）→ 重新注入。
- 选、占、记在同一同步块内完成，中间不 `await`——workflow 并发 fan out 否则会超发。

## 开发

需要 Node ≥ 20.18。`index.js` / `lib/**` 从 dsh 自带目录导入 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`，所以本地跑测试要先建软链：

```bash
DSH_ROOT=~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
mkdir -p node_modules/@deepseek-ai
ln -s "$DSH_ROOT/cordis"      node_modules/@deepseek-ai/cordis
ln -s "$DSH_ROOT/schemastery" node_modules/@deepseek-ai/schemastery
```

然后：

```bash
node --test tests/*.test.js
```

`client.js` 是浏览器半身，测试用最小 `window` 桩加载，不依赖 DOM。

## License

MIT
