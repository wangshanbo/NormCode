# 自研 IDE 应用能力总览

> **文档性质**：描述当前代码库中**已实现并可供用户/工作区配置使用**的能力，作为对内说明与对外（内测）说明的单一事实源之一。  
> **范围**：基于 VS Code / Code-OSS 扩展的 **AI Core**、**Sentinel**、**跨端导出** 及关联子系统；不含微软上游未改动的通用编辑器能力（除非与上述模块强相关）。  
> **原则**：**工程确定性**——职责与 `WorkerRole` / 内核路径一致；用 **节点输出契约** 描述模型侧约束，避免人格化叙事替代可执行逻辑。  
> **更新**：与仓库实现同步维护；**已知缺陷与缓解** 见 **§6**；缺口索引见 [improvement-master-checklist.md](./improvement-master-checklist.md)、[pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md)、[harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md)。

---

## 1. 产品形态与架构分层

| 层级 | 说明 | 状态 |
|------|------|------|
| **壳** | 标准 IDE：工作区、编辑器、终端、扩展宿主等（上游 Code-OSS）。 | [已实现] |
| **AI Core** | 以 **GLM** 为主力的对话、路由、Agent 工具环、代码索引、联网搜索、Spec/Vibe 模式、项目预览与部分质量工具。 | [已实现] |
| **Sentinel** | 「意图 → 执行图 → Worker → 物化 → 验证门」编排；控制平面、内核状态机、Harness、成本与活动流。部分 **Kiro 级信息透明** 能力仍为演进项（HGT-030～035）。 | [已实现] / 部分 UI [路线图计划] |
| **跨端导出** | 定稿后生成 `exports/`、IR/manifest、校验门；各端「上架级」硬门禁与 **Golden Path 签字** 依赖路线图与业务验收。 | [已实现] 主链路 / 多端硬门禁 [部分实现] |

---

## 2. AI Core 能力

**状态图例**（与 §3.2 / §4 / §5 一致）：**[已实现]** 配置或代码路径可用；**[试点中]** 行为或默认策略仍可能调整；**[部分实现]** 主路径可用，各端/边界/一致性未全覆盖；**[路线图计划]** 未作为本文件承诺的交付项。

### 2.1 模型与路由

| 能力 | 配置 / 行为摘要 | 状态 |
|------|-----------------|------|
| **默认 GLM 栈** | `aiCore.useGLM`、`aiCore.glmModel`、`aiCore.glmApiKey` | [已实现] |
| **Chat 内自动路由** | `aiCore.enableAutoModelRouting` + `routingModelSimple\|Medium\|Hard` | [已实现] |
| **视觉路由** | `aiCore.enableVisionRouting`、`routingVisionModel*` | [已实现] |
| **子代理与并行** | `aiCore.enableSubagents`、`enableParallelTaskExecution`、`maxParallelSubagents` | [已实现] |
| **与 Sentinel 的路由关系** | Chat/AI Core 路由与 **Sentinel `routingService`**（意图节点 tier）**独立**；合并策略以用户场景为准 | [已实现]（边界说明） |

### 2.2 对话模式与执行模式

| 能力 | 配置 / 行为摘要 | 状态 |
|------|-----------------|------|
| **默认聊天模式** | `aiCore.defaultChatMode`：`vibe` / `spec` | [已实现] |
| **Spec Mode** | `specModeService` 与 Chat 集成；命令面板切换 | [已实现] |
| **Agent 与工具** | `aiCore.agentMode`：读写文件、终端等 | [已实现] |
| **执行模式** | `aiCore.executionMode`：`autopilot` / `supervised` | [已实现] |
| **深度思考** | `aiCore.enableThinking` | [已实现] |
| **联网搜索** | `aiCore.enableWebSearch`、`aiCore.searchEngine` | [已实现] |

### 2.3 代码索引与上下文

| 能力 | 配置 / 行为摘要 | 状态 |
|------|-----------------|------|
| **工作区索引** | `aiCore.index.enabled`、`aiCore.index.autoIndex`（@codebase 等） | [已实现] |
| **长上下文告警** | `aiCore.contextEstimatedCharsWarn`；策略见 [harness-context-strategy.md](./harness-context-strategy.md) | [已实现] |
| **与 Sentinel CSO 的关系** | 二者为不同子系统；同仓编辑时注意 **上下文来源**（Chat 索引 vs Sentinel `contextStateService`） | [已实现]（边界说明） |

