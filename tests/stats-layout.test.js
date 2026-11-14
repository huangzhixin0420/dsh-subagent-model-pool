// 统计页纵向布局的回归防线。
//
// 背景（v0.4.2）：.smpv-body 是 flex column，三个子块（指标条 / 双栏 /
// 会话明细）默认 flex-shrink:1。会话记录变多后明细表内容变高，flex 分配
// 先把指标条挤扁——实测 200 条会话时指标条从 104px 压到 4px，「509M」这个
// 数字整体被裁到容器外（可见高度 −27px，肉眼等于消失）。
//
// CSS 没法在 node 里渲染，所以这里断言的是「规则本身」：谁能伸缩、谁不能。
// 只要有人把 flex:none 改回默认、或把 sessions 的 basis 从 0 改回 auto，
// 这些用例就会红——那是这条 bug 复发的唯一路径。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** 取出 STATS_CSS 里某个选择器的第一条规则体。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`"${escaped}\\{([^}]*)\\}`, "m"));
  return match === null ? null : match[1];
}

/** 某个选择器的规则里是否含某条声明。 */
function hasDecl(selector, decl) {
  const body = ruleBody(selector);
  return body !== null && body.includes(decl);
}

// ---- 上层三块：永远不许被压缩 ----

test("指标条不被压缩（flex:none）", () => {
  assert.ok(
    hasDecl(".smpv-cards", "flex:none"),
    ".smpv-cards 缺 flex:none：会话记录一多就会把指标条挤成一条线（v0.4.2 修的 bug）",
  );
});

test("双栏区不被压缩（flex:none）", () => {
  assert.ok(
    hasDecl(".smpv-grid", "flex:none"),
    ".smpv-grid 缺 flex:none：路由分布与池占用会被会话表挤没",
  );
});

test("页头不被压缩（flex:none）", () => {
  assert.ok(
    hasDecl(".smpv-head", "flex:none"),
    ".smpv-head 缺 flex:none：现在靠 min-height:auto 隐式兜底，写死更稳",
  );
});

// ---- 会话明细：唯一允许伸缩的块 ----

test("会话明细的 flex-basis 是 0 不是 auto", () => {
  const body = ruleBody(".smpv-sessions");
  assert.ok(body !== null, "找不到 .smpv-sessions 的规则");
  assert.ok(
    body.includes("flex:1 1 0%"),
    `.smpv-sessions 应为 flex:1 1 0%，实际规则体：${body}`,
  );
  assert.ok(
    !body.includes("flex:1 1 auto"),
    "flex-basis:auto 会把表格内容高度当基准，把同级指标条挤扁——这正是 v0.4.2 的根因",
  );
});

test("会话明细保留最小高度，矮视口下不至于塌成 0", () => {
  assert.ok(
    hasDecl(".smpv-sessions", "min-height:180px"),
    "min-height:180px 是「至少能看到约 4 行」的保底，删掉后矮视口下表格会归零",
  );
});

// ---- 移动端：sessions 必须改成不伸缩 ----

test("移动端会话明细显式 flex:none", () => {
  const mobile = source.slice(source.indexOf("@media (max-width:767px)"));
  assert.ok(
    mobile.includes(".smpv-sessions{flex:none;min-height:0}"),
    "移动端必须写 flex:none：基础规则是 flex:1 1 0%，手机上会话区高度会算成 0，" +
      "而 .smpv-tableWrap 是 overflow:visible，记录一多就溢出绘制到安全区上" +
      "（实测 sessions 高 0、内容 33540px）",
  );
});

// ---- 空态密度 ----

test("指标格空副文本不占 30px 高度", () => {
  assert.ok(
    source.includes(".smpv-cardSub:empty{min-height:0}"),
    "空态四格都没有副文本时，min-height:30px 会白留一整行；:empty 兜住",
  );
});
