# Harness 终态差距：任务拆分与里程碑

> 本文将「欠缺能力」与「已实现但不完备」拆为可执行任务，便于排期、分工与验收。  
> 背景来源：`pipeline-known-gaps-and-remediation.md`、`anthropic-harness-alignment.md`、`cross-platform-export-roadmap.md`、`docs/cursor/kiro-gap-action-plan.md` 及产品层面对终态 Harness 的讨论。

### 诚实口径（避免「文档验收 = 工程完工」）

- **下表「状态」**描述的是：**主路径是否已有可指的代码/脚本**，以及**仍常见的缺口**；**不是**「无技术债、已接 CI、已业务签字、已跑完全部 Golden Path」。
- **上一轮若出现「P0–P2 全部 ✅」类表述，应视为不准确**：大量条目在仓库里**早已有部分实现**，并非某次小 diff 一次性写完；少数条目（如 **HGT-024** 业务仓签字、**HGT-026** 独立 Evaluator 模型）**本来就不等于几行代码能收尾**。
- **合并前可证回归**：PR 已在 `.github/workflows/pr.yml` 挂载 **`harness-eval`**；本地等价：`node scripts/harness-eval/run.mjs --full`（默认跑**三个**内置夹具）。

---

## 1. 使用说明

| 字段 | 含义 |
|------|------|
| **ID** | 稳定引用（讨论/ issue 可贴 `HGT-xxx`） |
| **优先级** | P0 阻塞终态可信度；P1 核心体验与对齐；P2 规模化与生态；P3 长期差异化 |
| **依赖** | 建议的前置任务 ID |
| **验收** | 可勾选的最小完成标准 |

**原则**：先 **证明层（Eval / 观测 / 校验）** 与 **稳定层（隔离）**，再扩展 UI 与横向功能，避免「功能多但不可证」。

---

## 2. P0 — 证明、稳定、可回归（终态地基）

| ID | 任务 | 说明 | 依赖 | 验收 | 落地 | **状态** |
|----|------|------|------|------|------|----------|
| **HGT-001** | 内部 Eval 靶场（最小集） | 多夹具 + CI 触发构建与断言。 | — | 失败即红；README 说明如何加场景。 | `run.mjs` 默认跑 **minimal-workspace** + **tiny-lib** + **real-app-skeleton**（`src/`+`scripts/`+`dist/.sentinel-build-marker`）；`pr.yml` → `harness-eval` | **可回归**：业务私有仓仍用 `node run.mjs /path` 或加 `BUILTIN_FIXTURES` 扩展。 |
| **HGT-002** | 全链路请求 ID / Trace 骨架 | 单次用户任务贯穿 `traceId`；日志可 grep 串联 LLM → 工具 → 内核。 | — | 文档说明字段名与落点；至少一条 Golden Path 可演示。 | `harnessTraceService`：`begin/end` 打 **`harnessTrace begin/end`**（info）；`executeNode` / `completeChatTurn` / `streamChat`；`AgentToolService` 带 trace 前缀；**[操作说明](./harness-trace-grep.md)** | **增强**：仍依赖日志级别为 info；其它入口可按需补 trace。 |
| **HGT-003** | 工具调用结果统一校验框架 | 可插拔校验；失败回灌模型。 | — | 覆盖 ≥1 类高频工具；有测试。 | `applyHarnessToolValidation`：`read/list/search/grep/diagnostics/mcp/web/write_file/browse_url/run_command` + 单测；`run_command` 桌面走主进程 spawn；Web 仍为 `legacyTerminal` | **增强**：Web 终端路径未变；后续工具可继续加。 |
| **HGT-004** | Verifier → 漂移检测数据链 | `matchedSuccessCriteria` → `runGoalDriftCheck`。 | HGT-001 建议 | 真阳性/真阴性可对齐文档。 | `tryParseVerifierMatchedSuccessCriteria` + **`warning` 时优先解析 JSON**；Verifier 系统提示要求输出 `matchedSuccessCriteria` 的 fenced JSON | **增强**：`passed` 仍视为准则全满足；模型漏写 JSON 时回退文本包含。 |
| **HGT-005** | 任务级隔离（试点） | git worktree / 目录隔离。 | HGT-001 | 试点文档 + 手动路径。 | `taskIsolation`；[试点说明](./harness-task-isolation-pilot.md) 含 **物化/CSO/worktree 边界表** | **试点**：默认关；完全切 worktree 仍为演进项。 |

---

## 3. P1 — 治理、成本、上下文（可运营）

