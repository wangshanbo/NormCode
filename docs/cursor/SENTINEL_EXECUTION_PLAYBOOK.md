# Sentinel 长程任务执行文档说明

## 文档放哪

| 位置 | 说明 |
|------|------|
| **工作区** `.sentinel/EXECUTION_RUNBOOK.md` | 运行时主文档：首次执行 Sentinel 节点时自动创建；**每完成一个节点自动追加一行流水**。 |
| 本文 `docs/cursor/SENTINEL_EXECUTION_PLAYBOOK.md` | 仓库内说明与里程碑清单参考，可与工作区文件对照。 |

## 怎么用

1. **里程碑（防遗漏）**  
   打开 `.sentinel/EXECUTION_RUNBOOK.md` 上半部分的 **「里程碑清单」**，按改造/需求进度把 `[ ]` 改成 `[x]`。  
   清单覆盖 M1–M6（全自动闭环、上下文与对抗、工具与权限、工程确定性、验证、可观测性）。

2. **执行流水（自动标记）**  
   每次 Sentinel **节点结束**（成功 / 验证阻塞 / Harness 失败），系统会在 **「执行流水（自动生成）」** 下追加一条，包含：时间、Intent、节点名与 ID、类型、结果、验证摘要等。  
   **无需手改流水区**，避免与自动化冲突。

3. **与 `task_state.json` 的关系**  
   `task_state.json` 存机器可读状态；`EXECUTION_RUNBOOK.md` 面向人类复盘与核对里程碑，两者互补。

## 实现位置

- 服务：`vscode/src/vs/workbench/sentinel/browser/executionDocService.ts`
- 挂载：`SentinelKernelService.executeNode` 正常结束、Harness 早退、`failNodeHarness` 均会调用 `recordNodeCompletion`。

## M1–M4 全量 Harness 配置

将 `docs/cursor/HARNESS_M1_M4.example.json` 复制到工作区 **`.sentinel/harness.json`** 并按需修改。主要能力包括：

- **autoRun**：`ingestPrompt` 后自动 `confirmAndExecute`（最短全自动路径）
- **promoteAfterVerified**：实现节点验证通过后，将 `sentinel-staging` 合并到工作区
- **implementationPlanRequired**：实现前生成并校验 `IMPLEMENTATION_PLAN.json`
- **statelessExecution / reviewerIsolation**：物理重置 CSO 与审查隔离
- **mcp_allowlistFile**：配合 `docs/cursor/mcp_allowlist.example.json` 复制为 `.sentinel/mcp_allowlist.json`
- **verifyPackageScripts / hintNpmScripts**：验证门附带 `package.json` 脚本提示（L2 需在终端执行 npm）
- **exportBundleOnComplete**：全流程跑完后导出 `.sentinel/export/bundle_*.json`
- 命令面板：**Sentinel: Export Harness Bundle**
