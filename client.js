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
  var STRATEGIES = ["fewest-active", "least-recently-used"];
  var DEFAULT_MAX_CONCURRENT = 3;

  window.__ModuleLoader__.load({
    id: "dsh-subagent-model-pool",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var jsxRuntime = require("react/jsx-runtime");
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
        ".smp-status{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}"
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
          out.push({ provider: entry.provider, model: entry.model, maxConcurrent: limit });
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
              maxConcurrent: stored[key] ? stored[key].maxConcurrent : DEFAULT_MAX_CONCURRENT
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
            maxConcurrent: pool.maxConcurrent
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
            return { provider: item.provider, model: item.model, maxConcurrent: item.maxConcurrent };
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
        draft.push({ provider: route.provider, model: route.model, maxConcurrent: DEFAULT_MAX_CONCURRENT });
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

        var writing = poolsDirty
          ? Promise.resolve(this.scope.mutate([{
            op: "set",
            path: ["pools"],
            value: this.desiredPools().map(function (item) {
              return { provider: item.provider, model: item.model, maxConcurrent: item.maxConcurrent };
            })
          }])).then(function () { return true; }, function () { return false; })
          : Promise.resolve(true);

        writing.then(function (ok) {
          if (!ok) {
            self.saving = false;
            self.failed = true;
            self.store.set(self.projection());
            return undefined;
          }
          if (poolsDirty) self.draft = undefined;
          // 策略字段由表单模型负责提交与失败判定。
          if (self.form.shell().dirty === true) {
            return Promise.resolve(self.form.save()).then(function () {
              return self.form.shell().failed !== true;
            }, function () {
              return false;
            });
          }
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
          retryCatalog: function () { self.catalogStatus = "idle"; self.loadCatalog(); },
          save: function () { self.save(); },
          discard: function () { self.discard(); }
        });
      };

      ModelPoolController.prototype.dispose = function () {
        if (this.unsubscribe) this.unsubscribe();
        this.form.dispose();
      };

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
                      children: [
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
          jsx(primitives.SettingsValueField, {
            id: "smp-strategy",
            label: "分配策略",
            hint: "fewest-active：挑当前占用数最少的候选；least-recently-used：挑最久未被占用的候选。",
            overriddenLabel: "已覆盖",
            resetLabel: "恢复默认",
            invalidLabel: "请填 fewest-active 或 least-recently-used。",
            disabled: disabled,
            ...state.strategy,
            onEdit: function (text) { props.edit("strategy", text); },
            onReset: function () { props.resetField("strategy"); }
          }, "strategy"),
          jsxs("div", {
            className: "smp-control",
            children: [
              jsx("span", { className: "smp-label", children: "候选模型" }),
              jsx("p", {
                className: "smp-hint",
                children: "勾选即加入池。并发上限指该模型可同时被几个子代理占用，默认 " + DEFAULT_MAX_CONCURRENT + "。全部占满时回退父会话路由。"
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

      function apply(ctx) {
        registerSettings(ctx);
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
        normalizePools: normalizePools,
        buildGroups: buildGroups,
        poolKey: poolKey
      };
      return module.exports;
    }
  });
})();
