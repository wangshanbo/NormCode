# HGT-012：上下文策略（文档 + 一处落地）

## 策略说明

长程 Agent 失稳来源包括：**历史消息膨胀**、**陈旧工具结果**、**多轮重复摘要**。推荐顺序：

1. **软阈值告警**：当序列化消息体积超过配置时，提醒用户摘要或新开会话（不自动删历史，避免误伤）。
2. **会话边界**：大里程碑换 Session / Intent。
3. **外置**：大段 spec 落盘为文件，用 `read_file` 按需拉取，而非堆在 system 里。

## 已落地（IDE）

- **设置**：`aiCore.contextEstimatedCharsWarn`（默认 `0` = 关闭）。  
- **行为**：`glmChatService.streamChat` / `completeChatTurn` 在发送前估算 `JSON.stringify(messages)` 字符数；超过阈值则 **打日志** 并（流式）**yield thinking**。
- **陈旧 tool 占位（HGT-012）**：`aiCore.contextKeepStaleToolRounds`（默认 `0`）。当估计字符数 **已超过** 上述阈值时，仅保留最近 N 条 `role=tool` 的全文，更早的替换为短占位，减少陈旧工具结果膨胀。

## 与 Sentinel 成本（HGT-010）

- 工作区 `.sentinel/harness.json`：`softTokenBudgetTotal` 为软预算；超预算时可 **`softTokenBudgetDegradeModels`**（默认在预算>0 时启用）将路由 **降级** tier；可选 **`softTokenBudgetBlockNewNodes`** 直接阻止新节点执行。

---

*版本：2026-03-30（补充 `contextKeepStaleToolRounds` 与 HGT-010 联动说明）*