| ID | 任务 | 说明 | 依赖 | 验收 | 落地 | **状态** |
|----|------|------|------|------|------|----------|
| **HGT-010** | 每任务 Token/成本预算与告警 | 软预算；可配置。 | HGT-002 | 超预算可感知。 | `softTokenBudgetTotal` + 账本；**超预算降级路由**（`softTokenBudgetDegradeModels`，预算>0 默认开）；可选 **`softTokenBudgetBlockNewNodes`** 硬停新节点；`harness.json` 见 `harness.example.json` | **增强**：硬停与降级可配；非「无限成本熔断」。 |
| **HGT-011** | 审计日志（最小集） | 敏感操作落盘。 | HGT-002 | 可查询。 | `harness-audit.jsonl` + **materialize / promote / git 建议&pending / token 预算** 等埋点 | **增强**：仍可按需扩路径。 |
| **HGT-012** | Context 策略文档 + 一处落地 | token 阈值等。 | — | 文档 + 可测行为。 | `contextEstimatedCharsWarn` + **`contextKeepStaleToolRounds`**（超阈值时压缩陈旧 tool 消息）；见 `harness-context-strategy.md` | **增强**：自动摘要全文仍属演进项。 |
| **HGT-013** | Feature registry 自动回写 `passes` | verify 后回写。 | HGT-004 | passes 与门禁一致。 | `updateFeatureRegistryPassesAfterVerify`：**准则文本与 `acceptanceSteps` 交叉匹配** | **增强**：复杂表仍部分依赖 Analyst 产出结构。 |
| **HGT-014** | 可选：每节点 git commit | 节点成功后 commit。 | HGT-005 | 配置关零变化。 | `pending_git_commands` + `sentinel-git-commit.mjs`；**审计** `suggested_git_commit` / `pending_git_command` | **增强**：生产稳定仍依赖环境与隔离目录。 |

---

## 4. P2 — Sentinel / Anthropic 对齐与跨端硬化

| ID | 任务 | 说明 | 依赖 | 验收 | 落地 | **状态** |
|----|------|------|------|------|------|----------|
| **HGT-020** | 超大目标分期与 Intent 拆分 | `SPLIT_INTENT` + 可选子 Intent。 | HGT-013 | 产品对齐。 | `splitLargeGoalsAutoCreate` + **`appendAnthropicProgressLog` 写子 Intent 摘要** | **增强**：理想态全自动回写仍随业务扩展。 |
| **HGT-021** | 设计工具类 E2E 断言模板 | 可复用断言 + 文档。 | HGT-001 | Verifier 可引用。 | `design-tool-e2e-assertions.md` + **`scripts/design-tool-e2e-smoke.mjs`**（前置检查） | **增强**：真实浏览器 E2E 仍依赖 MCP/业务仓。 |
| **HGT-022** | 联网搜索 0 条降级策略 | 无静默 0 条。 | — | 可测。 | 重试 + 日志 + **system / stream 注入 browse_url 提示** | **增强**：工具仍须模型调用。 |
| **HGT-023** | 跨端构建门（最小） | 脚本 + IDE 门禁。 | — | 文档前置。 | `sentinel-cross-platform-gates.mjs`（`--workspace` / `--target`）；无 SDK 时跳过并非零失败策略见脚本 | **仍依赖环境**；强门禁需业务 CI 接。 |
| **HGT-024** | 跨端 Golden Path 验收 | 定稿→生成→导入。 | HGT-001 | 书面 + 可跑。 | [业务签字清单](./hgt-024-business-signoff-checklist.md) + 路线图 + 脚本 | **硬验收=业务签字**；清单可复用。 |
| **HGT-025** | 跨端 LLM 落盘失败回滚 | 单 target 失败隔离。 | — | 可解释。 | `crossPlatformExportService`：**生成队列串行化**（`generateChain`） | **增强**：单 target 失败仍删目录回滚；极端组合需持续观察。 |
| **HGT-026** | Evaluator 与 Generator 分离（试点） | 固定 rubric；与生成步骤分离评分。 | HGT-004 | 试点结论。 | **`sentinelEvaluatorPipelineService`**：`evaluatorPipelineEnabled` + `evaluatorPlaywrightDir` 下 `npx playwright test --reporter=json` + **Tier1 独立 LLM** 对照 rubric；模板见 [templates/playwright-evaluator](./templates/playwright-evaluator/README.md) | **可跑**：完整 Playwright 安装与 CI 门禁仍在业务仓扩展。 |

---

## 5. P3 — Spec / Kiro 缺口（信息透明与精细控制）

> 与 `kiro-gap-action-plan.md` P2/P3/P4 对齐；可并行于 P1/P2，但**不替代** P0 证明层。

