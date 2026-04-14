# Sentinel 与 Anthropic Harness Engineering 对齐说明

本文档对照 Anthropic 公开发表的 **Harness 工程范式**，说明当前 Sentinel 已映射的能力、差距与演进路线。

## 产品信条：结果偏差即系统责任

**当生成效果与用户合理想象不一致时，默认不归因于「大模型不够好」或「用户提示词写得不对」。** 应优先从整条链路找原因：需求分析是否把意图与验收拉齐、约束（IntentCard、allowedFiles、门禁）是否可执行、上下文（CSO、AST、诊断、已有文件）是否真实注入实现器、物化与合并策略是否破坏前序产物、验证与漂移检测是否能拦截错误放行，以及编排（DAG、节点粒度、自动修复）是否合理。**无论是可复现的显性缺陷，还是「看起来能跑但离预期很远」的隐性偏差，都视为 harness 与 IDE 产品迭代范围内的问题**，通过改分析、约束、校验、生成、物化等环节修复，而不是把责任推回用户或单次模型输出。

详细的问题清单、根因映射与已实现修复见 **[pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md)**。

## 官方参考（优先阅读原文）

1. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)（2025-11）  
   - **Initializer vs Coding agent**：首窗与后续窗不同提示；Initializer 搭脚手架。  
   - **Feature list（JSON）**：细粒度功能项、`passes` 布尔；禁止随意删改验收描述。  
   - **增量交付**：每次只推进少量功能；会话结束留 **git + 进度文件** 等「可交接状态」。  
   - **测试**：强调 **浏览器自动化 / 人类路径** 的 E2E，避免「改完即过」。

2. [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)（2026-03）  
   - **Planner / Generator / Evaluator** 三角色；生成器与评判者分离（类 GAN）。  
   - **上下文焦虑**与 **context reset + 结构化 handoff**（相对 compaction 的取舍）。  
   - **前端质量**：可评分维度（整体性、原创性、工艺、可用性）；Evaluator 用 **Playwright** 等在真实页面上打分。  
   - **全栈**：**Sprint contract**（生成前双方就「完成定义+可测标准」达成一致）。

3. 配套实现线索：[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)、[autonomous-coding quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding)。

4. **方法论参照（非 Anthropic 官方）**：钱学森《工程控制论》中的稳定性、反馈、扰动与观测等概念，可映射为 Harness 的「可证终态与失稳边界」讨论框架，见 **[engineering-cybernetics-harness-mapping.md](./engineering-cybernetics-harness-mapping.md)**。

5. **产品原则（默认策略）**：**何时不自动**、**失败与成功同权**、**评判可独立** 与 `harness.json` / UI 对齐说明，见 **[product-principles.md](./product-principles.md)**。

## 范式 → Sentinel 映射

| Anthropic 要点 | Sentinel 当前对应 | 差距（需产品迭代） |
|----------------|-------------------|-------------------|
| Initializer 搭环境 | `Analyst` + `planIntent` 前写入 `.sentinel/feature_registry.json` / `sentinel_progress.txt`（`anthropicHarnessParity`） | 未自动生成数百条细粒度 feature；需由 Analyst 输出扩展或模板化生成 |
| Feature JSON + passes | `feature_registry.json` 脚手架 + **`updateFeatureRegistryPassesAfterVerify`**（verify 且门禁通过时回写） | 极细粒度 feature 仍依赖 Analyst 扩展或模板化 |
| 每会话增量 | `Planner` 提示 + Implementer 提示约束「优先一条 feature」 | 执行图仍可能一次跑多节点；可改为「每节点只认领一条 feature」 |
| Git + 进度 | `gitSnapshots`、进度文件 | 未强制每节点 `git commit`；可接终端/Git 集成 |
| 工具化（bash、读文件、浏览器） | Implementer/Verifier **工具循环** + `mcp_call` + `AgentToolService` | 与 Agent SDK 仍有差距（会话级 tool 协议、评分器模型等），但已可走多轮写盘与浏览器 MCP |
| Evaluator + Playwright | `Verifier` 工具循环 + `behavioralE2E` + allowlist 内浏览器 MCP | **规划阶段**若白名单缺失或为空，内核会 **自动写入** 默认 `mcp_allowlist.json`（含 `cursor-ide-browser`）；仍须 IDE 内置或 `definitions` 提供可启动的 MCP |
| 外链/多媒体可达性 | Verifier 工具环附言要求 **逐条 URL** `curl -sI`（或等效）并列表证据 | 依赖模型与 token 执行完整探测；极多 URL 时可结合脚本白名单或采样策略（后续可增强） |
| 多轮「对撞」提升质量 | `planIntent` 后在 **末轮 Implementer** 之后插入 **Reviewer → Implementer**（设计对撞） | 非魔法第二模型，靠 **额外节点 + 专用附言 + 联网**；可 `designCollisionPass: false` 关闭 |
| 替用户补产品/审美 | `anthropicHarnessParity` 下 Analyst/Planner/Implementer/Verifier 附言强化 IA、状态、无障碍、反模板 UI | 仍受单次上下文与底模影响；需与对撞节点、Verifier 证据链配合 |

