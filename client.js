// 子代理模型池 —— Web GUI 设置页（客户端半身）。
//
// 手写 ModuleLoader 客户端，与 auto-vision-bridge 同一套契约：
// dsh.client.platform = "web" + exports.apply/inject。
//
// 配置落在 cordis.patch.yml 的 subagent-model-pool.config 里，
// 通过 ctx.configForms.get("subagent-model-pool") 读写同一个 scope。
//
// 模型池是交互式列表：候选来自 llm 的实时模型目录（ctx.remote.session.modelCatalog），
// 勾选即加入池，每个候选项可单独设 maxConcurrent。数组直接走 scope.mutate 写入，
// 参考内置 dsh-client-ui-settings-subagent 的模型多选卡。
(function () {
  var SETTINGS_NS = "subagent-model-pool";
  var STRATEGIES = ["fewest-active", "least-recently-used", "strict-priority"];
  var DEFAULT_MAX_CONCURRENT = 3;

  window.__ModuleLoader__.load({
    id: "dsh-subagent-model-pool",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var jsxRuntime = require("react/jsx-runtime");
      var react = require("react");
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useMemo = react.useMemo;
      var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      var jsx = jsxRuntime.jsx;
      var jsxs = jsxRuntime.jsxs;

      var CSS = [
        ".smp-settings{padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
        ".smp-header{margin-bottom:12px}",
        ".smp-title{margin:0;font-size:14px;line-height:20px}",
        ".smp-description{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
        ".smp-control{display:grid;gap:6px;margin-top:12px}",
        ".smp-label{font-size:13px;line-height:20px}",
        ".smp-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".smp-error{margin:4px 0 0;color:var(--dsw-alias-state-error-primary, #d33);font-size:12px;line-height:18px}",
        ".smp-toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px;font-size:13px;line-height:20px}",
        // 候选列表
        ".smp-pool{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);display:grid;gap:2px;max-height:320px;overflow:auto;padding:6px;margin:0}",
        ".smp-group{border-top:.5px solid var(--dsw-alias-border-l3);display:grid;gap:2px;padding-top:6px;margin-top:4px}",
        ".smp-group:first-child{border-top:0;margin-top:0;padding-top:0}",
        ".smp-provider{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;padding:2px 6px}",
        ".smp-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;border-radius:var(--dsw-radius-md);padding:5px 6px;min-width:0}",
        ".smp-row:hover{background:var(--dsw-alias-bg-layer-4)}",
        ".smp-rowMain{min-width:0;display:grid;gap:1px;cursor:pointer}",
        ".smp-model{color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".smp-route{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".smp-limit{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
        ".smp-num{box-sizing:border-box;width:44px;padding:3px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-background-primary);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;text-align:center}",
        ".smp-num:focus{outline:2px solid var(--dsw-alias-focus);outline-offset:1px}",
        ".smp-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:10px 6px;text-align:center}",
        ".smp-summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}",
        ".smp-status{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".smp-strategy{display:grid;gap:6px;margin-top:12px}",
        ".smp-strategyRow{display:flex;align-items:center;gap:10px}",
        ".smp-strategyBtn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-background-primary);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;cursor:pointer}",
        ".smp-strategyBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4)}",
        ".smp-strategyBtn:disabled{opacity:.5;cursor:not-allowed}",
        ".smp-strategyChevron{width:12px;height:12px;color:var(--dsw-alias-label-tertiary)}",
        ".smp-strategyItem{display:grid;gap:1px;min-width:220px}",
        ".smp-strategyName{font-size:13px}",
        ".smp-strategyDesc{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
        ".smp-overridden{color:var(--dsw-alias-state-warning-primary, #b8860b);font-size:11px}",
        ".smp-reset{background:none;border:0;padding:0;color:var(--dsw-alias-brand-primary);font-size:12px;cursor:pointer}"
      ].join("");
      if (typeof document !== "undefined" && typeof document.querySelector === "function"
        && document.querySelector("style[data-subagent-model-pool-css]") === null) {
        var style = document.createElement("style");
        style.setAttribute("data-subagent-model-pool-css", "true");
        style.textContent = CSS;
        document.head.appendChild(style);
      }

      var LABELS = {
        unavailable: "插件当前未运行，暂时无法配置。",
        readOnly: "当前部署的配置为只读。",
        saveFailed: "保存失败，请检查填写内容后重试。",
        save: "保存",
        saving: "保存中…"
      };

      /**
       * 候选路由的身份键；只用于查找，不做解析。
       *
       * 用 JSON 编码而不是 NUL 拼接：后者在 provider/model 自带分隔符时
       * 会碰撞（a + "b\0c" 与 "a\0b" + c 同键）。
       */
      function poolKey(provider, model) {
        return JSON.stringify([provider, model]);
      }

      /** 从 poolKey 还原出 { provider, model }。 */
      function parsePoolKey(key) {
        var parts = JSON.parse(String(key));
        return { provider: parts[0], model: parts[1] };
      }

      /** 把池配置归一成 { provider, model, maxConcurrent } 数组。 */
      function normalizePools(raw) {
        if (!Array.isArray(raw)) return [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var entry = raw[i];
          if (typeof entry !== "object" || entry === null) continue;
          if (typeof entry.provider !== "string" || entry.provider.length === 0) continue;
          if (typeof entry.model !== "string" || entry.model.length === 0) continue;
          var limit = entry.maxConcurrent;
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
            limit = DEFAULT_MAX_CONCURRENT;
          }
          var weight = entry.weight;
          out.push({
            provider: entry.provider,
            model: entry.model,
            maxConcurrent: limit,
            weight: typeof weight === "number" && Number.isInteger(weight) && weight >= 1 ? weight : 1
          });
        }
        return out;
      }

      /**
       * 合并「实时模型目录」与「已配置但目录里已消失的路由」。
       *
       * 已下线的候选仍要显示，否则用户既看不到它、也没法删掉它。
       * @param groups - modelCatalog 的 provider 分组。
       * @param pools - 当前池配置。
       * @returns 供渲染的分组，每项带 selected/maxConcurrent。
       */
      function buildGroups(groups, pools) {
        var stored = {};
        for (var i = 0; i < pools.length; i++) stored[poolKey(pools[i].provider, pools[i].model)] = pools[i];
        var seen = {};
        var out = [];
        for (var g = 0; g < groups.length; g++) {
          var group = groups[g];
          var rows = [];
          for (var m = 0; m < group.models.length; m++) {
            var model = group.models[m];
            var key = poolKey(group.id, model.id);
            seen[key] = true;
            rows.push({
              key: key,
              provider: group.id,
              model: model.id,
              name: model.name || model.id,
              selected: stored[key] !== undefined,
              maxConcurrent: stored[key] ? stored[key].maxConcurrent : DEFAULT_MAX_CONCURRENT,
              weight: stored[key] && stored[key].weight ? stored[key].weight : 1
            });
          }
          if (rows.length > 0) out.push({ id: group.id, name: group.name || group.id, rows: rows });
        }
        // 目录里已不存在、但配置里还留着的候选，单独列在末尾以便移除。
        var orphans = [];
        for (var p = 0; p < pools.length; p++) {
          var pool = pools[p];
          var poolId = poolKey(pool.provider, pool.model);
          if (seen[poolId]) continue;
          orphans.push({
            key: poolId,
            provider: pool.provider,
            model: pool.model,
            name: pool.model,
            selected: true,
            stale: true,
            maxConcurrent: pool.maxConcurrent,
            weight: pool.weight ? pool.weight : 1
          });
        }
        if (orphans.length > 0) out.push({ id: "\u0000stale", name: "已不在模型目录中", rows: orphans });
        return out;
      }

      /**
       * 控制器：模型池用本地草稿 + scope.mutate 直接写数组。
       *
       * 不走 SettingsFormModel 的标量 field，因为它的 field 工厂只能表达标量；
       * 数组走 mutate，与内置 subagent 模型多选卡一致。
       */
      function ModelPoolController(scope, ctx) {
        var self = this;
        this.scope = scope;
        this.ctx = ctx;
        this.catalogGroups = [];
        this.catalogStatus = "idle";
        this.catalogFailure = undefined;
        this.draft = undefined;      // 草稿池；undefined 表示未改动
        this.saving = false;
        this.failed = false;
        this.form = new primitives.SettingsFormModel(scope, [
          primitives.settingsTextField("strategy")
        ]);
        this.actions = this.form.actions();
        this.store = this.form.bind(function () { return self.projection(); });
        this.unsubscribe = scope.subscribe(function () {
          if (self.catalogStatus === "idle") self.loadCatalog();
          self.store.set(self.projection());
        });
        if (this.catalogStatus === "idle") this.loadCatalog();
      }

      /** 当前生效的池配置（来自 Host）。 */
      ModelPoolController.prototype.currentPools = function () {
        var snapshot = this.scope.getSnapshot();
        return normalizePools(snapshot && snapshot.value ? snapshot.value.pools : undefined);
      };

      /** 渲染用的池：草稿优先。 */
      ModelPoolController.prototype.desiredPools = function () {
        return this.draft === undefined ? this.currentPools() : this.draft;
      };

      ModelPoolController.prototype.isDirty = function () {
        if (this.draft === undefined) return false;
        var current = this.currentPools();
        var desired = this.draft;
        if (current.length !== desired.length) return true;
        for (var i = 0; i < current.length; i++) {
          if (current[i].provider !== desired[i].provider) return true;
          if (current[i].model !== desired[i].model) return true;
          if (current[i].maxConcurrent !== desired[i].maxConcurrent) return true;
          if (current[i].weight !== desired[i].weight) return true;
        }
        return false;
      };

      ModelPoolController.prototype.projection = function () {
        var mirrored = this.scope.getSnapshot();
        var raw = mirrored && mirrored.value ? mirrored.value : {};
        var pools = this.desiredPools();
        var shell = this.form.shell();
        var dirty = this.isDirty() || shell.dirty === true;
        return {
          available: mirrored === undefined || mirrored === null ? true : mirrored.status === "ready",
          writable: mirrored === undefined || mirrored === null ? true : mirrored.writable !== false,
          dirty: dirty,
          saving: this.saving,
          failed: this.failed,
          enabled: raw.enabled !== false,
          strategy: this.form.field("strategy"),
          groups: buildGroups(this.catalogGroups, pools),
          catalogStatus: this.catalogStatus,
          catalogFailure: this.catalogFailure,
          poolCount: pools.length,
          // 汇总面板的文字
          summary: pools.length === 0
            ? "池为空，子代理会直接使用父会话的模型。"
            : "已选 " + pools.length + " 个候选，各自并发上限见右侧。"
        };
      };

      /** 载入实时模型目录。 */
      ModelPoolController.prototype.loadCatalog = function () {
        var self = this;
        if (this.catalogStatus === "loading") return;
        // ctx.remote 是 cordis 服务代理，未 inject 时读属性会直接抛，必须先兜住。
        var remote;
        try {
          remote = this.ctx && this.ctx.remote;
        } catch (error) {
          remote = undefined;
        }
        if (!remote || !remote.session || typeof remote.session.modelCatalog !== "function") {
          this.catalogStatus = "error";
          this.catalogFailure = "当前会话不支持模型目录，无法列出候选。";
          this.store.set(this.projection());
          return;
        }
        this.catalogStatus = "loading";
        this.store.set(this.projection());
        Promise.resolve(remote.session.modelCatalog()).then(function (response) {
          if (response && response.ok && response.value) {
            self.catalogGroups = response.value.groups || [];
            self.catalogStatus = "ready";
            self.catalogFailure = (response.value.failures || []).length > 0
              ? "部分 provider 读取失败：" + response.value.failures.map(function (f) { return f.name || f.id; }).join("、")
              : undefined;
          } else {
            self.catalogStatus = "error";
            self.catalogFailure = "读取模型目录失败。";
          }
          self.store.set(self.projection());
        }, function () {
          self.catalogStatus = "error";
          self.catalogFailure = "读取模型目录失败。";
          self.store.set(self.projection());
        });
      };

      /** 确保草稿存在（基于当前生效值）。 */
      ModelPoolController.prototype.beginDraft = function () {
        if (this.draft === undefined) {
          this.draft = this.currentPools().map(function (item) {
            return {
              provider: item.provider, model: item.model,
              maxConcurrent: item.maxConcurrent, weight: item.weight
            };
          });
        }
        return this.draft;
      };

      /** 勾选/取消一个候选。 */
      ModelPoolController.prototype.toggleRow = function (key) {
        if (this.saving) return;
        if (this.scope.getSnapshot().writable === false) return;
        var draft = this.beginDraft();
        for (var i = 0; i < draft.length; i++) {
          if (poolKey(draft[i].provider, draft[i].model) === key) {
            draft.splice(i, 1);
            this.failed = false;
            this.store.set(this.projection());
            return;
          }
        }
        var route = parsePoolKey(key);
        draft.push({
          provider: route.provider, model: route.model,
          maxConcurrent: DEFAULT_MAX_CONCURRENT, weight: 1
        });
        this.failed = false;
        this.store.set(this.projection());
      };

      /** 改某个候选的并发上限。 */
      ModelPoolController.prototype.setLimit = function (key, value) {
        if (this.saving) return;
        var draft = this.beginDraft();
        for (var i = 0; i < draft.length; i++) {
          if (poolKey(draft[i].provider, draft[i].model) !== key) continue;
          var n = Number(value);
          if (!Number.isInteger(n) || n < 1) return;
          draft[i].maxConcurrent = n;
          this.failed = false;
          this.store.set(this.projection());
          return;
        }
      };

      /** 改某个候选的权重（比例或优先级，语义随策略）。 */
      ModelPoolController.prototype.setWeight = function (key, value) {
        if (this.saving) return;
        var draft = this.beginDraft();
        for (var i = 0; i < draft.length; i++) {
          if (poolKey(draft[i].provider, draft[i].model) !== key) continue;
          var n = Number(value);
          if (!Number.isInteger(n) || n < 1) return;
          draft[i].weight = n;
          this.failed = false;
          this.store.set(this.projection());
          return;
        }
      };

      ModelPoolController.prototype.discard = function () {
        if (this.saving) return;
        this.draft = undefined;
        this.failed = false;
        this.actions.discard();
        this.store.set(this.projection());
      };      /**
       * 提交：池数组走 scope.mutate 直接写，策略标量交给 SettingsFormModel 自己 save。
       *
       * actions() 只暴露 edit/resetField/discard，没有读取待提交队列的入口，
       * 所以两者必须分开提交——表单模型管标量，控制器管数组。
       */
      ModelPoolController.prototype.save = function () {
        var self = this;
        var snapshot = this.scope.getSnapshot();
        if (this.saving || !snapshot || snapshot.writable === false) return;

        var poolsDirty = this.isDirty();
        var shell = this.form.shell();
        if (!poolsDirty && shell.dirty !== true) return;

        this.saving = true;
        this.failed = false;
        this.store.set(this.projection());

        // 顺序关键：必须先 form.save()（标量 staged）再 scope.mutate（数组）。
        // SettingsFormModel.save 显式携带创建时捕获的 baseline.revision 提交；
        // 若先 mutate 数组，namespace revision 已递增，form.save 必撞
        // settings/conflict 乐观锁——「同时改策略+权重再保存」必现。
        // form.save 成功后 scope 快照随之刷新，随后的 mutate 用新 revision。
        var formWriting = this.form.shell().dirty === true
          ? Promise.resolve(this.form.save()).then(function () {
            return self.form.shell().failed !== true;
          }, function () {
            return false;
          })
          : Promise.resolve(true);

        var writing = formWriting.then(function (formOk) {
          if (!formOk) return false;
          if (!poolsDirty) return true;
          return Promise.resolve(self.scope.mutate([{
            op: "set",
            path: ["pools"],
            value: self.desiredPools().map(function (item) {
              return {
                provider: item.provider, model: item.model,
                maxConcurrent: item.maxConcurrent, weight: item.weight
              };
            })
          }])).then(function () { return true; }, function () { return false; });
        });

        writing.then(function (ok) {
          if (!ok) {
            self.saving = false;
            self.failed = true;
            self.store.set(self.projection());
            return undefined;
          }
          if (poolsDirty) self.draft = undefined;
          return true;
        }).then(function (settled) {
          if (settled === undefined) return;
          self.saving = false;
          self.failed = settled === false;
          self.store.set(self.projection());
        }, function () {
          self.saving = false;
          self.failed = true;
          self.store.set(self.projection());
        });
      };

      ModelPoolController.prototype.inject = function () {
        var self = this;
        // actions 提供 edit/resetField/discard；save 由本控制器接管（要连带写数组）。
        return Object.assign({}, this.actions, {
          hooks: { modelPool: this.store },
          setEnabled: function (enabled) { void self.scope.set("enabled", enabled); },
          toggleRow: function (key) { self.toggleRow(key); },
          setLimit: function (key, value) { self.setLimit(key, value); },
          setWeight: function (key, value) { self.setWeight(key, value); },
          retryCatalog: function () { self.catalogStatus = "idle"; self.loadCatalog(); },
          save: function () { self.save(); },
          discard: function () { self.discard(); }
        });
      };

      ModelPoolController.prototype.dispose = function () {
        if (this.unsubscribe) this.unsubscribe();
        this.form.dispose();
      };

      // 存储值是英文枚举（写进 cordis.patch.yml，后端 STRATEGIES 匹配），
      // 界面显示中文；下拉项里保留英文键名便于与 YAML 对照。
      var STRATEGY_LABELS = {
        "fewest-active": "占用最少优先",
        "least-recently-used": "最久未用优先",
        "strict-priority": "严格主备"
      };
      var STRATEGY_DESC = {
        "fewest-active": "按 占用÷权重 比值最小派发，稳态占用趋近权重比例",
        "least-recently-used": "挑最久未被占用的候选（权重不生效）",
        "strict-priority": "权重即优先级：高者未占满绝不轮到低者"
      };

      /**
       * 分配策略下拉。
       *
       * 只有两个合法值，用下拉而不是文本框：schema 已是 z.string()，文本框
       * 能填进任意脏值（合法性只剩 apply 兜底）。选择即写入表单暂存，与文本
       * 字段共用 staged/save 机制；overridden 时提供恢复默认。
       */
      function StrategyPicker(props) {
        var openState = useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var field = props.field || {};
        var current = typeof field.text === "string" && field.text !== "" ? field.text : STRATEGIES[0];
        return jsxs("div", {
          className: "smp-strategy",
          children: [
            jsxs("div", {
              className: "smp-strategyRow",
              children: [
                jsx("span", { className: "smp-label", children: "分配策略" }),
                field.overridden
                  ? jsx("span", { className: "smp-overridden", children: "已覆盖" })
                  : null,
                jsx(primitives.Menu, {
                  open: open,
                  onClose: function () { setOpen(false); },
                  items: STRATEGIES.map(function (id) {
                    return {
                      id: id,
                      label: jsxs("span", {
                        className: "smp-strategyItem",
                        children: [
                          jsx("span", { className: "smp-strategyName", children: STRATEGY_LABELS[id] }),
                          jsxs("span", { className: "smp-strategyDesc", children: [
                            id + " · " + STRATEGY_DESC[id]
                          ] })
                        ]
                      })
                    };
                  }),
                  selectedId: current,
                  onSelect: function (id) {
                    setOpen(false);
                    props.onEdit("strategy", id);
                  },
                  align: "start",
                  portal: true,
                  anchor: jsxs("button", {
                    type: "button",
                    id: "smp-strategy",
                    className: "smp-strategyBtn",
                    "aria-haspopup": "menu",
                    "aria-expanded": open,
                    "data-smp-strategy": current,
                    disabled: props.disabled,
                    onClick: function () { setOpen(function (v) { return !v; }); },
                    children: [
                      jsx("span", { children: STRATEGY_LABELS[current] ?? current }),
                      jsx(primitives.IconChevronDownOutlineRegular, { className: "smp-strategyChevron" })
                    ]
                  })
                }),
                field.overridden
                  ? jsx("button", {
                    type: "button",
                    className: "smp-reset",
                    disabled: props.disabled,
                    onClick: function () { props.onReset("strategy"); },
                    children: "恢复默认"
                  })
                  : null
              ]
            }),
            jsx("p", { className: "smp-hint", children: "fewest-active：挑当前占用数最少的候选；least-recently-used：挑最久未被占用的候选。" })
          ]
        });
      }

      function ModelPoolSettings(props) {
        var state = props.useModelPool(function (snapshot) { return snapshot; });
        var disabled = !state.writable || state.saving;

        var listChildren = [];
        if (state.catalogStatus === "loading") {
          listChildren.push(jsx("p", { className: "smp-empty", children: "正在读取模型目录…" }, "loading"));
        } else if (state.groups.length === 0) {
          listChildren.push(jsx("p", {
            className: "smp-empty",
            children: state.catalogStatus === "error" ? "模型目录读取失败。" : "模型目录为空。"
          }, "empty"));
        } else {
          for (var g = 0; g < state.groups.length; g++) {
            var group = state.groups[g];
            var rows = [];
            for (var r = 0; r < group.rows.length; r++) {
              var row = group.rows[r];
              rows.push(jsxs("div", {
                className: "smp-row",
                "data-smp-row": row.key,
                "data-smp-selected": row.selected ? "true" : "false",
                children: [
                  jsx("input", {
                    type: "checkbox",
                    className: "smp-check",
                    checked: row.selected,
                    "aria-label": row.name,
                    disabled: disabled,
                    onChange: function (key) {
                      return function () { props.toggleRow(key); };
                    }(row.key)
                  }),
                  jsxs("div", {
                    className: "smp-rowMain",
                    onClick: disabled ? undefined : function (key) {
                      return function () { props.toggleRow(key); };
                    }(row.key),
                    children: [
                      jsx("span", { className: "smp-model", children: row.name }),
                      jsx("span", {
                        className: "smp-route",
                        children: row.stale ? row.provider + "/" + row.model + "（已下线）" : row.provider + "/" + row.model
                      })
                    ]
                  }),
                  row.selected
                    ? jsxs("label", {
                      className: "smp-limit",
                      title: "占用最少策略下=期望占用占比；严格主备下=优先级（大者优先）",
                      children: [
                        jsx("span", { children: "权重" }),
                        jsx("input", {
                          className: "smp-num",
                          type: "number",
                          min: 1,
                          step: 1,
                          value: String(row.weight),
                          disabled: disabled,
                          "data-smp-weight": row.key,
                          onChange: function (key) {
                            return function (event) { props.setWeight(key, event.currentTarget.value); };
                          }(row.key)
                        }),
                        jsx("span", { children: "并发上限" }),
                        jsx("input", {
                          className: "smp-num",
                          type: "number",
                          min: 1,
                          step: 1,
                          value: String(row.maxConcurrent),
                          disabled: disabled,
                          "data-smp-limit": row.key,
                          onChange: function (key) {
                            return function (event) { props.setLimit(key, event.currentTarget.value); };
                          }(row.key)
                        })
                      ]
                    }, "limit")
                    : null
                ]
              }, row.key));
            }
            listChildren.push(jsxs("div", {
              className: "smp-group",
              children: [
                jsx("span", { className: "smp-provider", children: group.name }),
                rows
              ]
            }, group.id));
          }
        }

        var children = [
          jsxs("label", {
            className: "smp-toggle",
            children: [
              jsx("span", { children: "启用子代理模型池" }),
              jsx(primitives.Switch, {
                checked: state.enabled,
                label: "启用子代理模型池",
                disabled: disabled,
                onChange: props.setEnabled
              })
            ]
          }, "enabled"),
          jsx(StrategyPicker, {
            field: state.strategy,
            disabled: disabled,
            onEdit: props.edit,
            onReset: props.resetField
          }, "strategy"),
          jsxs("div", {
            className: "smp-control",
            children: [
              jsx("span", { className: "smp-label", children: "候选模型" }),
              jsx("p", {
                className: "smp-hint",
                children: "勾选即加入池。权重默认 1：占用最少策略下=期望占用占比，严格主备下=优先级（大者优先）。并发上限=可同时被几个子代理占用，默认 " + DEFAULT_MAX_CONCURRENT + "。全部占满时回退父会话路由。"
              }),
              jsx("div", { className: "smp-pool", "data-smp-pool": true, children: listChildren }),
              jsx("p", { className: "smp-summary", children: state.summary }),
              state.catalogFailure
                ? jsxs("p", {
                  className: "smp-error",
                  children: [
                    state.catalogFailure,
                    " ",
                    jsx("button", { type: "button", onClick: props.retryCatalog, children: "重试" })
                  ]
                })
                : null
            ]
          }, "pools")
        ];

        return jsxs("section", {
          className: "smp-settings",
          "data-subagent-model-pool-settings": true,
          children: [
            jsxs("header", {
              className: "smp-header",
              children: [
                jsx("h3", { className: "smp-title", children: "子代理模型池" }),
                jsx("p", {
                  className: "smp-description",
                  children: "在多个候选模型间按并发占用分配子代理；每个子代理派发后模型锁定。"
                })
              ]
            }),
            jsx(primitives.SettingsForm, {
              labels: LABELS,
              state: state,
              onSave: props.save,
              onDiscard: props.discard,
              children: children
            })
          ]
        });
      }

      function registerSettings(ctx) {
        var scope = ctx.configForms.get(SETTINGS_NS);
        var controller = new ModelPoolController(scope, ctx);
        ctx.effect(function () { return function () { controller.dispose(); }; }, "subagent-model-pool: 配置表单");
        ctx.effect(function () {
          return ctx.configForms.whileServed([SETTINGS_NS], function () {
            return ctx.slots.inject("settings.section", function () {
              return ctx.slots.register({
                name: "settings.section",
                id: SETTINGS_NS,
                order: 81,
                label: "子代理模型池",
                inject: function () { return controller.inject(); }
              }, ModelPoolSettings);
            });
          });
        }, "subagent-model-pool: 顶层设置入口");
      }

      // ---- 统计视图 ----
      //
      // 形态：侧栏面板（sidebar.panellist）+ 独立主页面（main 槽 keyed）。
      // 先例是内置的「插件管理」页与「任务」页（dsh-client-ui-plugin-manager /
      // dsh-client-ui-schedule）：两者都是 slots.inject("main") 挂一个 keyed
      // 主页面，再用 slots.inject("sidebar.panellist") 挂侧栏图标。
      //
      // 数据来源：Host 半注册的 Connection 精确 Fetch 路由
      // `/api/subagent-pool.stats`（服务端 index.js 的 STATS_PATH）。
      // 走 Connection 的理由：Host/Origin 围栏与浏览器会话鉴权已经现成，
      // 第三方插件自己开 HTTP 路由等于重写一遍鉴权。

      /** 统计面板的 id（同时是 main 槽的 key 与侧栏条目 id）。 */
      var PANEL_ID = "subagent-model-pool";

      /** 统计快照的取数路由（浏览器相对路径，与内置 deliverables 同款写法）。 */
      var STATS_ROUTE = "api/subagent-pool.stats";

      /** 三种统计口径。 */
      var MODES = ["tokens", "requests", "assignments"];

      /** 路由配色：t0 蓝 / t1 绿 / t2 橙 / t3 紫（与 DSH 内置统计表同族）。 */
      var TONE_COLORS = {
        t0: "var(--dsw-alias-accent,#2f6bff)",
        t1: "var(--dsw-alias-state-success-primary,#1a8a4a)",
        t2: "var(--dsw-alias-state-warning-primary,#c77d0a)",
        t3: "#8a63d2"
      };

      var STATS_CSS = [
        ".smpv-page{display:flex;flex-direction:column;gap:12px;padding:16px 20px;min-width:0}",
        ".smpv-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}",
        ".smpv-title{margin:0;font-size:14px;line-height:20px;font-weight:600}",
        ".smpv-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
        ".smpv-actions{display:flex;align-items:center;gap:8px}",
        // 刷新按钮：加载态用旋转图标，文字不变——换文字会改变按钮宽度。
        ".smpv-refresh{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-background-primary);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;line-height:16px;padding:3px 8px;cursor:pointer;transition:background-color .16s ease,color .16s ease,border-color .16s ease}",
        ".smpv-refresh:hover{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
        ".smpv-refresh:active{transform:translateY(.5px)}",
        ".smpv-refresh[aria-busy=true]{cursor:progress}",
        ".smpv-refresh:focus-visible{outline:1px solid var(--dsw-alias-accent,#2f6bff);outline-offset:1px}",
        // spinner 绝对定位在文字左侧的固定槽位里——参与布局会把按钮撑宽 18px。
        ".smpv-refreshSlot{position:relative;width:0;height:12px;flex:none}",
        // 外层负责淡入淡出，内层负责旋转：两层分开，transform 不互相打架。
        ".smpv-spinWrap{position:absolute;left:0;top:0;width:12px;height:12px;opacity:0;transform:scale(.7);transition:opacity .2s ease-out,transform .2s cubic-bezier(.2,.8,.3,1)}",
        ".smpv-spinWrap[data-on=true]{opacity:1;transform:scale(1)}",
        // 匀速 + 1 秒周期：线性是唯一没有顿挫感的旋转曲线，周期太快会显得急促。
        ".smpv-spin{display:block;width:12px;height:12px;border-radius:50%;border:1.5px solid transparent;border-top-color:var(--dsw-alias-accent,#2f6bff);border-right-color:var(--dsw-alias-accent,#2f6bff);animation:smpv-spin 1s linear infinite}",
        "@keyframes smpv-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
        // 减弱动效偏好：改成极慢的呼吸，不旋转。
        "@media (prefers-reduced-motion:reduce){.smpv-spin{animation:smpv-pulse 2.4s ease-in-out infinite;border-right-color:transparent}}",
        "@keyframes smpv-pulse{0%,100%{opacity:.35}50%{opacity:1}}",
        "@media (prefers-reduced-motion:reduce){.smpv-spinWrap{transition:none}}",
        // 数据刷新时整块淡入，避免生硬替换。
        ".smpv-body{animation:smpv-fade .28s cubic-bezier(.2,.7,.3,1)}",
        "@keyframes smpv-fade{from{opacity:.35}to{opacity:1}}",
        "@media (prefers-reduced-motion:reduce){.smpv-body,.smpv-panel,.smpv-cards{animation:none}}",
        ".smpv-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px}",
        ".smpv-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-background-primary);padding:6px 9px}",
        ".smpv-cardK{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
        ".smpv-cardV{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-variant-numeric:tabular-nums;font-size:15px;line-height:21px;font-weight:600}",
        ".smpv-switch{display:inline-flex;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;position:relative;background:var(--dsw-alias-bg-layer-1)}",
        // 字重固定：选中态只换背景与文字色。改字重会让文字宽度变化，
        // 切换时按钮「拉长又缩小」。
        // 选中态用品牌色实心填充 + 白字，对比强烈一眼可辨；容器边框也要看得见。
        ".smpv-switchBtn{position:relative;border:0;background:0;padding:3px 9px;font-family:inherit;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease,background-color .16s ease;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}",
        ".smpv-switchBtn:hover:not(.on){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}",
        ".smpv-switchBtn.on{background:var(--dsw-alias-accent,#2f6bff);color:#fff}",
        // 选中项前的小圆点：白底上的实心点。
        // 槽位宽度为 0，文字位置不受影响；圆点绝对定位溢出到左侧 9px。
        // 若让它参与布局，选中/未选中宽度就不同，切换时按钮会伸缩。
        ".smpv-switchSlot{position:relative;width:0;height:10px;flex:none}",
        ".smpv-switchDot{position:absolute;left:-9px;top:50%;margin-top:-2px;display:block;width:4px;height:4px;border-radius:50%;background:#fff}",
        ".smpv-switchBtn:focus-visible{outline:1px solid var(--dsw-alias-accent,#2f6bff);outline-offset:-2px}",
        ".smpv-switchBtn.on:focus-visible{outline-color:var(--dsw-alias-label-primary)}",
        ".smpv-panel{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-background-primary);padding:8px 10px;animation:smpv-fade .18s ease-out}",
        ".smpv-panelTitle{font-size:12px;line-height:18px;font-weight:600;margin:0 0 6px;display:flex;align-items:center;gap:6px}",
        // 标题里的口径标记：说明当前正在按什么统计。
        ".smpv-modeTag{font-weight:400;font-size:10px;line-height:15px;padding:1px 5px;border-radius:999px;color:var(--dsw-alias-accent,#2f6bff);background:var(--dsw-alias-bg-layer-2)}",
        ".smpv-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
        ".smpv-stack{margin:0 0 6px}",
        ".smpv-dot{width:7px;height:7px;border-radius:2px;display:inline-block;flex:none}",
        ".smpv-route{display:grid;grid-template-columns:7px minmax(112px,160px) 1fr auto;gap:8px;align-items:center;padding:3px 0}",
        ".smpv-routeLabel{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".smpv-table .smpv-routeLabel{font-family:inherit;font-size:11px;color:var(--dsw-alias-label-secondary)}",
        ".smpv-routeLabel b{font-weight:600}",
        ".smpv-routeLabel span{color:var(--dsw-alias-label-tertiary)}",
        ".smpv-bar{height:8px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);display:flex;overflow:hidden}",
        ".smpv-barI{display:block;height:100%}",
        ".smpv-routeNums{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-variant-numeric:tabular-nums;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:right;white-space:nowrap}",
        ".smpv-routeNums b{color:var(--dsw-alias-label-primary);font-weight:600}",
        ".smpv-slotRow{display:grid;grid-template-columns:minmax(120px,168px) 44px 1fr auto;gap:8px;align-items:center;padding:3px 0}",
        ".smpv-slots{display:flex;gap:2px;align-items:center;flex-wrap:wrap}",
        ".smpv-slot{width:13px;height:13px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}",
        ".smpv-slot.busy{background:var(--dsw-alias-accent,#2f6bff);border-color:transparent}",
        ".smpv-slot.hot{background:var(--dsw-alias-state-warning-primary,#c77d0a);border-color:transparent}",
        ".smpv-slot.down{background:var(--dsw-alias-state-error-primary,#d5393a);border-color:transparent}",
        ".smpv-state{font-size:11px;line-height:16px;text-align:right;white-space:nowrap}",
        ".smpv-state.ok{color:var(--dsw-alias-state-success-primary,#1a8a4a)}",
        ".smpv-state.hot{color:var(--dsw-alias-state-warning-primary,#c77d0a)}",
        ".smpv-state.down{color:var(--dsw-alias-state-error-primary,#d5393a)}",
        ".smpv-table{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}",
        ".smpv-table thead th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:11px;line-height:16px;text-align:left;padding:0 8px 4px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:bottom;white-space:nowrap}",
        ".smpv-table thead th.smpv-num{text-align:right}",
        ".smpv-table tbody td{border-bottom:.5px solid var(--dsw-alias-border-l1);padding:4px 8px;font-size:11px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}",
        ".smpv-table tbody tr:last-child td{border-bottom:0}",
        // 父子关系用左侧竖线表达，不用 padding 硬推——标题列宽度不受影响。
        ".smpv-table tr.child td:first-child{box-shadow:inset 2px 0 0 var(--dsw-alias-border-l1);padding-left:18px}",
        ".smpv-table tr.child td{color:var(--dsw-alias-label-secondary)}",
        ".smpv-table tr.parent td:first-child{font-weight:500}",
        ".smpv-sessionTitle{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".smpv-kind{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}",
        // 数字在口径切换时突变，给一个轻微淡入，避免生硬跳变。
        ".smpv-num{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);text-align:right;font-size:11px;transition:opacity .14s ease-out}",
        ".smpv-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 6px;text-align:center}",
        ".smpv-err{color:var(--dsw-alias-state-error-primary,#d5393a);font-size:12px;line-height:18px;padding:12px 6px}",
        ".smpv-foot{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
        // ===== 移动端 H5 适配（沿用 DSH 前端的 width<=767px / width<=480px 断点）=====
        // 窄屏：标题区竖排、按钮组占满一行、两栏面板改单栏、卡片改 2 列。
        "@media (width<=767px){",
        ".smpv-page{padding:12px 12px 16px;gap:10px}",
        ".smpv-head{flex-direction:column;align-items:stretch;gap:8px}",
        ".smpv-actions{justify-content:space-between;gap:8px}",
        ".smpv-switch{flex:1;display:flex}",
        ".smpv-switchBtn{flex:1;text-align:center}",
        ".smpv-grid{grid-template-columns:1fr;gap:8px}",
        ".smpv-cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}",
        ".smpv-card{padding:5px 8px}",
        ".smpv-foot{gap:6px}",
        // 窄屏基本就是手机：可点区域放大到 34px 以上（不必依赖 pointer:coarse）。
        ".smpv-switchBtn{padding:8px 9px;min-height:34px;display:inline-flex;align-items:center;justify-content:center}",
        ".smpv-refresh{min-height:34px;padding:8px 10px}",
        // 窄屏：8 列表格转成卡片列表，每个会话一张卡。
        ".smpv-table,.smpv-table tbody,.smpv-table tbody tr,.smpv-table tbody td{display:block;width:auto}",
        ".smpv-table thead{display:none}",
        ".smpv-table tbody tr{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:6px 8px;margin-bottom:6px}",
        ".smpv-table tbody td{border:0;padding:1px 0;display:flex;align-items:baseline;justify-content:space-between;gap:10px}",
        ".smpv-table tbody td::before{content:attr(data-label);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;flex:none}",
        // 标题独占一行，不显示标签前缀。
        ".smpv-table tbody td:first-child{font-weight:500;padding-bottom:3px}",
        ".smpv-table tbody td:first-child::before{content:none}",
        ".smpv-table tbody td:first-child .smpv-sessionTitle{white-space:normal;overflow-wrap:anywhere}",
        ".smpv-table tr.child td:first-child{box-shadow:none;padding-left:14px;border-left:2px solid var(--dsw-alias-border-l1)}",
        ".smpv-table tr.parent td:first-child{font-weight:600}",
        // 数值字段排成两列网格：8 行压到 6 行，行高从 183px 降到 ~110px。
        ".smpv-table tbody tr{display:grid;grid-template-columns:1fr 1fr;column-gap:10px}",
        ".smpv-table tbody td:first-child{grid-column:1/-1}",
        ".smpv-table tbody td.smpv-num{flex-direction:row;align-items:baseline;justify-content:space-between;gap:6px}",
        ".smpv-table tbody td.smpv-num::before{order:0}",
        ".smpv-table tbody td.smpv-num .smpv-numV{order:1}",
        "}",
        // 超窄屏：卡片数字字号收一档。
        "@media (width<=480px){",
        ".smpv-cards{grid-template-columns:repeat(2,minmax(0,1fr))}",
        ".smpv-cardV{font-size:14px;line-height:20px}",
        ".smpv-refresh{padding:3px 7px}",
        "}",
        // 触摸设备：可点区域放大。
        "@media (pointer:coarse){",
        ".smpv-switchBtn{padding:8px 9px;min-height:32px}",
        ".smpv-refresh{min-height:32px;padding:7px 10px}",
        "}"
      ].join("");
      if (typeof document !== "undefined" && typeof document.querySelector === "function"
        && document.querySelector("style[data-subagent-model-pool-stats-css]") === null) {
        var statsStyle = document.createElement("style");
        statsStyle.setAttribute("data-subagent-model-pool-stats-css", "true");
        statsStyle.textContent = STATS_CSS;
        document.head.appendChild(statsStyle);
      }

      /** 一条路由在某口径下的度量值。 */
      function measureOf(route, mode) {
        if (mode === "requests") return route.requests || 0;
        if (mode === "assignments") return route.assignments || 0;
        return route.totalTokens || 0;
      }

      /** 按口径排序路由并算占比。 */
      function rankRoutes(routes, mode) {
        var measured = routes.map(function (route) {
          return Object.assign({}, route, { measure: measureOf(route, mode) });
        });
        var total = measured.reduce(function (sum, route) { return sum + route.measure; }, 0);
        measured.sort(function (left, right) {
          return right.measure - left.measure
            || left.provider.localeCompare(right.provider)
            || left.model.localeCompare(right.model);
        });
        return measured.map(function (route, index) {
          return Object.assign({}, route, {
            tone: "t" + (index % 4),
            ratio: total === 0 ? 0 : route.measure / total
          });
        });
      }

      /** 池槽位图：每个并发槽的状态。 */
      function slotStates(route) {
        var capacity = Math.max(0, route.maxConcurrent || 0);
        var active = Math.max(0, route.active || 0);
        var states = [];
        for (var i = 0; i < capacity; i += 1) {
          if (i < active) states.push((route.probeFailures || 0) > 0 ? "hot" : "busy");
          else states.push("idle");
        }
        return states;
      }

      /** 路由健康状态。 */
      function routeHealth(route) {
        if ((route.probeFailures || 0) > 0) return "down";
        var capacity = route.maxConcurrent || 0;
        if (capacity > 0 && (route.active || 0) >= capacity) return "hot";
        return "ok";
      }

      /** 千分位整数。 */
      function formatCount(value) {
        if (typeof value !== "number" || !isFinite(value)) return "—";
        return Math.round(value).toLocaleString("en-US");
      }

      /** 紧凑 token 数：不足一万原样，超过后用 k / M。 */
      function formatTokens(value) {
        if (typeof value !== "number" || !isFinite(value)) return "—";
        if (value < 1000) return String(Math.round(value));
        if (value < 1000000) {
          var k = value / 1000;
          return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
        }
        var m = value / 1000000;
        return (m >= 100 ? Math.round(m) : Math.round(m * 10) / 10) + "M";
      }

      /** 百分比（一位小数，去掉多余的 .0）。 */
      function formatPercent(ratio) {
        if (typeof ratio !== "number" || !isFinite(ratio)) return "—";
        var percent = Math.round(ratio * 1000) / 10;
        return (Number.isInteger(percent) ? percent : percent.toFixed(1)) + "%";
      }

      /** 会话父子分组：主会话一行，其子代理各占一行。 */
      function groupSessions(sessions) {
        var byId = {};
        sessions.forEach(function (session) { byId[session.sessionId] = session; });
        var roots = [];
        var orphans = [];
        var childrenOf = {};
        sessions.forEach(function (session) {
          if (session.isSubagent !== true || session.parentSessionId === undefined) {
            roots.push(session);
            return;
          }
          if (byId[session.parentSessionId] === undefined) {
            // 父会话已被账本淘汰：仍是子代理，只是没有可挂的行。
            orphans.push(session);
            return;
          }
          (childrenOf[session.parentSessionId] = childrenOf[session.parentSessionId] || []).push(session);
        });
        var rows = [];
        roots.forEach(function (root) {
          rows.push({ kind: "parent", session: root });
          (childrenOf[root.sessionId] || []).forEach(function (child) {
            rows.push({ kind: "child", session: child });
          });
        });
        orphans.forEach(function (child) {
          rows.push({ kind: "child", session: child });
        });
        return rows;
      }

      /** 校验 Host 返回的快照，形状不对就当作不可用。 */
      function parseSnapshot(value) {
        if (value === null || typeof value !== "object") return null;
        if (!Array.isArray(value.routes) || !Array.isArray(value.sessions)) return null;
        if (value.totals === null || typeof value.totals !== "object") return null;
        return value;
      }

      /** 读一次统计快照；失败返回 null。 */
      function readStats(signal) {
        return fetch(STATS_ROUTE, { signal: signal, credentials: "same-origin" })
          .then(function (response) {
            if (!response.ok) return null;
            return response.json().then(parseSnapshot);
          })
          .catch(function () { return null; });
      }

      /** 一张合计卡。 */
      function StatCard(props) {
        return jsx("div", {
          className: "smpv-card",
          children: [
            jsx("div", { className: "smpv-cardK", children: props.label }),
            jsx("div", { className: "smpv-cardV", children: props.value })
          ]
        });
      }

      /** 口径切换按钮组。 */
      function ModeSwitch(props) {
        var labels = { tokens: "按 Token", requests: "按请求", assignments: "按分配" };
        return jsx("div", {
          className: "smpv-switch",
          role: "group",
          "aria-label": "统计口径",
          children: MODES.map(function (mode) {
            var on = props.mode === mode;
            return jsx("button", {
              key: mode,
              type: "button",
              className: "smpv-switchBtn" + (on ? " on" : ""),
              "aria-pressed": on ? "true" : "false",
              "aria-label": "按" + (mode === "tokens" ? " Token 统计" : mode === "requests" ? "请求数统计" : "分配次数统计"),
              title: on ? "当前口径：" + labels[mode] : "切换到" + labels[mode],
              onClick: function () { props.onChange(mode); },
              children: [
                // 选中项带一个实心圆点，不只靠底色区分。
                jsx("span", {
                  className: "smpv-switchSlot",
                  children: on ? jsx("i", { className: "smpv-switchDot" }) : null
                }),
                labels[mode]
              ]
            });
          })
        });
      }

      /** 一条路由的「模型 · provider」标签。 */
      function RouteLabel(props) {
        return jsx("span", {
          className: "smpv-routeLabel",
          title: props.route.model + " · " + props.route.provider,
          children: [
            jsx("b", { children: props.route.model }),
            jsx("span", { children: " · " + props.route.provider })
          ]
        });
      }

      /** 路由分布面板：一条堆叠条 + 每条路由一行。 */
      function RoutePanel(props) {
        var rows = props.ranked;
        var visible = rows.filter(function (route) { return route.measure > 0; });
        var stack = visible.map(function (route) {
          return jsx("i", {
            key: route.provider + "/" + route.model,
            className: "smpv-barI",
            title: route.model + " · " + route.provider + " " + formatPercent(route.ratio),
            style: { width: (route.ratio * 100).toFixed(2) + "%", background: TONE_COLORS[route.tone] }
          });
        });
        var modeText = props.mode === "requests" ? "按请求数" : props.mode === "assignments" ? "按分配次数" : "按 Token";
        return jsx("div", {
          className: "smpv-panel",
          children: [
            jsx("h3", {
              className: "smpv-panelTitle",
              children: [
                "路由分布",
                // 标题里回显当前口径，不看按钮也知道正在按什么统计。
                jsx("span", { className: "smpv-modeTag", children: modeText })
              ]
            }),
            rows.length === 0
              ? jsx("div", { className: "smpv-empty", children: "还没有分配记录。" })
              : jsx("div", {
                className: "smpv-stack",
                children: stack.length === 0
                  ? jsx("div", { className: "smpv-bar", children: jsx("i", { className: "smpv-barI", style: { width: "100%", background: "var(--dsw-alias-bg-layer-2)" } }) })
                  : jsx("div", { className: "smpv-bar", children: stack })
              }),
            rows.length === 0 ? null : rows.map(function (route) {
              return jsx("div", {
                key: route.provider + "/" + route.model,
                className: "smpv-route",
                children: [
                  jsx("span", {
                    className: "smpv-dot",
                    style: { background: TONE_COLORS[route.tone] }
                  }),
                  jsx(RouteLabel, { route: route }),
                  jsx("span", {
                    className: "smpv-routeNums",
                    children: [
                      jsx("b", {
                        children: props.mode === "requests"
                          ? formatCount(route.measure)
                          : formatTokens(route.measure)
                      }),
                      " · " + formatPercent(route.ratio)
                    ]
                  })
                ]
              });
            })
          ]
        });
      }

      /** 池槽位面板：只列池内候选（池外的路由是主代理自己的模型，不归池管）。 */
      function SlotPanel(props) {
        var labels = { ok: "空闲", hot: "满载", down: "探测失败" };
        var routes = props.routes.filter(function (route) { return route.inPool === true; });
        return jsx("div", {
          className: "smpv-panel",
          children: [
            jsx("h3", { className: "smpv-panelTitle", children: "池占用" }),
            routes.length === 0
              ? jsx("div", { className: "smpv-empty", children: "模型池为空，先在设置里添加候选。" })
              : routes.map(function (route) {
                var states = slotStates(route);
                var health = routeHealth(route);
                return jsx("div", {
                  key: route.provider + "/" + route.model,
                  className: "smpv-slotRow",
                  children: [
                    jsx(RouteLabel, { route: route }),
                    jsx("span", {
                      className: "smpv-routeNums",
                      children: [
                        jsx("b", { children: String(route.active || 0) }),
                        "/" + String(route.maxConcurrent || 0)
                      ]
                    }),
                    jsx("span", {
                      className: "smpv-slots",
                      children: states.map(function (state, index) {
                        return jsx("i", { key: index, className: "smpv-slot " + state });
                      })
                    }),
                    jsx("span", { className: "smpv-state " + health, children: labels[health] })
                  ]
                });
              })
          ]
        });
      }

      /** 会话明细表。 */
      function SessionTable(props) {
        var rows = groupSessions(props.sessions);
        return jsx("div", {
          className: "smpv-panel",
          style: { overflowX: "auto" },
          children: [
            jsx("h3", { className: "smpv-panelTitle", children: "会话明细" }),
            rows.length === 0
              ? jsx("div", { className: "smpv-empty", children: "还没有观测到模型请求。" })
              : jsx("table", {
                className: "smpv-table",
                children: [
                  jsx("thead", {
                    children: jsx("tr", {
                      children: [
                        jsx("th", { style: { width: "32%" }, children: "会话" }),
                        jsx("th", { style: { width: "7%" }, children: "类型" }),
                        jsx("th", { style: { width: "17%" }, children: "路由" }),
                        jsx("th", { className: "smpv-num", style: { width: "7%" }, children: "请求" }),
                        jsx("th", { className: "smpv-num", style: { width: "8%" }, children: "输入" }),
                        jsx("th", { className: "smpv-num", style: { width: "8%" }, children: "输出" }),
                        jsx("th", { className: "smpv-num", style: { width: "11%" }, children: "缓存读" }),
                        jsx("th", { className: "smpv-num", style: { width: "11%" }, children: "缓存写" })
                      ]
                    })
                  }),
                  jsx("tbody", {
                    children: rows.map(function (row) {
                      var session = row.session;
                      var routeText = session.routes.map(function (route) {
                        return route.model + "(" + route.provider + ")";
                      }).join(" ");
                      var isSub = session.isSubagent === true;
                      var title = session.title !== undefined && session.title !== null
                        ? session.title
                        : session.sessionId;
                      return jsx("tr", {
                        key: row.kind + ":" + session.sessionId,
                        className: row.kind,
                        children: [
                          jsx("td", {
                            title: title + " · " + session.sessionId,
                            children: jsx("span", {
                              className: "smpv-sessionTitle",
                              children: title
                            })
                          }),
                          jsx("td", {
                            className: "smpv-kind",
                            "data-label": "类型",
                            children: isSub ? "子代理" : "主代理"
                          }),
                          jsx("td", {
                            className: "smpv-routeLabel",
                            title: routeText,
                            "data-label": "路由",
                            children: routeText || "—"
                          }),
                          jsx("td", { className: "smpv-num", "data-label": "请求", children: jsx("span", { className: "smpv-numV", children: formatCount(session.requests) }) }),
                          jsx("td", { className: "smpv-num", "data-label": "输入", children: jsx("span", { className: "smpv-numV", children: formatTokens(session.tokens.inputTokens) }) }),
                          jsx("td", { className: "smpv-num", "data-label": "输出", children: jsx("span", { className: "smpv-numV", children: formatTokens(session.tokens.outputTokens) }) }),
                          jsx("td", { className: "smpv-num", "data-label": "缓存读", children: jsx("span", { className: "smpv-numV", children: formatTokens(session.tokens.cacheReadTokens) }) }),
                          jsx("td", { className: "smpv-num", "data-label": "缓存写", children: jsx("span", { className: "smpv-numV", children: formatTokens(session.tokens.cacheWriteTokens) }) })
                        ]
                      });
                    })
                  })
                ]
              })
          ]
        });
      }

      /** 统计主页面。 */
      function StatsPage(props) {
        var state = props.useStats();
        var snapshot = state.snapshot;
        var mode = state.mode;
        var ranked = useMemo(function () {
          if (snapshot === null) return [];
          return rankRoutes(snapshot.routes, mode);
        }, [snapshot, mode]);
        var tokens = snapshot === null ? null : snapshot.totals.tokens;
        var totals = snapshot === null ? null : snapshot.totals;
        return jsx("div", {
          className: "smpv-page",
          children: [
            jsx("div", {
              className: "smpv-head",
              children: [
                jsx("div", {
                  children: [
                    jsx("h1", { className: "smpv-title", children: "子代理模型池 · 统计" }),
                    jsx("p", { className: "smpv-sub", children: "进程内累计，重启后归零。" })
                  ]
                }),
                jsx("div", {
                  className: "smpv-actions",
                  children: [
                    jsx(ModeSwitch, { mode: mode, onChange: state.setMode }),
                    jsx("button", {
                      type: "button",
                      className: "smpv-refresh",
                      // 不禁用按钮：禁用会让文字整体变灰，视觉上很突兀。
                      // 改为加载中忽略重复点击。
                      "aria-busy": state.loading ? "true" : "false",
                      onClick: function () { if (!state.loading) state.reload(); },
                      "aria-label": "刷新统计",
                      children: [
                        jsx("span", {
                          className: "smpv-refreshSlot",
                          children: jsx("span", {
                            className: "smpv-spinWrap",
                            // 常驻挂载，只切 data-on —— 这样加载快时也能淡入淡出，
                            // 而不是瞬间出现又瞬间消失。
                            "data-on": state.loading ? "true" : "false",
                            children: jsx("i", { className: "smpv-spin" })
                          })
                        }),
                        "刷新"
                      ]
                    })
                  ]
                })
              ]
            }),
            state.error ? jsx("div", { className: "smpv-err", children: state.error }) : null,
            jsx("div", {
              className: "smpv-body",
              // key 随数据版本变化：新数据到达时整块淡入，不生硬替换。
              key: state.version,
              children: [
                jsx("div", {
                  className: "smpv-cards",
                  children: [
                    jsx(StatCard, { label: "分配次数", value: formatCount(totals === null ? 0 : totals.assignments) }),
                    jsx(StatCard, { label: "模型请求", value: formatCount(totals === null ? 0 : totals.requests) }),
                    jsx(StatCard, { label: "未缓存输入", value: formatTokens(tokens === null ? 0 : tokens.inputTokens) }),
                    jsx(StatCard, { label: "输出", value: formatTokens(tokens === null ? 0 : tokens.outputTokens) }),
                    jsx(StatCard, { label: "缓存读", value: formatTokens(tokens === null ? 0 : tokens.cacheReadTokens) }),
                    jsx(StatCard, { label: "缓存写", value: formatTokens(tokens === null ? 0 : tokens.cacheWriteTokens) }),
                    jsx(StatCard, { label: "回退父路由", value: formatCount(totals === null ? 0 : totals.fallbacks) })
                  ]
                }),
                jsx("div", {
                  className: "smpv-grid",
                  children: [
                    // key 含口径：切换口径时整块重挂载，触发淡入动画。
                    jsx(RoutePanel, { key: "route-" + mode, ranked: ranked, mode: mode }),
                    jsx(SlotPanel, { routes: snapshot === null ? [] : snapshot.routes })
                  ]
                }),
                jsx(SessionTable, { sessions: snapshot === null ? [] : snapshot.sessions })
              ]
            }),
            jsx("div", {
              className: "smpv-foot",
              children: [
                jsx("span", { children: "探测失败 " + formatCount(totals === null ? 0 : totals.probeFailures) }),
                jsx("span", { children: "token 口径与 DSH tokenUsage 投影一致：输入不含缓存。" })
              ]
            })
          ]
        });
      }

      /** 侧栏面板图标。 */
      function PoolIcon(props) {
        return jsx(primitives.IconGaugeOutlineRegular, { size: props.size });
      }

      /**
       * 统计页的状态源：极简 store（getSnapshot/subscribe）+ 一次 fetch。
       */
      function createStatsSource() {
        var listeners = [];
        var snapshot = null;
        var error = null;
        var loading = false;
        var controller = null;
        // 数据版本号：每次新快照到达递增。渲染层用它当 key，让整块淡入。
        var version = 0;
        var notify = function () {
          listeners.forEach(function (listener) { listener(); });
        };
        var load = function () {
          if (controller !== null) controller.abort();
          controller = new AbortController();
          loading = true;
          error = null;
          notify();
          readStats(controller.signal).then(function (value) {
            if (controller === null || controller.signal.aborted) return;
            loading = false;
            if (value === null) {
              error = "读取统计失败：宿主接口不可用。";
            } else {
              snapshot = value;
              version += 1;
            }
            notify();
          });
        };
        return {
          getSnapshot: function () {
            return { snapshot: snapshot, error: error, loading: loading, version: version };
          },
          subscribe: function (listener) {
            listeners.push(listener);
            return function () {
              var index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
            };
          },
          load: load
        };
      }

      /**
       * 统计页的 useStats 钩子：订阅 store，返回当前快照与操作。
       *
       * 通过 slot 的 inject 面直接下发一个函数（不是 hooks 源）：渲染器只把
       * `hooks` 里的源绑成选择器钩子，普通 props 会被原样透传给组件
       * （dsh-client-ui-renderer/lib/client.js:443-459）。这里要的是一个
       * 带 React hooks 的函数，只能当普通 prop 传。
       */
      function createStatsHook(source) {
        return function useStats() {
          var state = useState(function () { return source.getSnapshot(); });
          var setState = state[1];
          useEffect(function () {
            var listener = function () { setState(source.getSnapshot()); };
            return source.subscribe(listener);
          }, []);
          var modeState = useState("tokens");
          return {
            snapshot: state[0].snapshot,
            error: state[0].error,
            loading: state[0].loading,
            version: state[0].version,
            mode: modeState[0],
            setMode: modeState[1],
            reload: function () { source.load(); }
          };
        };
      }

      function registerStats(ctx) {
        var source = createStatsSource();
        ctx.effect(function () {
          source.load();
          return function () {};
        }, "subagent-model-pool: 统计源");
        var useStats = createStatsHook(source);
        ctx.effect(function () {
          return ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: PANEL_ID,
              label: "模型池统计",
              inject: function () { return { useStats: useStats }; }
            }, StatsPage);
          });
        }, "subagent-model-pool: 统计主页面");
        ctx.effect(function () {
          return ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 30,
              label: "模型池统计"
            }, PoolIcon);
          });
        }, "subagent-model-pool: 统计侧栏入口");
      }

      function apply(ctx) {
        registerSettings(ctx);
        registerStats(ctx);
      }

      exports.apply = apply;
      // remote / remote.session 是读模型目录（ctx.remote.session.modelCatalog）的前置：
      // 不声明会抛 cannot get property "remote" without inject，整个条目 boot 失败。
      exports.inject = ["slots", "remote", "remote.session", "configForms"];
      // 无 DOM 依赖的测试出口。
      exports.__test = {
        SETTINGS_NS: SETTINGS_NS,
        STRATEGIES: STRATEGIES,
        DEFAULT_MAX_CONCURRENT: DEFAULT_MAX_CONCURRENT,
        PANEL_ID: PANEL_ID,
        STATS_ROUTE: STATS_ROUTE,
        MODES: MODES,
        normalizePools: normalizePools,
        buildGroups: buildGroups,
        poolKey: poolKey,
        measureOf: measureOf,
        rankRoutes: rankRoutes,
        slotStates: slotStates,
        routeHealth: routeHealth,
        formatCount: formatCount,
        formatTokens: formatTokens,
        formatPercent: formatPercent,
        groupSessions: groupSessions,
        parseSnapshot: parseSnapshot
      };
      return module.exports;
    }
  });
})();
