# HGT-021：设计工具类 E2E 断言模板（浏览器 MCP）

以下为 Verifier 工具环可复用的断言思路，需结合 `mcp_call` + `cursor-ide-browser`（或等价）在**真实页面**执行。

## 画布 / 图层

1. **元素存在**：快照中可见 `[data-testid="canvas"]` 或主画布选择器。
2. **z-order**：选中两个图层后，通过 computed style 或内部状态 API（若暴露）比较 `z-index` / 堆叠顺序。
3. **拖拽**：`browser_drag` 从 A 到 B，断言位置或 `transform` 变化。

## 最小可运行集

- 页面无控制台 `error` 级日志（需读 browser console）。
- 首屏关键按钮可点击（`browser_click` + 快照前后对比）。

将具体选择器与项目 `data-testid` 约定写在各仓库的 `.sentinel/verifier_e2e_notes.md`（自建）。

## 与仓库脚本的衔接（HGT-021）

- 仓库内提供 **`scripts/design-tool-e2e-smoke.mjs`**（仅校验 MCP/浏览器前置条件与打印检查表），**不替代**真实 E2E。
- CI 或本地可：`node scripts/design-tool-e2e-smoke.mjs`（在含该脚本的工程根执行）。

---

*版本：2026-03-30*