## 第一步：用户能力锚点与交付拉齐

`analyzeRequirement`（需求分析师 Worker）在 **任何规划之前** 须输出 **用户能力层级锚点**（`CAP_PRIMARY` / `CAP_CODE` / `CAP_LEVELING` / 多条 `CAP_SIGNAL`），仅根据 **本次用户输入的意图与措辞** 推断档位（普通人、学生、各级 PM、各级工程师、架构师等）。**判定目的不是降级**：内核会把锚点摘要写入 Intent，并明确要求后续 **Planner/实现** 将交付物对齐 **资深产品经理 + 资深架构师** 深度，尽量抹平「外行一句话」与「专家写 PRD」之间的规格差距。

## 设计对撞与外链验证（产品取向）

面向 **用户描述弱、审美与检索习惯弱** 的场景，系统在 **不假设用户会写清需求** 的前提下：

1. **Initializer / Analyst / Planner**：附言要求主动补 **信息架构、空/加载/错误态、无障碍、响应式、稳定配图策略**，并质疑「未验证的第三方图床 URL」。
2. **规划后 DAG**：默认在 **最后一条实现节点** 之后追加 **「设计对撞·产品/设计审查」**（Reviewer）与 **「设计对撞·实现收敛」**（Implementer）。审查节点 **开启联网与深度思考**，收敛节点可走 **工具循环**（与全局 `implementerAgentToolLoop` 一致）。
3. **Verifier 工具环**：强制 **收集 http(s) 资源并对关键 URL 做 HEAD/GET 探测**；关键资源 4xx/5xx 须 **BLOCK**；并鼓励浏览器 MCP 看真实首屏与控制台。

关闭对撞链路（缩短耗时）：在 `harness.json` 设 `"designCollisionPass": false`。

## 启用方式

在 `.sentinel/harness.json` 中（需 `enabled: true`）。**最小 Anthropic 流水线**只需两行；其余有合理默认值：

```json
{
  "enabled": true,
  "anthropicHarnessParity": true
}
```

只要 **`enabled: true`** 且未在 harness.json 里显式写 `false`，解析层默认 **`autoRun` + `skipUserConfirmation` 为 true**：需求分析结束后由 **内核** 直接执行 **confirm → 规划 → 跑完全部节点**，**不要求用户理解或点击「确认」**（与普通用户认知负担对齐）。若需人工卡在分析后，请设 `"autoRun": false`。

当 **`anthropicHarnessParity` 亦为 true** 时，默认还包括：`implementerAgentToolLoop`、`verifierAgentToolLoop`、`behavioralE2E`、`hintNpmScripts`、`verifyPackageScripts`、`designCollisionPass` 等为 **true**（均可单独 `false`）。

可选显式调参示例：

```json
{
  "enabled": true,
  "anthropicHarnessParity": true,
  "agentToolMaxIterations": 24,
  "agentToolMaxTokensPerTurn": 16384,
  "featureRegistryPath": ".sentinel/feature_registry.json",
  "progressLogPath": ".sentinel/sentinel_progress.txt",
  "initScriptHintPath": "init.sh",
  "autoRun": false
}
```

