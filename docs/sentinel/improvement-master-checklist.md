# Sentinel / 自研 IDE：完善项总清单（主索引）

> **用途**：把「还需要完善什么」收敛为**一张可勾选的总表**，方便按项开 PR、改代码、回写状态。  
> **原则**：细节规格以各子文档为准；本文件只做**索引 + 执行顺序建议 + 未编号补充项**，避免与 [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md) 长期重复维护两份全文。

**更新**：修改任务状态或新增条目时，请更新文末「修订记录」日期。

---

## 1. 怎么用这份清单

1. **按里程碑改**：优先跟 [§5 建议执行顺序](#5-建议执行顺序与里程碑)（与 HGT §8 对齐）。
2. **每项落地后**：在对应 HGT 或 `pipeline-known-gaps` 表格里更新「验收/状态」列；本清单可只打勾或写 PR 链接。
3. **方法论对照**：[engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md)（反馈、观测、裕量、假完成）。

---

## 2. 总览矩阵（按领域）

> **P0 / P1 / P2**：以 [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md) **§「诚实口径」+ §2～4 状态列** 为准（**非**「几行 diff = 全部完工」）。下表仍作领域索引。

| 领域         | 要完善什么（一句话）               | 主引用                                                                          | 备注                            |
| ---------- | ------------------------ | ---------------------------------------------------------------------------- | ----------------------------- |
| 可证与回归      | 固定场景 Eval、失败即红           | [HGT-001](./harness-gap-task-breakdown.md#2-p0--证明稳定可回归终态地基)                 | 双内置夹具 + CI `harness-eval`      |
| 观测与追溯      | Trace 贯穿 LLM→工具→内核       | [HGT-002](./harness-gap-task-breakdown.md#2-p0--证明稳定可回归终态地基)                 | Golden Path                   |
| 工具与扰动      | 工具结果统一校验、禁静默失败           | [HGT-003](./harness-gap-task-breakdown.md#2-p0--证明稳定可回归终态地基)                 |                               |
| 验证→漂移      | Verifier 结构化已满足准则 → 漂移   | [HGT-004](./harness-gap-task-breakdown.md#2-p0--证明稳定可回归终态地基)                 | pipeline §3                   |
| 任务隔离       | worktree / 隔离根与物化、CSO 一致 | [HGT-005](./harness-gap-task-breakdown.md#2-p0--证明稳定可回归终态地基)                 | 试点文档                          |
| Token/成本   | 软预算告警与可感知事件              | [HGT-010](./harness-gap-task-breakdown.md#3-p1--治理成本上下文可运营)                  |                               |
| 审计         | 敏感操作落 `.sentinel/`       | [HGT-011](./harness-gap-task-breakdown.md#3-p1--治理成本上下文可运营)                  |                               |
| 长上下文       | Context 策略文档 + 一处落地      | [HGT-012](./harness-gap-task-breakdown.md#3-p1--治理成本上下文可运营)                  | `harness-context-strategy.md` |
| Feature 闭环 | registry `passes` 与验证门一致 | [HGT-013](./harness-gap-task-breakdown.md#3-p1--治理成本上下文可运营)                  |                               |
| Git 建议/待执行 | 节点后 commit 线索            | [HGT-014](./harness-gap-task-breakdown.md#3-p1--治理成本上下文可运营)                  |                               |
| 大目标分期      | 多 Intent / Sprint、少单 DAG | [HGT-020](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) | pipeline #6                   |
| 设计类 E2E    | 画布/图层断言模板 + 文档           | [HGT-021](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) |                               |
| 搜索 0 条     | 降级与用户可见                  | [HGT-022](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) | 日志 + 提示 + `webSearch` 0 条重试一次   |
| 跨端构建门      | iOS/Android 最小脚本         | [HGT-023](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) |                               |
| 跨端 Golden  | 定稿→生成→导入 书面路径            | [HGT-024](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) |                               |
| 跨端失败回滚     | 单模块失败不污染整仓               | [HGT-025](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) |                               |
| 评分离线       | Evaluator rubric 与生成分离试点 | [HGT-026](./harness-gap-task-breakdown.md#4-p2--sentinel--anthropic-对齐与跨端硬化) |                               |
| Spec/信息透明  | Diff、执行耗时、依赖拓扑等          | [HGT-030～035](./harness-gap-task-breakdown.md#5-p3--spec--kiro-缺口信息透明与精细控制)  | 部分已落地                         |
| 平台与生态      | 扩展点、多模型、RN 单栈            | [HGT-040～042](./harness-gap-task-breakdown.md#6-p4--平台与生态长期)                 |                               |
| 编排收敛       | DAG 边界、去冗余               | [HGT-050](./harness-gap-task-breakdown.md#7-已有能力收敛与审视非功能列表是动作)               |                               |
| 配置卫生       | 假配置项实现或删除                | [HGT-051](./harness-gap-task-breakdown.md#7-已有能力收敛与审视非功能列表是动作)               |                               |
| 入口合并       | 预览/导出单一状态源               | [HGT-052](./harness-gap-task-breakdown.md#7-已有能力收敛与审视非功能列表是动作)               |                               |


---

## 3. 流水线已知问题（与 HGT 交叉）

以下条目以 [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) **§1 表** 为权威描述；完善时优先改代码再更新表内「修复/缓解」列。


| #   | 现象（摘要）                    | 环节       | 建议关联 HGT / 动作                            |
| --- | ------------------------- | -------- | ---------------------------------------- |
| 1   | CSO `fileContents` 为空     | 上下文      | 已加强 bootstrap/多根选根；持续验收 HGT-001 场景       |
| 2   | 多节点物化覆盖入口/依赖              | 物化+规划    | HGT-020、Planner 提示；合并/跳过逻辑继续观察           |
| 3   | 漂移与 completed 语义          | 校验+内核    | HGT-004                                  |
| 4   | build 仍放行                 | 校验       | `verifyNpmBuildAfterImplement` + HGT-001 |
| 5   | Reviewer BLOCK 偏 advisory | 校验       | `strictVerification`；可文档化默认策略            |
| 6   | 超大目标一次交付                  | 分析+规划+校验 | HGT-020、HGT-021                          |
| 7   | 臆造图标/API                  | 生成+校验    | 提示词 + build                              |
| 8   | 联网 0 条                    | 环境       | HGT-022                                  |


**§3 演进项**（未声称已解决）：意图级拆分、Verifier 深化、设计工具 E2E —— 上表 HGT-004/013/020/021。

---

## 4. 跨端导出（路线图级）

以 [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md) 为阶段权威：**阶段 0～5**（IR、模板、分模块落盘、构建门、产品入口）+ 文内「实施状态」。  
与 HGT-023/024/025 对齐；完善时按路线图阶段勾选。

---

## 5. 建议执行顺序与里程碑

与 [harness-gap-task-breakdown.md §8](./harness-gap-task-breakdown.md#8-里程碑建议可按季度调整) 一致，便于「一个个改」：


| 阶段     | 目标              | 任务包             |
| ------ | --------------- | --------------- |
| **M1** | 可证 + 可回归        | HGT-001～003、050 |
| **M2** | 漂移与 feature 闭环  | HGT-004、013、022 |
| **M3** | 隔离与审计           | HGT-005、010、011 |
| **M4** | 跨端 Golden + 构建门 | HGT-023、024、025 |
| **M5** | Spec 信息透明       | HGT-030～033     |


**在 M1 之前或并行**：通读 [product-principles.md](./product-principles.md)、[anthropic-harness-alignment.md](./anthropic-harness-alignment.md)，避免与产品信条冲突。

---

## 6. 尚未单独编号的跟进项（建议吸收进下一轮 HGT 或 pipeline）

> 下列来自近期实现审计与讨论，**尚未**全部写入 HGT 表；可选编号为 `HGT-060+` 或并入现有条。

- ~~**验证门与多根工作区**~~：**已对齐**（`sentinelWorkspaceRootPick` + `verificationGateService.pickWorkspaceFolderForNpm`，与 CSO 探测策略一致）。  
- ~~**warning 与节点 completed 语义**~~：**可配置**：`harness.json` 中 `verificationWarningBlocksCompletion` / `driftNonPassBlocksCompletion`（默认均 `false`，保持原 advisory 行为）。  
- ~~**默认执行图形态**~~：**已落地**：`harness.enabled` 且未显式 `defaultExecutionGraphIncludeVerify: false` 时，默认回退图与动态图在实现链末追加 **验证** 节点（`createDefaultExecutionGraph` / `executionGraphService`）；未开 harness 仍为 **两节点**。  
- ~~**Planner 解析再扩容**~~：**已加强**：`#### 步骤|STEP|Step`；`**` 编号无匹配且存在 ≥2 条 `^\d+\.\s+` 非加粗行时解析为步骤。  
- ~~**物化后回写上下文路径**~~：**已落地**：物化成功后合并相对路径至 `intentCard.allowedFiles`；CSO 在用户已有限定路径时仍 **追加** `DEFAULT_BOOTSTRAP`，避免丢 `package.json`。  
- ~~**持久化审计**~~：**已修**：`runAllNodes` 正常完成时调用 `executionGraphService.updateGraphStatus`，不再对 `getGraph` 克隆赋值。  
- ~~**文档同步（示例 harness）**~~：**已提供** [harness.example.json](./harness.example.json)（复制为工作区 `.sentinel/harness.json`）；`pipeline` §2 已列常用开关。

---

## 7. 近期已落地（便于归档勾选）

以下已在代码侧部分实现，完善清单时可从「缺口」挪到「已缓解」并在子文档更新描述：

- CSO：`DEFAULT_BOOTSTRAP` 覆盖 CRA 常见入口；多根工作区按探测命中选读盘根；0 文件成功读取时 `warn`。  
- `runAllNodes`：验证阻塞重试耗尽后默认**中止**（不假完成）；`harness.json`：`autoSkipBlockedNodesOnRunAll` 恢复旧「自动跳过」。  
- 暂停 `runAll` 时不再把整张图当「全部完成」去 `projected`。  
- Planner 动态图：支持 `### 步骤|STEP|Step N：` 解析。  
- 文案：默认图由「六阶段」更正为「两节点 / 三相（harness 下含验证）」表述。  
- Harness：`defaultExecutionGraphIncludeVerify`（`enabled` 时默认 true）控制默认图是否含 **验证** 节点。  
- 验证门 npm（lint/test/build）与 `readPackageScriptsSummary`：多根工作区与 CSO 同策略选根；`runAll` 完成时图状态写入 `executionGraphService` 真源。  
- 物化后 `allowedFiles` 合并 + CSO `allowedFiles` 与默认引导路径并集；Planner `####` / 宽松编号列表。  
- Harness：`verificationWarningBlocksCompletion`、`driftNonPassBlocksCompletion` 控制 warning/漂移是否将节点标 blocked（与 `autoRollbackOnVerifyFailure` / Promote 联动）。  
- 多根选根：`pickWorkspaceFolderByProbes` 供 CSO 与 npm/验证共用；示例 `docs/sentinel/harness.example.json`。

---

## 8. 相关文档（扩展阅读）


| 文档                                                                                         | 内容           |
| ------------------------------------------------------------------------------------------ | ------------ |
| [harness-gap-task-breakdown.md](./harness-gap-task-breakdown.md)                           | HGT 全表与里程碑   |
| [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md)         | 流水线现象↔修复     |
| [anthropic-harness-alignment.md](./anthropic-harness-alignment.md)                         | 范式与产品信条      |
| [cross-platform-export-roadmap.md](./cross-platform-export-roadmap.md)                     | 跨端阶段计划       |
| [engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md) | 工程控制论映射      |
| [application-capabilities.md](./application-capabilities.md)                               | 当前能力事实源      |
| [commercial-generation-remediation-plan.md](./commercial-generation-remediation.md)         | 一句话生成→商用：五类问题域修复计划与执行顺序 |
| [../cursor/kiro-gap-action-plan.md](../cursor/kiro-gap-action-plan.md)                     | Spec/Kiro 缺口 |


---

## 修订记录


| 日期         | 说明                      |
| ---------- | ----------------------- |
| 2026-03-29 | 初版：主索引 + 未编号跟进项 + 近期已落地 |
| 2026-03-29 | 执行项：验证门多根选根、`updateGraphStatus`、清单勾选更新 |
| 2026-03-29 | 物化合并 allowedFiles、CSO 用户路径+bootstrap、Planner `####`/宽松编号 |
| 2026-03-29 | Harness 严格终态：`verificationWarningBlocksCompletion`、`driftNonPassBlocksCompletion` |
| 2026-03-29 | `pickWorkspaceFolderByProbes` 共用、docs/sentinel/harness.example.json |
| 2026-03-30 | HGT-003 后置校验与单测；HGT-022 `completeChatTurn` 0 条 system 提示；`npm run harness-eval`；**同日后修正**：harness-gap 取消误导性「全部已验收」表述 |
| 2026-03-30 | **PR 粒度 HGT-002**：`glmChatService.streamChat` 增加 `beginTrace`/`endTrace` + `[trace=…]` 起止日志（与 `completeChatTurn` 对齐） |
| 2026-03-30 | **PR-2 / HGT-003**：`run_command` 桌面端走 `INativeHostService.runAgentToolShellCommand`（主进程 spawn + exitCode）；后置校验 `run_command`；单测 |
| 2026-03-30 | **PR-3 / HGT-001**：`.github/workflows/pr.yml` 增加 job `harness-eval`（`node scripts/harness-eval/run.mjs --full`） |
| 2026-03-30 | **P0～P2 补充**：HGT-001 第二夹具 `fixtures/tiny-lib` + `run.mjs` 多夹具；HGT-022 `webSearch` 首次 0 条后 500ms 重试一次；`harness-gap` / harness-eval README 同步 |
| 2026-03-30 | **P0 HGT-001～005**：第三夹具 `real-app-skeleton`；`HarnessTraceService` begin/end 打点 + `harness-trace-grep.md`；`write_file`/`browse_url` 后置校验；Verifier `matchedSuccessCriteria` JSON 解析 + 提示；隔离试点文档边界表 |
| 2026-03-30 | **P1～P2 批量增强**：HGT-010 预算降级/硬停；HGT-011 审计扩展；HGT-012 `contextKeepStaleToolRounds`；HGT-013 acceptanceSteps 匹配；HGT-014 审计；HGT-020 progress 日志；HGT-021/026 smoke 脚本；HGT-022 system 提示；HGT-025 导出串行；HGT-024 签字清单 |
| 2026-03-30 | **HGT-026 实现**：`sentinelEvaluatorPipelineService`（Playwright JSON + Tier1 独立 LLM）、`VerificationBundle.evaluatorPipeline`、harness 配置项、模板 `docs/sentinel/templates/playwright-evaluator/README.md` |
| 2026-03-30 | 新增 [commercial-generation-remediation-plan.md](./commercial-generation-remediation.md)：范围/交互门/验证/环境·模型/跨端 五类修复计划；主索引 §8 增加引用 |


