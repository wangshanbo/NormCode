# 一句话生成 → 可商用工程：五大问题域修复计划

> **文档性质**：针对「单条提示词驱动 Sentinel 生成类 Figma 网页工程、并以可商用为标尺」时，在 **范围、交互门、验证、环境/模型、跨端** 五类系统性障碍上的 **修复策略与落地顺序**。  
> **与产品关系**：生成物（如 `figma` 样本仓）上的问题 **默认回灌 NormCode**（见 `.cursor/rules/normcode-project.mdc`）；本文只规划 **IDE / Harness / 文档** 侧动作。  
> **与 HGT 关系**：不重复整张 [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md)，只把五类问题 **映射到已有编号** 并补充 **跨条目协调顺序**。

### 读前说明：不是「五个都无解」

- 每一节的 **「§x.3 修复动作」表格** 就是该问题域的 **解决方案与落地项**：有的已在代码里 **部分实现**（见 §x.2 现状），有的是 **模板/文档/配置** 即可推进，有的是 **需产品决策**（例如是否全量关闭交互门）。
- 文中写 **「现象 / 根因」** 是为了对齐归因，**不是**声明「技术上无法可做」。
- 若你想到更好的编排手段（例如下文 **多角色多轮拆分**），应 **回灌 NormCode**（提示词、独立 Worker、路由），而不是只在生成物仓库里手工拆需求。

**版本**：2026-03-30（修订：读前说明 + §1.5 多角色拆分）

---

## 0. 目标口径（可勾选）

| 层级 | 含义 | 验收示例 |
|------|------|----------|
| **L0** | 单句 `goal` 能创建 Intent 并跑通物化 + `npm run build`（工作区已配置 Harness） | 节点非 blocked；构建失败即红 |
| **L1** | 单句对应的 **合约** 被 Analyst/Planner 拆成可测里程碑（多 Intent 或 SPLIT 可接受） | 子 Intent 或 DAG 每步有 DoD |
| **L2** | 关键路径有 **结构化验证**（Verifier / 漂移 / 可选 Playwright + Evaluator） | HGT-004/026 可演示 |
| **L3** | 跨端与「路线图阶段」对齐的 **最小 Golden Path** | HGT-023/024/025 与业务签字清单 |

**商用**在本计划中 operational 化为 **L2 + 业务侧签字**（法律/上架不在本文范围）。

---

## 1. 范围过大

### 1.1 现象与根因