### 2.4 项目预览与跨端（用户侧）

| 能力 | 配置 / 行为摘要 | 状态 |
|------|-----------------|------|
| **项目预览** | `aicore.openProjectPreview`、`aiCore.projectPreview.url`、`openBeside` | [已实现] |
| **IR 快照** | `aicore.snapshotCrossPlatformIR` | [已实现] |
| **Sentinel 完成后自动预览** | `aiCore.crossPlatform.openProjectPreviewAfterSentinelComplete` | [已实现] |
| **导出 Web 后 npm build 门禁** | `aiCore.crossPlatform.runNpmBuildGateOnWebExport`（工作区根执行） | [试点中] 实验 |
| **节点完成系统通知** | `aiCore.sentinel.desktopNotifyOnNodeComplete` | [已实现] |

### 2.5 旧版侧栏（可选）

| 能力 | 配置 / 行为摘要 | 状态 |
|------|-----------------|------|
| **旧版 AI CHAT / SPECS** | `aiCore.enableLegacySideViews`（默认关） | [已实现] |

### 2.6 AI Core 命令与工具（摘录）

以下为已注册命令的代表性分组（完整列表以 `CommandsRegistry` 为准）。**整体** [已实现]；单项是否适用于当前工作区取决于扩展与配置。

| 领域 | 命令 ID（示例） | 状态 |
|------|-----------------|------|
| Chat Webview | `aicore.openChatWebview` | [已实现] |
| Spec / 任务 | `aicore.openSpecsPane`、`aicore.newSpec`、`aicore.vibeToSpec`、`aicore.executeTask`、`aicore.executeAllTasks`、`aicore.openSpecRequirements` / `Design` / `Tasks` 等 | [已实现] |
| 任务图 / TDD | `aicore.openTaskGraph`、`aicore.buildTaskGraph`、`aicore.runTDD`、`aicore.createCheckpoint`、`aicore.rollbackCheckpoint` | [已实现] |
| 代码质量 | `aicore.buildCodeGraph`、`aicore.runAutoFix`、`aicore.verifyCode`、`aicore.redTeamReview`、`aicore.buildASTIndex`、`aicore.parseCurrentFile` | [已实现] |
| 其它 | `aicore.openCostDashboard`、`aicore.routeTask`、`aicore.refineIntent`、`aicore.buildDomainOntology` | [已实现] |

**[路线图计划]（本段不展开为产品承诺）**：多供应商模型抽象、与外部 IDE 设置完全同步等，见 [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md) HGT-041 等条目。

---

## 3. Sentinel 能力

### 3.1 控制平面 UI

| 能力 | 说明 | 状态 |
|------|------|------|
| **核心视图** | `Sentinel Control Plane` Webview：意图列表、阶段、IntentCard、成本、执行控制、验证门、工件、推理链、活动流 | [已实现] |
| **P3 洞察** | 物化列表、节点耗时、DAG 依赖只读展示 | [已实现] |
| **Diff / 细粒度依赖编辑** | 与 Kiro 完全对齐的一键 Diff、依赖拓扑编辑等 | [路线图计划] 见 HGT-030～034 |
| **交互** | 创建意图、确认并执行、全链路、暂停/恢复、重试/回滚、演示数据、导出 Harness 包（命令见 §3.5） | [已实现] |

### 3.2 内核编排（`sentinelKernelService`）与 WorkerRole 对齐

以下按 **`workerRuntimeService` / 内核** 真实行为描述；**不**把 Harness 级成本、路由策略塞进 Verifier 的职责里。

#### 3.2.1 `WorkerRole` 职责边界（严禁跨职责）

