# HGT-050～052 收敛清单（编排 / 配置 / 入口）

## HGT-050 编排边界

- [x] DAG 中是否存在仅「替模型决策」却无验收边的节点 — **持续审计项**，方法论见 [`engineering-cybernetics-harness-mapping.md`](./engineering-cybernetics-harness-mapping.md)。
- [x] 文档写明 **Workflow（确定性闸门）** vs **Agent（模型+工具）** 的边界 — 以上述映射文档为单一说明源。

## HGT-051 假完成配置

- [x] `aiCore.*` 与 `harness.json`：新增配置须带实现或默认关；本迭代新增 `aiCore.sentinel.desktopNotifyOnNodeComplete`（默认 **false**，接 `INotificationService`）。
- [x] 跨端实验项 `aiCore.crossPlatform.runNpmBuildGateOnWebExport` 保持默认 **关**，行为与描述一致。

## HGT-052 重复入口

- [x] **项目预览 / 跨端 manifest**：单一命令 `aicore.openProjectPreview`（`projectPreview.contribution.ts`），状态源为 `.sentinel/cross-platform-export.json`；Sentinel 跑完后可选自动打开，见 `aiCore.crossPlatform.openProjectPreviewAfterSentinelComplete` + `sentinelKernelService.tryAutoPreview` — **不**再增加第二条「打开预览」命令。
- [x] 用户路径：命令面板 →「AI Core: Open Project Preview」与 Sentinel 完成回调共用同一预览与 manifest。

---

*版本：2026-03-29（与实现同步）*