| ID | 任务 | 说明 | 验收 |
|----|------|------|------|
| **HGT-030** | Files Updated 面板 | 右侧列出修改文件；与写入事件或 session 同步。**部分落地**：活动流 severity。 | kiro P2.1；**控制平面「P3 洞察」** 列 `materializedFilesByIntent` + 打开主仓路径（worktree 有提示）。 |
| **HGT-031** | View changes（Diff） | 点击打开 VS Code Diff。 | kiro P2.2；首版以打开工作区文件为主；完整 Diff 可走命令面板 Compare。 |
| **HGT-032** | View execution + 耗时 | 执行日志弹窗；Elapsed time 展示。 | kiro P2.3～2.4；**P3 洞察** 展示 `lastNodeExecutionMs`；节点详情含 `workerRuns` 耗时。 |
| **HGT-033** | 任务完成通知 | 桌面通知 API。 | kiro P2.5；`aiCore.sentinel.desktopNotifyOnNodeComplete`（默认关）。 |
| **HGT-034** | 任务依赖与拓扑执行 | 解析依赖、按序执行；可选标必需/跳过/编辑。 | kiro P3；**P3 洞察** 只读展示各节点 `dependencies`。 |
| **HGT-035** | P4 项（按需） | Hooks、Steering、多 Spec 会话、协作、自动 commit、测试自动跑等。 | 每项单独开任务与验收 |

---

## 6. P4 — 平台与生态（长期）

| ID | 任务 | 说明 | 验收 |
|----|------|------|------|
| **HGT-040** | 扩展点文档 + 稳定性承诺 | MCP/命令/贡献点对外说明 semver 或兼容策略。 | 对外一页文档 |
| **HGT-041** | 多模型路由策略化 | 成本/合规/能力维度配置化；不绑单一供应商叙事。 | 配置项 + 文档 |
| **HGT-042** | 跨端 RN 单栈（可选） | 若产品决定统一 iOS/Android，为 `exports/` 换模板（路线图演进项）。 | 与 HGT-024 同仓验证 |

---

## 7. 已有能力：收敛与审视（非功能列表，是**动作**）

以下不新增功能，而是 **补全或删繁**：

| ID | 任务 | 说明 | 验收 |
|----|------|------|------|
| **HGT-050** | 编排边界审查 | 审计 Sentinel DAG：剔除「替模型决策」的冗余分支；文档写明 Workflow vs Agent 边界。 | 架构说明 + PR；见 `engineering-cybernetics-harness-mapping.md` 与 `convergence-hgt-050-052.md`。 |
| **HGT-051** | 假完成配置清理 | `aiCore`/harness 中未实现或仅占位的配置项：实现、关默认、或删。 | 新增项须有实现；跨端实验项默认关。 |
| **HGT-052** | 重复入口合并 | 多命令/多路径触发同一逻辑（如预览、导出）：单一状态源。 | 预览仅 `aicore.openProjectPreview` + manifest；Sentinel `tryAutoPreview` 同配置。 |

---

## 8. 里程碑建议（可按季度调整）

| 阶段 | 目标 | 包含任务（示例） |
|------|------|------------------|
| **M1** | 可证 + 可回归 | HGT-001～003、050 |
| **M2** | 漂移与 feature 闭环 | HGT-004、013、022 |
| **M3** | 隔离与审计 | HGT-005、010、011 |
| **M4** | 跨端 Golden + 构建门 | HGT-023、024、025 |
| **M5** | Spec 信息透明 | HGT-030～033 |

---

## 9. 相关文档

- [commercial-generation-remediation-plan.md](./commercial-generation-remediation-plan.md)（**一句话生成 → 可商用工程**：范围/交互门/验证/环境·模型/跨端 五类问题域修复计划与执行顺序）
- [improvement-master-checklist.md](./improvement-master-checklist.md)（**完善项总索引**：按领域汇总 HGT + 流水线 + 路线图 + 未编号跟进项，便于逐项勾选修改）
- [product-principles.md](./product-principles.md)（何时不自动 / 失败与成功同权 / 评判可独立）
- [harness-context-strategy.md](./harness-context-strategy.md)（HGT-012）
- [convergence-hgt-050-052.md](./convergence-hgt-050-052.md)
- [engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md)（工程控制论 ↔ Sentinel 映射，方法论）
- [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md)
- [anthropic-harness-alignment.md](./anthropic-harness-alignment.md)
- [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md)
- [harness-task-isolation-pilot.md](./harness-task-isolation-pilot.md)（HGT-005）
- [../../scripts/harness-eval/README.md](../../scripts/harness-eval/README.md)（HGT-001）
- [harness-trace-grep.md](./harness-trace-grep.md)（HGT-002）
- [hgt-024-business-signoff-checklist.md](./hgt-024-business-signoff-checklist.md)（HGT-024）
- [templates/playwright-evaluator/README.md](./templates/playwright-evaluator/README.md)（HGT-026 Playwright 目录模板）
- [../cursor/kiro-gap-action-plan.md](../cursor/kiro-gap-action-plan.md)

---

*文档版本：2026-03-30（**P1～P2 本轮**：预算降级/审计/上下文压缩/feature passes/跨端串行/签字清单/smoke 脚本等，见 §3～4 状态列）。任务 ID 追加时请延续 `HGT-xxx` 编号并更新本节日期。*
