# Sentinel-IDE 工程规范

## 1. 文档定位

本文件只定义 Sentinel-IDE 在近期版本内可执行、可验证、可拆分的工程边界。

它不承担以下职责：

- 不负责表达长期愿景，由 `SENTINEL_IDE_VISION.md` 负责
- 不负责管理阶段排期，由 `SENTINEL_IDE_ROADMAP.md` 负责
- 不把研究能力直接写成近期必须兑现的交付承诺

本文件聚焦两个问题：

1. 当前 `aiCore` 基座已经有什么
2. 接下来 6-12 个月应该如何把这些原型串成闭环

---

## 2. 当前工程基座

结合现有代码，Sentinel-IDE 已经具备以下雏形能力：

- **AST 与符号理解：** `treeSitterService.ts`
- **诊断反馈与失忆上下文：** `lspFeedbackService.ts`
- **代码语义图谱：** `codeGraphService.ts`、`codeGraphTypes.ts`
- **任务 DAG：** `taskGraphTypes.ts`
- **检查点与回滚：** `checkpointService.ts`
- **测试闭环：** `tddService.ts`

这意味着 Sentinel-IDE 当前并不是“从零开始的概念稿”，而是已经拥有多块可演进的基础设施，但这些能力仍然偏离散，尚未形成统一的任务执行闭环。

---

## 3. V1 工程目标

V1 不追求“代码即投影”的终极态，而追求一个足够强的工程闭环：

- 系统能理解受影响文件和关键符号
- 系统能给 Agent 注入最小充分上下文
- 系统能把任务拆成可视化 DAG
- 系统能在关键节点建立检查点并支持回滚
- 系统能把诊断、测试和审查结果汇总成统一验证状态
- 系统能记录结构化决策摘要，而不是依赖脆弱的长对话历史

V1 的核心目标不是“完全自治”，而是“高置信半自治”。

---

## 4. 核心对象定义

### 4.1 Intent Graph

在 V1 中，`Intent Graph` 不定义为“代码之上的终极真相源”，而定义为一个 **任务级结构化意图层**，用于连接用户目标、约束、受影响范围和验证状态。

V1 最小字段建议：

- `intentId`
- `title`
- `goal`
- `constraints`
- `affectedFiles`
- `relatedSymbols`
- `successCriteria`
- `riskLevel`
- `status`
- `decisionRefs`
- `verificationRefs`

V1 范围内，`Intent Graph` 的职责是组织任务执行，而不是接管全部源代码语义。

### 4.2 Reasoning Trace

V1 不保存模型原始长链推理文本，而只保存 **结构化决策摘要**。

建议字段：

- `traceId`
- `intentId`
- `timestamp`
- `evidence`
- `optionsConsidered`
- `decision`
- `expectedImpact`
- `validatorHints`

这样做的原因：

- 降低日志噪声
- 降低隐私与安全风险
- 提高可比较性与可检索性
- 避免把不稳定的思维文本当成长期资产

### 4.3 CSO (Context State Object)

`CSO` 是失忆代理恢复现场的最小状态快照，而不是对完整历史的机械压缩。

V1 最小字段建议：

- `taskId`
- `currentIntent`
- `affectedFiles`
- `astSummaries`
- `diagnostics`
- `pendingTests`
- `recentFailures`
- `recentDecisions`
- `checkpointId`

### 4.4 Verification Bundle

V1 统一引入 `Verification Bundle` 概念，用来聚合多个验证通道的结果。

建议字段：

- `bundleId`
- `taskId`
- `lintStatus`
- `typecheckStatus`
- `testStatus`
- `reviewStatus`
- `securityStatus`
- `summary`
- `blockingIssues`

---

## 5. 服务职责划分

### 5.1 `TreeSitterService`

职责：

- 提供 AST 快照
- 提供符号提取
- 提供增量解析
- 为 Agent 上下文注入生成 AST 摘要

不负责：

- 高层任务规划
- 模型路由
- 任务验证裁决

### 5.2 `LSPFeedbackService`

职责：

- 收集工作区诊断
- 构建失忆上下文
- 驱动错误修复循环

建议增强：

