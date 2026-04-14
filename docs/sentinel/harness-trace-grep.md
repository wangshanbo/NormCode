# HGT-002：用日志 grep 串联 trace（操作说明）

## 日志里长什么样

- 任意 **`beginTrace` / `endTrace` 区间**会在 **info** 级别打出：
  - `[trace=<id>] harnessTrace begin <scope>`
  - `[trace=<id>] harnessTrace end <scope>`
- GLM 与 Sentinel 节点仍使用原有 `[trace=<id>] [GLMChatService] ...` / `executeNode start` 等行；**同一 `traceId` 应一致**于该区间内的工具调用（`[trace=…] [AgentToolService]`）。

## 如何 grep

在开发者工具或日志导出文件中（示例）：

```bash
rg '\[trace=hgt_' your-log.txt
```

或固定一次用户任务中的 id：

```bash
rg '\[trace=hgt_[a-z0-9_]+\]' your-log.txt | head -50
```

## 级别与覆盖面

- **默认**：上述行多为 **`info`**。若工作区日志级别设为 `warn` 或仅收集 error，**会看不到** trace，属预期行为；排查全链路时请临时提高到 **info**（或等价「详细」）。
- **未包进区间的入口**：若某 API 未调用 `beginTrace`，则不会出现 `harnessTrace begin`，但可能仍有服务自有前缀日志；需要串联时应在对应入口补 `HarnessTraceService`（与 `glmChatService` / `sentinelKernelService.executeNode` 对齐）。

## 相关源码

- `src/vs/workbench/services/aiCore/browser/harnessTraceService.ts`
- `src/vs/workbench/services/aiCore/browser/glmChatService.ts`（`completeChatTurn` / `streamChat`）
- `src/vs/workbench/sentinel/browser/sentinelKernelService.ts`（`executeNode`）