| 角色 | 职责（实现侧） | 成本 / 路由 |
|------|------------------|-------------|
| **Analyst** | 需求分析单轮 LLM：`enableWebSearch`；输出结构化小节与机器可读行（见 §3.2.2）。解析入 `RequirementAnalysis`，经 `buildCapabilityAnchorTail` 注入下游 Intent 文本。 | **不属于** Analyst；成本由账本与路由统一处理。 |
| **Planner** | 将意图拆解为 **STEP 列表**；输出 **`DEPENDENCY_WHITELIST:`** 并由内核合并到 `IntentCard.constraints`（`[Planner] 依赖白名单:`）。 | **`BUDGET_HINT`** 仅为提示词内软说明；**硬预算**见 `softTokenBudgetTotal` 与 `routingService.route(..., { budgetDegrade })`。 |
| **Implementer** | 按节点产出 **`### FILE:`** 物化块；不负责「最终裁定是否放行」。 | 同左。 |
| **Reviewer** | 对抗性审查：PASS/WARN/BLOCK、影响面；提示词可要求 **`LICENSE_AUDIT:` / `SECRET_SCAN:`**（**启发式**，非扫描器）。 | 同左。 |
| **Verifier** | 综合证据、**PASS/BLOCK**、`matchedSuccessCriteria` JSON（HGT-004）、漂移链；可含 **`BOUNDARY_TEST:`** 建议。 | **不包含** Token 预算分配或「成本控制专家」叙事。 |
| **Tester / Refiner** | 测试代码与工件整理（若启用默认图中对应节点）。 | 同左。 |

#### 3.2.2 节点输出契约（由提示词约束、内核解析）

「专家组」在产品中落实为 **固定章节与机器可读行**，便于解析与下游对齐（**非**多模型人格并行）。

| 节点 | 契约要点 | 状态 |
|------|-----------|------|
| **Analyst** | `## 专家组联合研判`（含 `PANEL_ROLE:` / `SEARCH_PLAN:`）→ `## 联网检索与对标`（`WEB_FACT:`）→ 能力锚点 `CAP_*` → **`FEATURE_MATRIX:`**（可多条）→ **`TECH_STACK_CONTRACT:`** / **`SCALABILITY_PLAN:`** 等。解析字段：`expertPanelSummary`、`webResearchSummary`、`featureMatrixItems`、`techStackContract`、`scalabilityPlan` 等。 | [已实现] |
| **Planner** | **`## 依赖白名单`** + `DEPENDENCY_WHITELIST:`（每行一个 npm 包名）；再输出 **`## STEP n:`**；可选 `STEP_DEP:`、`BUDGET_HINT:`。Planner **基于 Analyst 已注入的规格与栈契约**拆解步骤；**依赖白名单由 Planner 产出**（非 Analyst 产出白名单）。 | [已实现] |
| **Implementer** | 仅 **`### FILE:`** 块；关键路径须有 **内联注释**（提示词级）。 | [已实现] |
| **Reviewer** | 审查结论 + 可选 **`LICENSE_AUDIT:`** / **`SECRET_SCAN:`**（LLM 自述，**非** CI）。 | [试点中] 提示词级 |
| **Verifier** | `## 最终裁定` + **`matchedSuccessCriteria` JSON** + 可选 **`BOUNDARY_TEST:`**。 | [已实现] / Playwright 管线见 HGT-026 [试点中] |
| **自动化 LICENSE / 密钥扫描（npm audit、license 扫描器）** | — | [路线图计划] |
| **视觉回归 / 像素级对比** | — | [路线图计划]（与 [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md) 阶段目标一致） |

若 Analyst 输出缺少 **`CAP_PRIMARY`** 或 **`TECH_STACK_CONTRACT:`**，内核记 **warning** 活动项，**不**自动重跑分析（Analyst 路由已为高 tier；节点失败时的模型升级见 §3.2.4）。

#### 3.2.3 物化根与验证上下文（Worktree / 多根一致）

- **物化**：`### FILE` 写入 **主仓根**、**`.sentinel/worktrees/<intentId>`（`taskIsolation: worktree`）** 或 **影子 staging**（`stagingWrites`）；`package.json` 合并与入口跳过策略见实现。  
- **CSO**：`taskIsolation: worktree` 且隔离目录就绪时，`workspaceRootOverride` 指向 **隔离根**，与物化一致。  
- **验证门 `npm run build` / `package.json` 脚本**：`verificationGateService` 通过 **`pickWorkspaceFolderForNpmScripts`**（与 CSO 选根策略 **同源探测**）选择文件夹，使 **构建与诊断尽量针对同一工作区根**，避免「写在 A 根、编在 B 根」。多根工作区见 [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) #1。  
- **试点**：完全 worktree 化与边界仍见 [harness-task-isolation-pilot.md](./harness-task-isolation-pilot.md)。

#### 3.2.4 路由、预算降级与 Escalation（可执行逻辑）