- `anthropicHarnessParity` 为 **true** 时，内核在规划前创建/保留上述工件，向各 Worker 注入附言；**需求分析结束**后会尝试 LLM 扩写 `feature_registry.json`，并在关键里程碑 **追加 `sentinel_progress.txt`**（handoff）。
- **Implementer / Verifier** 在默认下走 **GLM `completeChatTurn` + `AgentToolService` 多轮工具**（含 **`mcp_call`** 调用 allowlist 内 MCP）。
- 浏览器 E2E：在 `.sentinel/mcp_allowlist.json` 中声明浏览器类 MCP，并依赖内核 **MCP 同步**；示例见 `mcp_allowlist.anthropic.example.json`。
- **自动修复**：`harness.enabled` 时默认 `autoRepairOnFailure: true`，每个节点在 **Worker 失败或验证 blocked** 后，内核会多轮调用 **修复 Agent 工具循环**（`enableWebSearch: true`，可用 `web_search_deep` / `browse_url` / `mcp_call` 等），必要时 **重跑 Worker** 并 **重建验证 bundle**，最多 `autoRepairMaxRounds`（默认 3）。可在 `harness.json` 中设 `"autoRepairOnFailure": false` 关闭。
- **MCP 白名单脚手架**：`enabled` 且开启 `anthropicHarnessParity` 或 `verifierAgentToolLoop` 或 `behavioralE2E` 时，`planIntent` 前会 **自动创建** 默认 `.sentinel/mcp_allowlist.json`（若缺失或白名单为空），并触发 **MCP Bridge** 同步；普通用户无需手工理解 MCP。

## 为何不是「完全重写」

Anthropic 的完整能力依赖 **长时运行 + 工具循环 + 浏览器 MCP + 多轮 sprint**。Sentinel 现有价值在 **Intent/DAG/物化/闸门/Staging**。本阶段采用 **渐进对齐**：先固化 **结构化产物 + 提示词 + 验证钩子**，再逐步把 Implementer 从「单轮写文件」迁向 **带工具的 Agent 循环**（否则与 Claude Code / Agent SDK 仍不在同一赛道）。

## 能力验收：论文范式 vs 底模（如何自测）

论文强调 **harness（初始化脚手架、feature 列表、增量交付、Evaluator、交接物）** 比单次「模型有多聪明」更决定长程成败。验收时建议 **拆开两层**：

1. **结构层（应主要依赖产品，弱依赖底模）**  
   - 打开含 `.sentinel/harness.json` 的工作区，确认 `enabled` + `anthropicHarnessParity` 为 true。  
   - 走一条 **ingestPrompt / 需求分析**（默认即自动规划与跑 DAG，无需手动 confirm），检查是否生成或更新：  
     - `.sentinel/feature_registry.json`（含 `features[].passes`）  
     - `.sentinel/sentinel_progress.txt`（时间戳行追加，handoff）  
     - `.vscode/mcp.json` 是否在 parity 下由 allowlist 同步（若 definitions 非空）  
   - **静态脚本**（不调用 LLM）：在仓库根执行  
     `node scripts/verify-anthropic-harness-workspace.mjs /path/to/workspace`  
     未跑过 `planIntent` 时缺少 `feature_registry` / 进度日志只会 **警告**；跑完一轮后可用 `STRICT=1` 要求二者必须存在。  
     用于 CI 或跑流水线前的门槛检查。

2. **行为层（仍受底模影响，但应由工具与 Evaluator 兜底）**  
   - **Implementer**：是否出现多轮 `read_file` / `write_file` / `run_command`，而非仅一段无 `### FILE` 的空话。  
   - **Verifier**：是否在工具循环里调用诊断、`run_command`（lint/test）或 **`mcp_call` + 浏览器 MCP** 得到可引用证据，再下 PASS/BLOCK。  
   - 若底模偏弱：应看到 **更多轮次工具**、**验证门禁 BLOCK**、**进度文件仍完整**（便于下一会话接着修）——这与论文「生成器高估完成度、Evaluator 纠偏」一致。

3. **启动 IDE 做冒烟**  
   - 编译：`npm run compile` 或开发期 `npm run watch` + `./scripts/code.sh`。  
   - 用 **test-demo** 或自有项目文件夹作为工作区，启用上述 harness，跑一小条 Intent，对照第 1、2 步勾选。

**结论口径**：若结构层与工具闭环稳定，即使回答「文采」一般，也可认为 **对齐了 Anthropic 论文所指 harness 能力的主要部分**；剩余差距多在 **自动回写 `passes`、强制 git commit、独立评分模型** 等产品细节，而非换一个更强的底模 alone。