- 把诊断结果标准化后并入 `Verification Bundle`
- 为任务级别输出“阻塞性问题”和“可忽略问题”

### 5.3 `CodeGraphService`

职责：

- 基于索引构建 `Code Graph`
- 提供语义对齐、关联查询和影响范围分析

建议增强：

- 为任务规划提供 `relatedSymbols` 与 `relevantFiles`
- 为复杂度评分提供依赖深度、影响半径等图结构指标

### 5.4 `CheckpointService`

职责：

- 为任务前后生成可恢复检查点
- 提供 diff 与回滚能力

建议增强：

- 与 `Task Graph` 显式绑定
- 在验证失败时支持快速回退到最近稳定点

### 5.5 `TDDService`

职责：

- 生成测试
- 运行测试
- 提供是否允许合并的结果

建议增强：

- 输出结构化 `testStatus`
- 将测试失败归因给实现、环境、样例不足或框架不匹配

### 5.6 Task Graph

职责：

- 将复杂任务拆分为 DAG 节点
- 管理依赖、执行顺序、暂停、重试、回滚

建议增强：

- 节点级路由信息
- 节点级成本信息
- 节点级验证结果
- 节点级决策摘要引用

---

## 6. V1 闭环

V1 推荐形成如下统一执行闭环：

1. 用户输入目标
2. 系统生成任务级 `Intent`
3. `CodeGraphService` 提供相关文件和符号
4. `TreeSitterService` 与 `LSPFeedbackService` 生成最小上下文
5. 系统构建 `Task Graph`
6. 执行前创建 `Checkpoint`
7. Agent 完成实现
8. Reviewer 进行独立审查
9. `TDDService` 与诊断系统产出验证结果
10. 系统汇总为 `Verification Bundle`
11. 若失败，归因并返工；若成功，推进下一节点

这个闭环已经足以支撑一个明显强于普通“聊天式补全”的 AI IDE。

---

## 7. 路由与复杂度评分

V1 中可以引入轻量 `TCI`，但不应过度设计。

建议只使用以下输入：

- 受影响文件数
- 受影响符号数
- 跨模块依赖深度
- 是否涉及测试、配置、接口、存储层联动
- 是否存在高优先级诊断

V1 输出只需要回答三件事：

- 这是不是单文件低风险任务
- 这是不是多文件中风险任务
- 这是不是必须进入高审查模式的高风险任务

不要在 V1 就追求复杂机器学习式路由器，先做可解释规则路由。

---

## 8. 关于形式化验证的边界

V1 不将 Z3 或其他形式化工具设为统一门禁。

更合理的分层做法是：

- **默认验证：** 诊断、类型检查、测试、审查
- **增强验证：** 对状态机、权限规则、事务一致性等高价值逻辑抽取断言
- **研究验证：** 更大范围的神经符号证明

也就是说，形式化验证在 V1 中应是“选择性增强能力”，不是“一刀切的交付前提”。

---

## 9. 关于 Intent Graph 的边界

V1 必须避免把 `Intent Graph` 神化。

更现实的定位是：

- 它首先是任务执行的控制层，不是语言无关的宇宙真相层
- 它服务于编排、验证、恢复和追溯
- 它需要逐步与代码现实建立映射，而不是一次性取代代码

只有当以下能力成熟后，`Intent Graph` 才可能升级为更强的系统真相源：

- 稳定的代码到意图回写
- 稳定的符号级影响分析
- 稳定的验证归因体系
- 稳定的跨任务状态继承

---

## 10. 近期必须回答的工程问题

在继续扩展功能前，建议优先钉死以下问题：

1. `Intent` 的最小 schema 是什么
2. `Reasoning Trace` 到底存原始文本还是结构化摘要
3. `Verification Bundle` 由谁负责汇总
4. `Task Graph` 如何与 `Checkpoint`、`TDD`、`Review` 建立统一状态机
5. `CodeGraphService` 是否需要显式暴露更稳定的全量图遍历接口

---

## 11. 一句话定义

**Sentinel-IDE V1 的工程目标，不是实现终极自治，而是把现有 `aiCore` 原型整合成“可理解、可执行、可验证、可回滚”的统一闭环。**