- **初次路由**：`routingService.route(intent, node, options)` → 按 **角色与风险** 映射 **tier**（`fast` / `balanced` / `power`），再映射 **`modelId`**（`modelRouterService.getModelByTier`）。Analyst / Planner / Reviewer / Verifier 等默认走 **较高 tier**（见 `routingService.selectTier`）。  
- **软预算降级（HGT-010）**：当启用 `softTokenBudgetTotal` 等且判定超预算时，`route(..., { budgetDegrade: true })` 将 **tier 下调一档**（`budgetDegrade` 为真），避免与账本双重计数冲突。  
- **失败 Escalation**：`executeNode` 内若 Worker **失败**，调用 **`escalateOnFailure(intent, node, failureLog, previousDecision)`**：在 **fast → balanced → power** 上 **升一档** 换模型 **重试同一节点**；已在 **power** 则 **不再升**（日志告警）。**自动修复回路**中亦可再次 `escalateOnFailure`。  
- **自愈**：`autoRepairOnFailure`、验证阻塞与 `checkpointLedgerService` / `autoRollbackOnVerifyFailure` 等为 **Harness 配置项**，与「人格」无关；详见 `harness.example.json` 与 [product-principles.md](./product-principles.md)。

#### 3.2.5 其它内核行为（摘录）

- **全栈交付约定（提示词级）** [已实现]：涉及持久化/账号等时，Analyst「技术方案」侧规划 Node、关系型 DB、`docker-compose.yml` 等；Planner 按目录域拆 STEP；Implementer 落盘。纯静态则显式边界。  
- **阶段机** [已实现]：`SentinelPhase`（idle → 分析 → 确认 → 规划 → 执行 → 验证/投影 …）。  
- **执行图** [已实现]：DAG，`implement` / `verify` 等；动态图来自 Planner 输出解析（`executionGraphService.parsePlannerOutput`）。  
- **验证门** [已实现]：`VerificationBundle`、漂移 `runGoalDriftCheck`、可选 `npm run build`、`strictVerification` 等（见 pipeline）。  
- **Analyst 结构化重试** [已实现]：`harness.enabled` 且首跑未解析到 `CAP_PRIMARY` / `TECH_STACK_CONTRACT` 时，**自动重试 Analyst 一次**（goal 追加系统补述后恢复原文）。  
- **行为 E2E** [试点中]：`behavioralHarnessService`。  
- **导出 Harness 包** [已实现]：`exportBundleOnComplete` 等。  
- **活动流 / `harnessRuntime` 快照** [已实现]：`ActivityEntry.severity`、`materializedFilesByIntent`、`lastMaterializeRoot` 等。

### 3.3 工作区 Harness（`.sentinel/harness.json`）

由 `harnessConfigService` 解析；**`enabled: true` 时**多项默认强化（staging、协商、ADR、**`strictVerification`（未显式写 `false` 时默认为 true，与 pipeline #5 对齐）** 等，见实现）。可复制示例骨架：[harness.example.json](./harness.example.json) → 工作区 `.sentinel/harness.json` 后按需删减字段。主要能力开关（完整默认值见 `ResolvedHarnessConfig`）：

| 类别 | 字段（节选） |
|------|----------------|
| 总开关 | `enabled` |
| 写入策略 | `stagingWrites`、`promoteAfterVerified`、`taskIsolation`（`none` \| `worktree`） |
| 闸门 | `negotiationRequired`、`adrGate`、`implementationPlanRequired`、`strictVerification` |
| 自动化 | `autoRun`、`skipUserConfirmation`、`statelessExecution`、`humanGateAfterAnalysis`、`splitLargeGoalsAutoCreate` |
| 工具环 | `implementerAgentToolLoop`、`verifierAgentToolLoop`、`agentToolMaxIterations`、`autoRepairOnFailure` … |
| 物化 | `materializeMergePackageJson`、`materializeSkipExistingEntryFiles` |
| 验证 | `verifyNpmBuildAfterImplement`、`verifyPackageScripts`、`behavioralE2E`、`verificationWarningBlocksCompletion`、`driftNonPassBlocksCompletion` |
| 编排 | `autoSkipBlockedNodesOnRunAll`（`runAll` 遇阻塞是否自动跳过节点）；`defaultExecutionGraphIncludeVerify`（`enabled` 时默认 true：默认图与动态图在实现后追加 **verify** 节点） |
| 成本 / 审计 | `softTokenBudgetTotal`；审计见 `harnessAuditLogService` |
| 产物路径 | `featureRegistryPath`、`progressLogPath`、`evaluatorRubricPath`、`mcpAllowlistFile`；HGT-026：`evaluatorPipelineEnabled` + `evaluatorPlaywrightDir`（`.sentinel/last_playwright_report.json`） |
| Git | `gitSnapshots`、`suggestGitCommitAfterNode`、`gitCommitAfterNode`（与 `pending_git_commands.jsonl` 脚本配合） |
| 其它 | `exportBundleOnComplete`、`anthropicHarnessParity`、`designCollisionPass` … |