- **现象**：单句目标描述「完整 Figma / 全功能设计工具」，单次 DAG 或单次生成声称完成，实际不可维护或验证无法覆盖。  
- **根因**：开放域产品与「一句话」输入 **信息量不匹配**；编排侧若未强制分期，模型会 **过度承诺**。[pipeline-known-gaps #6](./pipeline-known-gaps-and-remediation.md)

### 1.2 现状（已有能力）

- Analyst / Planner 提示中 **分期、可测 DoD** 要求；`SPLIT_INTENT` + `splitLargeGoalsAutoCreate`（[HGT-020](./harness-gap-task-breakdown.md)）。  
- 构建门禁拦截不可编译交付（pipeline #4）。

### 1.3 修复动作

| 优先级 | 动作 | 产出/备注 |
|--------|------|-----------|
| P0 | **产品化「默认合约」模板**：在仓库内维护 1～2 条 **类 Figma MVP** 的 `goal` 示例（画布 + 基础变换 + 图层列表 + 撤销 + 导出 JSON 等），写入 `docs/sentinel/` 或 Chat 侧预设 | 用户可「一句」选用模板句，而非无限开放描述 |
| P1 | **强化 Analyst 对 `FEATURE_MATRIX` / 分期** 输出稳定性；超大目标 **自动子 Intent** 与 `appendAnthropicProgressLog` 摘要可读（HGT-020） | 控制平面可见「第几期」 |
| P2 | 文档与 UI 文案：**禁止暗示「一句话 = 无限商用全功能」**；与 [product-principles.md](./product-principles.md) 一致 | 降低错误预期 |

### 1.4 演进方向：多角色、多轮「产品级」拆分是否可行？

**可行，且与「范围过大」的修复方向一致**——本质是把「一句话」先变成 **多期、可依赖、可验收** 的合约，再进入 Planner/DAG；不一定要换一个「更聪明的单次 Analyst」，也可以是 **多轮、多角色、多模型档位** 的分解阶段。

| 维度 | 说明 |
|------|------|
| **与现有能力的关系** | NormCode **已经部分在做这件事**：Analyst（含联网与 `FEATURE_MATRIX`）、Planner 产出步骤、超大目标时 `SPLIT_INTENT` + `splitLargeGoalsAutoCreate`（HGT-020）。你设想的「资深产品总监式多轮分析」在工程上可落为：**加强 Analyst 分段**、**独立「分期 / 预研」Worker**、或 **路由到专用于拆任务的子代理**（与 `aiCore.enableSubagents` 等配置同向）。 |
| **难点不在人设** | 仅给模型贴「产品总监」标签 **不能保证** 拆分质量；更难的是：**输出可被内核稳定解析**（分期列表、依赖、每期的 DoD）、**与验证门对齐**（§3），以及 **Token/时延/成本**（HGT-010）可控。 |
| **落地建议（NormCode 侧）** | 优先 **结构化输出约定**（已有 `FEATURE_MATRIX:`、`SPLIT_INTENT:` 等可扩展），再考虑多轮；避免只做「更长聊天」却无机器可读分期。 |

### 1.5 关联 HGT

- **HGT-020**（主）、**HGT-021**（设计工具类 E2E 模板与文档）、pipeline #6。

---

## 2. 交互门（Human gate）

### 2.1 现象与根因

- **现象**：用户期望「零点击」跑完全链路，但分析后需确认、或 `humanGateAfterAnalysis` 阻塞自动执行。  
- **根因**：产品 **风控与可观测** 要求：避免误跑、误写盘；与默认 `autoRun` 组合行为需用户理解。

### 2.2 现状

- `ingestPrompt` → `analyzeRequirement`；`autoRun` 时内核内可链式 confirm→plan→runAll（见 `sentinelProductService` 注释）。  
- Harness：`humanGateAfterAnalysis`、`skipUserConfirmation` 等（[harness.example.json](./harness.example.json)）。

### 2.3 修复动作

| 优先级 | 动作 | 产出/备注 |
|--------|------|-----------|
| P0 | **文档化三档模式**：(1) 开发迭代：关 `humanGateAfterAnalysis` + 明确风险；(2) 默认：分析后确认；(3) CI/无头：配合 `statelessExecution` 等 | 减少「为什么停住」的困惑 |
| P1 | 控制平面 **一键「确认并执行」** 路径与状态机可读（与 HGT-030～034 部分重叠） | 减少点击次数而非取消门 |
| P2 | 可选：**仅对「模板化 goal」跳过门**（配置或前缀匹配）——需单独设计，避免误开全量免确认 | 产品决策后实现 |

### 2.4 关联 HGT

- **HGT-030～034**（信息透明与执行流）；与 [product-principles](./product-principles.md)「何时不自动」对齐。

---

## 3. 验证深度

### 3.1 现象与根因

- **现象**：`npm run build` 通过但交互错误、设计工具核心路径未覆盖；「商用」仅靠编译不够。  
- **根因**：**Verifier 结构化准则**、漂移、E2E、Evaluator 为 **分层能力**，需配置与样本仓配合。[pipeline §3 演进项](./pipeline-known-gaps-and-remediation.md)

### 3.2 现状

- `matchedSuccessCriteria` → `runGoalDriftCheck`（HGT-004）；`strictVerification`、Reviewer BLOCK 可挡（pipeline #5）。  
- 设计工具断言模板与 smoke 脚本（HGT-021）；Playwright JSON + Tier1 LLM（HGT-026）。

### 3.3 修复动作

| 优先级 | 动作 | 产出/备注 |
|--------|------|-----------|
| P0 | 在 **figma 样本仓**（或内置夹具）维护 **最小 acceptance 列表**，与 Verifier 输出 **同形**（准则可 JSON 解析） | 与 HGT-004 对齐、可回归 |
| P1 | 按需开启 **HGT-026**：`evaluatorPipelineEnabled` + `evaluatorPlaywrightDir`；CI 或本地 `npx playwright test --reporter=json` | L2 门槛 |
| P2 | **设计工具类**选择器与 `design-tool-e2e-assertions.md` 随项目迭代 | 画布/图层类专用 |

### 3.4 关联 HGT

- **HGT-004、HGT-013、HGT-021、HGT-026**；[templates/playwright-evaluator](./templates/playwright-evaluator/README.md)。

---

## 4. 环境与模型方差

### 4.1 现象与根因

- **现象**：联网 0 条、臆造依赖、同 prompt 不同次结果差异大。  
- **根因**：外部检索与模型 **随机性**；工具链未完全 **可观测**。[pipeline #7–8](./pipeline-known-gaps-and-remediation.md)

### 4.2 现状

- HGT-022：检索 0 条重试 + system/stream 提示；Implementer 提示约束图标等。  
- HGT-002：trace；HGT-010：预算降级/硬停。  
- harness-eval 夹具（HGT-001）用于回归。

### 4.3 修复动作

| 优先级 | 动作 | 产出/备注 |
|--------|------|-----------|
| P0 | **环境检查清单**（GLM Key、网络、`npm`/`node`、多根工作区选根）：写入本文档附录或 `README` 小节 | 降低「环境假失败」 |
| P1 | 对 **臆造依赖**：build + LSP 门禁 + 文档中的 **允许依赖白名单**（模板 `package.json`） | 与 pipeline #7 一致 |
| P2 | **成本与路由**：`softTokenBudgetTotal`、路由模型档位；重要节点 **escalation** 策略文档化 | 控制方差与成本 |

### 4.4 关联 HGT

- **HGT-001、002、010、022**；[harness-eval README](../../scripts/harness-eval/README.md)。

---

## 5. 跨端路线图阶段目标

### 5.1 现象与根因

- **现象**：用户期望「一句话 → Web + iOS + Android + 小程序」同时可商用；实际 **阶段 0～5** 分步交付。  
- **根因**：跨端依赖 **IR、模板、分模块 LLM、各端构建门**；与「单句 Web MVP」 **不同里程碑**。[cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md)

### 5.2 现状

- Web 为真源、`exports/`、manifest、串行生成与失败回滚（HGT-025）等见 [application-capabilities §4](./application-capabilities.md)。  
- Golden Path **硬验收** 含业务签字（HGT-024）。

### 5.3 修复动作

| 优先级 | 动作 | 产出/备注 |
|--------|------|-----------|
| P0 | **产品叙事**：明确「一句话」首版目标 = **Web 可预览 + build**；跨端 = **定稿后**另走导出/生成 | 避免期望错位 |
| P1 | 按路线图推进 **阶段 1～4**：IR 快照、模板、`sentinel-cross-platform-gates.mjs` 与 IDE 门禁联动（HGT-023） | 与 [路线图「实施状态」](./cross-platform-export-roadmap.md) 同步勾选 |
| P2 | **HGT-024** 清单在业务仓跑通一条 Golden Path 并签字 | L3 |

### 5.4 关联 HGT

- **HGT-023、024、025**；[hgt-024-business-signoff-checklist.md](./hgt-024-business-signoff-checklist.md)。

---

## 6. 建议执行顺序（与现有里程碑对齐）

| 阶段 | 聚焦 | 主要任务包 |
|------|------|------------|
| **A** | 可证 + 环境可复现 | §4 环境清单 + HGT-001/002/022 |
| **B** | 范围可控 + 门策略清晰 | §1 模板合约 + §2 文档化三档 + HGT-020 |
| **C** | 验证加深 | §3 + HGT-004/013/021/026 |
| **D** | 跨端与商用签字 | §5 + HGT-023/024/025 |

与 [improvement-master-checklist §5](./improvement-master-checklist.md#5-建议执行顺序与里程碑) **M1～M4** 可并行对照：不替代原表，仅增加 **「生成商用样本」** 视角的排序说明。

---

## 7. 附录：环境检查清单（草案）

- [ ] 工作区根存在 `.sentinel/harness.json`（从 [harness.example.json](./harness.example.json) 复制并审阅）  
- [ ] `aiCore.glmApiKey` 或等价模型配置可用  
- [ ] `aiCore.enableWebSearch` 与网络策略满足 Analyst 联网段  
- [ ] 单根或多根工作区下，**生成目标** 与 `sentinelWorkspaceRootPick` 选根一致（npm/验证与 CSO 同源）  
- [ ] 本地 `node` / `npm` 版本与模板要求一致（见样本 `package.json` engines 若有）

---

## 8. 相关文档

| 文档 | 用途 |
|------|------|
| [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) | 现象 ↔ 环节 |
| [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md) | HGT 全表 |
| [improvement-master-checklist.md](./improvement-master-checklist.md) | 总索引 |
| [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md) | 跨端阶段 |
| [engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md) | 稳定性评审锚点 |

---

*修订时请更新「版本」日期，并在 [improvement-master-checklist.md](./improvement-master-checklist.md) 修订记录中追加一行（若主索引有引用本页）。*
