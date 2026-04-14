# Sentinel 流水线：已知缺口与已实施修复

本文档与 [产品信条：结果偏差即系统责任](./anthropic-harness-alignment.md#产品信条结果偏差即系统责任) 一致：**生成效果与用户合理预期不符时，优先归因于分析、约束、上下文、生成、物化、校验、编排等环节**，并在此记录历史上暴露的问题与代码侧对策。

## 1. 问题清单 → 根因环节 → 修复状态


| #   | 现象                                     | 根因环节             | 修复 / 缓解                                                                                                                                                                  |
| --- | -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | CSO 中 `fileContents` 恒为 0，实现器「看不见」已有工程 | **上下文**          | `contextStateService`：`readFileContentsAsync`；`allowedFiles` 为空 → 仅 bootstrap；**非空** → 用户路径 **并上** bootstrap（避免只有深路径时读不到 `package.json`）；**多根**选读盘根；**物化后** `sentinelKernelService` 将写入路径 **合并** 进 `intentCard.allowedFiles`；验证门 npm 与 CSO 同选根策略（`sentinelWorkspaceRootPick`）。 |
| 2   | 多节点物化互相覆盖 `package.json`、入口，后序步骤拆掉前序   | **物化 + 规划**      | `sentinelKernelService`：`mergePackageJsonStrings` 合并依赖；入口文件已存在时跳过覆盖；Implementer 提示约束脚手架文件。**规划**侧仍应避免每步输出整包入口（见 Planner 提示）。                                             |
| 3   | 漂移检测长期「尚未覆盖全部成功标准」但节点仍 completed       | **校验 + 内核**      | `runGoalDriftCheck`：仅在 **显式传入已满足条件子集** `matchedCriteria.length > 0` 时，才对剩余条件报「未覆盖」；内核不再伪造 `[successCriteria[0]]`。避免恒假阳性。                                                 |
| 4   | `npm run build` / 错误 import（如不存在图标）仍放行 | **校验**           | `verifyNpmBuildAfterImplement`（harness，**enabled 时默认 true**）：对 **implement/project** 节点在验证包中无头执行 `npm run build`，失败则 **blocking**，节点 **blocked**。                        |
| 5   | Reviewer 输出 `BLOCK` 仅作 advisory，不挡门禁   | **校验**           | `strictVerification: true` 时：Reviewer 裁定为 **BLOCK** 时，将审查问题标为 **blocking**（或注入一条阻塞项），使 `overallStatus` 可为 **blocked**。                                                   |
| 6   | 超大目标（如「完整 Figma」）一次 DAG 交付，交互缺失        | **分析 + 规划 + 校验** | Analyst / Planner 提示：**强制分期**、每步 **可测 DoD**、禁止单轮声称完成全产品；构建门禁拦截不可编译交付。**交互 E2E** 仍依赖 `behavioralE2E` / 浏览器 MCP（见对齐文档）。                                                    |
| 7   | 模型臆造 `@ant-design/icons` 等导出           | **生成 + 校验**      | Implementer 提示：**禁止臆造图标名**；构建失败由 #4 拦截。                                                                                                                                  |
| 8   | 联网搜索 0 条                               | **生成环境 / 工具**    | 依赖 GLM 与网络配置；流水线侧通过 **构建 + LSP** 降低「静默错误代码」占比。                                                                                                                           |


## 2. Harness 配置项（摘录）


| 字段                                  | 含义                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `materializeMergePackageJson`       | 物化时合并已有 `package.json` 依赖（默认开）。                                                                                              |
| `materializeSkipExistingEntryFiles` | 已存在 `src/App.tsx` / `src/main.tsx` / `index.html` 时跳过整文件覆盖（默认开）。                                                             |
| `verifyNpmBuildAfterImplement`      | **implement/project** 节点验证阶段执行 `npm run build`（`harness.enabled` 时默认开，可 `false` 关闭）。                                         |
| `strictVerification`                | **Zero-Warning**：LSP 警告视为阻塞；**且** Reviewer 裁定 **BLOCK** 时审查项全部 `blocking`（无具体问题条时也会注入一条阻塞项）。与「仅拦 build、不拦 warning」不可兼得，按需开启。 |
| `verifyPackageScripts`              | 无头执行 lint/test（与 build 独立，可同时开）。                                                                                             |
| `autoSkipBlockedNodesOnRunAll`      | 默认 `false`：`runAll` 验证阻塞重试耗尽后**中止**不假完成；`true` 恢复旧「自动跳过」阻塞节点。                                                                 |
| `verificationWarningBlocksCompletion` | 默认 `false`：`true` 时验证包 `overallStatus === 'warning'` 仍将节点标 **blocked**（否则 warning 可 completed）。                                        |
| `driftNonPassBlocksCompletion`     | 默认 `false`：`true` 时漂移 `status !== 'pass'` 将节点标 **blocked**。                                                                 |


## 3. 仍为产品演进项（未声称已完全解决）

- **意图级**把「Figma 级」自动拆成多 Intent / 多 Sprint，并 **自动回写 feature passes**（分期与 `SPLIT_INTENT` 已落地，全自动 passes 仍随业务扩展）。
- **Verifier 结构化准则（深化）**：P0 已打通 `matchedSuccessCriteria` → `runGoalDriftCheck`；**warning 时**可解析 Verifier 输出中的 **`matchedSuccessCriteria` JSON**（见 `verificationVerifierCriteriaParse.ts`）；模型漏写或格式错误时仍回退文本包含；更细的 warning 分级等仍可增强（见 [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md) HGT-004）。
- **设计工具类**专用验收：画布/图层等 **浏览器 E2E** 见 [templates/design-tool-e2e-assertions.md](./templates/design-tool-e2e-assertions.md)，随项目补充选择器。

## 4. 相关源码路径（便于审计）

- **完善项总索引（逐项修改入口）**：[improvement-master-checklist.md](./improvement-master-checklist.md)
- **终态差距任务拆分（HGT-xxx）**：[harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md)  
- 跨端导出（IR、模板、`exports/`、可选 Web `npm run build` 门禁）：见 [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md)「实施状态」节  
- `src/vs/workbench/sentinel/browser/contextStateService.ts` — CSO  
- `src/vs/workbench/sentinel/common/sentinelWorkspaceRootPick.ts` — 多根工作区选根（`pickWorkspaceFolderByProbes`：CSO + npm/验证共用）  
- [harness.example.json](./harness.example.json) — 工作区 `.sentinel/harness.json` 示例（复制后按需改）  
- `src/vs/workbench/sentinel/browser/sentinelKernelService.ts` — 物化、漂移调用  
- `src/vs/workbench/sentinel/common/packageJsonMerge.ts` — package 合并  
- `src/vs/workbench/sentinel/browser/sentinelNpmScriptRunnerService.ts` — npm 脚本执行  
- `src/vs/workbench/sentinel/browser/verificationGateService.ts` — 验证包、build 门禁、Reviewer BLOCK  
- `src/vs/workbench/sentinel/browser/executionGraphService.ts` — `runGoalDriftCheck`  
- `src/vs/workbench/sentinel/browser/workerRuntimeService.ts` — Worker 系统提示  
- `src/vs/workbench/sentinel/common/harnessTypes.ts` / `harnessConfigService.ts` — 配置默认值

## 5. 方法论参照（稳定性 / 反馈 / 扰动）

从「工程控制论」视角对 **模型失配、观测误差、时延** 等与 Harness 验收项的对照，见 [engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md)（与本文 §1 问题清单互补：后者偏现象与修复，前者偏评审锚点）。

与 **何时不自动 / 失败与成功同权 / 评判可独立** 相关的默认策略，见 [product-principles.md](./product-principles.md)。