产品原则与字段对照见 [product-principles.md](./product-principles.md)。

**配置与已知缺陷（读 harness 前必看）**

| 现象 / 风险 | 缓解（Harness） | 说明 |
|-------------|-----------------|------|
| Reviewer 输出 `BLOCK` 但不挡最终门禁 | **`enabled: true` 时默认 `strictVerification` 为开**；需宽松迭代可显式 **`"strictVerification": false`** | `enabled: false` 或未开 harness 时默认仍为关；见 [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) #5 |
| `warning` 验证仍标节点完成 | 按需开启 **`verificationWarningBlocksCompletion`** / **`driftNonPassBlocksCompletion`** | 默认 warning 可不阻塞；见 pipeline §2 |
| 多节点覆盖 `package.json` / 入口 | **`materializeMergePackageJson`**、**`materializeSkipExistingEntryFiles`** + Planner 分域 | 仍依赖规划质量；见 pipeline #2 |
| 超大目标一次 DAG 假完成 | Analyst **`SPLIT_INTENT`**、构建门、**`humanGateAfterAnalysis`** | 交互 E2E 非默认全自动；见 pipeline #6 |

### 3.4 任务隔离脚本（仓库级）

| 脚本 | 作用 |
|------|------|
| `scripts/sentinel-worktree.mjs` | 创建/维护 `.sentinel/worktrees/<intentId>`，供 `taskIsolation: worktree` 使用。 |
| `scripts/sentinel-git-commit.mjs` | 消费 `pending_git_commands.jsonl` 在隔离目录执行提交类操作（与配置配合）。 |
| `scripts/sentinel-cross-platform-gates.mjs` | 本机/CI：按 `--workspace` `--target` 做可选构建或探测（与跨端路线图一致）。 |

### 3.5 Sentinel 命令（命令面板）

| 命令 ID | 用途（摘要） |
|---------|----------------|
| `sentinel.createIntent` | 创建意图 |
| `sentinel.advanceActiveIntent` | 推进当前意图 |
| `sentinel.runFullPipeline` | 全链路 |
| `sentinel.pauseExecution` / `sentinel.resumeExecution` | 暂停 / 恢复 |
| `sentinel.seedDemoState` | 演示数据 |
| `sentinel.rollbackNode` | 节点回滚 |
| `sentinel.exportHarnessBundle` | 导出 Harness 包 |

---

## 4. 跨端导出能力

与 [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md)「实施状态」表一致；下列为 **能力级** 标注（非每文件承诺）。

| 能力 | 路径 / 行为摘要 | 状态 |
|------|-----------------|------|
| **Manifest** | `.sentinel/cross-platform-export.json`（定稿、目标端、`runs` 等） | [已实现] |
| **IR 快照** | `.sentinel/cross-platform-ir.json`；`crossPlatformIrSnapshotService`、`aicore.snapshotCrossPlatformIR` | [已实现] |
| **分端脚手架 + LLM 落盘** | `exports/` 下 web、ios、android、wechat_miniprogram 等 `project/`、`GENERATION.md`、解析器落盘 | [已实现]（首版） |
| **构建与验证门** | `crossPlatformGates.ts`；各端探测 **程度不一**；Web 可选 `npm build`（常与 `aiCore.crossPlatform.runNpmBuildGateOnWebExport` 联动） | [部分实现] 见路线图阶段 4 |
| **单 target 失败回滚目录** | 生成抛错时删 `exports/<target>/` 并写 `manifest`（HGT-025） | [已实现] |
| **Golden Path 商用签字** | 业务仓真实「定稿 → 生成 → 各端打开」 | [路线图计划] HGT-024 |
| **RN 单栈统一 iOS/Android** | 当前模板多为 Swift/Kotlin 占位 | [路线图计划] 见路线图「后续演进项」 |

