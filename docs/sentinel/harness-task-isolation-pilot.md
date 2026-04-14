# HGT-005：任务级隔离（试点说明）

## 目标

长任务使用 **git worktree** 目录隔离，避免污染主工作区。默认 `taskIsolation: none`，不改变行为。

## 配置

在 `.sentinel/harness.json`：

```json
{
  "enabled": true,
  "taskIsolation": "worktree"
}
```

## 创建 worktree（仓库根执行）

```bash
node scripts/sentinel-worktree.mjs <intentId>
```

会在 `.sentinel/worktrees/<sanitizedIntentId>/` 创建独立 worktree（新分支 `sentinel/<sanitized>`）。

内核在 **首次执行节点** 时若未检测到该目录，会在活动流给出 **warning**（一次/Intent），提示运行上述脚本。

## 与物化路径

当前 **物化 / CSO 仍以主工作区为基准**；worktree 用于**可交接的 Git 状态**与 **pending git 命令**（见 `gitCommitAfterNode`）。将 CSO/物化完全切到 worktree 为后续演进项。

## 已知边界（试点期需人工心里有数）

| 区域 | 当前行为 | 风险 / 建议 |
|------|----------|-------------|
| **物化** | 写入路径仍相对**主仓**（见内核 merge/skip 逻辑） | 若同时在主仓与 worktree 手改同一文件，易产生冲突；长任务优先只在隔离目录或只在主仓一侧改。 |
| **CSO / 选根** | `contextStateService`、验证门 npm 与 **主工作区多根** 策略一致 | worktree 内新文件若未同步回主仓索引，主仓 CSO 可能「看不见」隔离目录中的内容（设计使然）。 |
| **worktree 未创建** | 首次跑节点会 **warning** 提示跑 `sentinel-worktree.mjs` | 忽略则等同未隔离，与 `taskIsolation: none` 类似。 |
| **git commit 脚本** | `pending_git_commands.jsonl` 需手动跑 `sentinel-git-commit.mjs` | CI/无 git 环境会失败；仅作可选增强。 |

## 真提交（HGT-014 延伸）

- `gitCommitAfterNode: true` 且隔离目录已存在时，节点成功会向 `.sentinel/pending_git_commands.jsonl` 追加一行。
- 在仓库根执行：`node scripts/sentinel-git-commit.mjs` 顺序消费（需本机 git）。

## 手动验收

1. 设 `taskIsolation: worktree`，创建 Intent，记下 `intentId`，在终端运行 `node scripts/sentinel-worktree.mjs <intentId>`。
2. 再跑节点：活动流不应再报「隔离未就绪」。
3. 主仓 `git status` 在仅使用 worktree 改文件时应保持干净（取决于你是否在主仓操作）。

---

*版本：2026-03-30*
