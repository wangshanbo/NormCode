# Harness Eval（HGT-001）

最小回归：验证**内置夹具**存在，且可选执行各夹具的 `npm run build`。

**内置夹具**（无路径参数时依次执行）：

| 目录 | 说明 |
|------|------|
| `fixtures/minimal-workspace` | 最小工作区 |
| `fixtures/tiny-lib` | 含 `build.mjs`；`--full` 时校验 `dist/.sentinel-build-marker` 内容为 `ok` |
| `fixtures/real-app-skeleton` | 含 `src/`、`scripts/build.mjs`；`--full` 时同样校验 `dist/.sentinel-build-marker`（模拟类真实仓骨架） |

## 运行

```bash
cd vscode
npm run harness-eval
npm run harness-eval:full
# 或
node scripts/harness-eval/run.mjs
node scripts/harness-eval/run.mjs --full
```

指定其它工作区（需含 `package.json`）：

```bash
node scripts/harness-eval/run.mjs /path/to/project --full
```

## 接入 CI

在合并前增加一步（示例）：

```bash
node scripts/harness-eval/run.mjs --full
```

本仓库已在 **`.github/workflows/pr.yml`** 中增加独立 job **`harness-eval`**（仅依赖 Node，无需 `npm ci`），对**全部内置夹具**执行 `--full`（与本地 `node scripts/harness-eval/run.mjs --full` 一致）。

## 扩展场景

复制 `fixtures/minimal-workspace` 或 `fixtures/tiny-lib` 为新目录，将路径加入 `run.mjs` 的 `BUILTIN_FIXTURES`，必要时在 `assertPostBuildArtifacts` 中增加断言。