**缺陷提示**：iOS/Android **真机级**构建门禁、小程序完整 CLI 校验等 **依赖本机工具链与环境**；文档不承诺「无 Xcode/AS/微信开发者工具即可全自动过审」。

---

## 5. 可观测性与合规辅助

| 能力 | 说明 | 状态 |
|------|------|------|
| **Trace** | `harnessTraceService` 关键路径日志；grep 见 [harness-trace-grep.md](./harness-trace-grep.md) | [已实现] / 覆盖面 [增强中] |
| **审计** | `harnessAuditLogService` → `.sentinel/harness-audit.jsonl` | [已实现] |
| **成本账本** | `costLedger`、控制平面成本区块；与 **HGT-010** 软预算联动 | [已实现] |
| **MCP** | 白名单、`mcpAllowlistFile`、可选同步 `.vscode/mcp.json` | [已实现] |
| **全链路可观测终态** | 与 CI/签字一致的「零遗漏」观测 | [路线图计划] 见 HGT-002 等 |

---

## 6. 已知缺陷、缓解与未实现项

### 6.1 流水线已知现象（与代码侧对策）

下列摘自 [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) §1，**未消除即视为产品仍可能复现**；对策为 **缓解** 而非数学证明。

| # | 现象（摘要） | 缓解要点 |
|---|----------------|----------|
| 1 | CSO `fileContents` 为空、实现器「看不见」工程 | 多根选根、`allowedFiles` 与 bootstrap 并集、物化后回写路径；验证与 npm **同选根** |
| 2 | 多节点物化互覆盖入口 / `package.json` | `mergePackageJson`、跳过已有入口、Planner 分域 |
| 3 | 漂移与 completed 语义 | `matchedSuccessCriteria` 与 drift 链；勿依赖恒真阳性 |
| 4 | 错误 import 仍「编译假象」 | **`verifyNpmBuildAfterImplement`**（harness enabled 时默认倾向开） |
| 5 | Reviewer `BLOCK` 不挡门禁 | **`enabled: true` 时默认 `strictVerification` 为开**；关闭 harness 或显式 `false` 时仍为缓解项 |
| 6 | 超大目标一次交付 | 分期、`SPLIT_INTENT`、构建门；E2E 非默认 |
| 7 | 臆造图标 / 包名 | Implementer 提示 + build 拦截 |
| 8 | 联网检索 0 条 | 重试与提示（HGT-022）；仍依赖环境与模型 |

### 6.2 仍为演进项（非本页「已商用」承诺）

- **Verifier JSON / 漂移深化**、**feature registry 全自动 passes**：见 pipeline §3、HGT-004/013。  
- **设计工具浏览器 E2E**：模板与选择器随项目补全。  
- **意图级全自动多 Sprint 与 passes 回写**：HGT-020 相关。  

### 6.3 状态索引与交叉引用

- 能力分级：**[已实现]** / **[试点中]** / **[部分实现]** / **[路线图计划]** — 分布在 **§1**、**§2**、**§3.1**、**§3.2**、**§3.3**（含 Harness 缺陷表）、**§4**、**§5**。  
- 任务 ID 与验收：[harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md)、[improvement-master-checklist.md](./improvement-master-checklist.md)。  
- 与 Anthropic Harness 叙事：[anthropic-harness-alignment.md](./anthropic-harness-alignment.md)。

---

## 7. 相关文档索引

| 文档 | 内容 |
|------|------|
| [product-principles.md](./product-principles.md) | 产品原则与 harness 字段 |
| [harness-context-strategy.md](./harness-context-strategy.md) | 上下文策略 |
| [engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md) | 工程控制论与 Sentinel 映射 |
| [convergence-hgt-050-052.md](./convergence-hgt-050-052.md) | 编排/配置/入口收敛 |
| [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) | 流水线已知现象与 Harness 缓解 |
| [../cursor/SENTINEL_IDE_MASTER_SPEC.md](../cursor/SENTINEL_IDE_MASTER_SPEC.md) | 历史总规（与实现可能有时间差） |

---

*版本：2026-03-30（§1/§4/§5 状态列；§3.3 Harness 缺陷表；§6：pipeline 对齐与演进项；§2/§3.2 前述版本）。若能力变更，请同步更新本节并调整 `版本` 日期。*
