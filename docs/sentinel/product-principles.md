# Sentinel 产品原则（与默认策略对齐）

本文与 `harness.json` / `aiCore` 设置对应，落实三条意识形态：**何时不自动**、**失败与成功同权**、**评判可独立**。

## 1. 何时不自动

| 机制 | 配置 | 行为 |
|------|------|------|
| 分析后人审再跑 | `harness.json` **`humanGateAfterAnalysis`: true** | 需求分析完成后**不**执行 confirm→plan→runAll，即使用户级 `autoRun` 为 true |
| 执行模式 | `aiCore.executionMode`: `supervised` | Agent 写入需逐条确认（与 Sentinel 并行存在，各自职责不同） |

## 2. 失败与成功同权

| 机制 | 说明 |
|------|------|
| 活动流 `severity` | 节点失败、Harness 阻塞、分析失败等写入 **`failure`**；警告为 **`warning`**；正常完成为 **`success`** |
| UI | Sentinel 控制平面「活动流」时间线对严重度使用不同标题色（失败/警告/成功） |

## 3. 评判可独立（Evaluator）

| 机制 | 配置 / 文件 |
|------|-------------|
| 固定 rubric 文件 | `evaluatorRubricPath`（默认 `.sentinel/evaluator_rubric.md`），`anthropicHarnessParity` 时由脚手架创建 |
| Verifier 附言 | 要求对照 rubric 给出**可引用证据**，而非纯主观通过 |

## 4. 相关 harness 字段速查

- **`taskIsolation`**: `none` \| `worktree` — 与 `scripts/sentinel-worktree.mjs` 配合。
- **`splitLargeGoalsAutoCreate`**: 与 Analyst 输出 **`SPLIT_INTENT:`** 配合自动建子 Intent。
- **`gitCommitAfterNode`**: 在隔离目录就绪时写入 **`pending_git_commands.jsonl`**，由 `scripts/sentinel-git-commit.mjs` 执行。

---

*版本：2026-03-30*
