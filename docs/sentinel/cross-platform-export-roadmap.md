# 跨端导出：从「定稿 + 说明文档」到「可构建各端工程」— 执行计划

目标：用户用**简短描述**驱动生成 **Web 可预览项目**，在预览中**修改并定稿**后，**一键**产出 **Web / iOS / Android / 微信小程序** 侧**可编译或可导入**的工程骨架与关键源码（而非仅 `GENERATION.md`）。

---

## 当前基线（已实现）

- 项目预览：`aicore.openProjectPreview`，内嵌 dev server URL。
- 中间层：`.sentinel/cross-platform-export.json`（定稿、选端、`modules` 占位）。
- 一键生成：`exports/<端>/GENERATION.md`（LLM 迁移说明）。

**缺口**：无结构化 IR、无模板化代码落盘、无各端构建门、Intent→可跑预览未产品化封装。

---

## 阶段 0：范围与成功标准（1～2 天）

| 决策项 | 建议 |
|--------|------|
| 首版「代码」定义 | 每端至少：**可打开的工程目录** + **能通过该端官方最小构建/导入步骤**（如 Web `npm run build`；小程序用开发者工具打开无红错；iOS/Android 为可打开的 Xcode/Android Studio 工程或 RN/Expo 子目录）。 |
| 技术路线 | **Web 为唯一真源**；其它端采用 **固定脚手架 + LLM 按模块填空** + **静态校验**，避免「整仓纯模型直出」。 |
| 不做什么（首版） | 不做像素级 UI 自动等价；不保证应用商店过审；不替代微信开发者工具内置调试。 |

**验收**：团队书面签字「首版成功标准」+ 示例仓库一条 golden path。

---

## 阶段 1：结构化 IR（中间层）（3～5 天）

**产出**：版本化 schema，与 manifest 合并或拆分存储。

1. **组件/页面清单**（从 Web 工程扫描或定稿时快照）  
   - 路径、路由、主要 props、依赖（如 antd 组件名）。  
   - 存储：如 `.sentinel/cross-platform-ir.json` 或在 manifest 中 `irVersion` + `snapshot`。

2. **接口与资源契约**  
   - API base、鉴权假设、静态资源列表；供各端生成 `env` / 配置模板。

3. **定稿动作**  
   - 定稿时触发 **IR 快照**（调用轻量脚本或 LSP/TS 服务可选），写入上述文件。

**验收**：定稿后 IR 文件存在且可被只读消费；无 IR 则生成流程拒绝或降级为仅文档。

---

## 阶段 2：分端脚手架与模板仓库（5～8 天）

为每端维护 **最小可运行模板**（建议 monorepo 子目录或 git submodule）：

| 端 | 模板方向（择一固化） |
|----|------------------------|
| Web | 已有仓库即真源；可选 `exports/web` 为镜像或仅 README。 |
| iOS | SwiftUI 单场景 **或** React Native 子工程（与团队栈一致）。 |
| Android | Kotlin/Compose **或** 同上 RN。 |
| 微信小程序 | `miniprogram` 标准目录 + `app.json` / `project.config.json` 模板。 |

**任务**：脚本将模板 **拷贝到** `exports/<端>/project/`（或约定路径），占位符替换（包名、appId、接口地址）。

**验收**：不调用 LLM 时，模板拷贝 + 替换后，各端能走通文档中的「打开/编译/导入」最小步骤。

---

## 阶段 3：LLM 分模块落盘（5～10 天）

1. **按 IR 中的模块** 循环：构造 prompt（模块源码摘要 + 目标端约束 + 模板路径）。  
2. **输出格式**：强制 **JSON 或分文件 fenced blocks**（路径 → 内容），由 **解析器** 写入 `exports/...`，禁止裸写整仓。  
3. **每端后置**：`eslint` / `tsc` / 小程序内置校验 / `xcodebuild` 可选，失败则 **回滚该模块** 或标记 `runs[target].error`。

**验收**：至少 1 个 demo 项目从定稿到每端 `project/` 内有关键页面文件且构建脚本可跑（定义在 README）。

---

## 阶段 4：构建与验证门（3～5 天）

复用并扩展现有 harness 思想：

- Web：`npm run build`（已有可衔接）。  
- 小程序：`cli` 若可用则跑，否则 **「导入检查清单」** 自动化（文件存在性 + JSON 合法）。  
- iOS/Android：CI 或本地脚本 **可选**；首版可 **人工 gate** + 日志落 `runs`。

**验收**：流水线在失败时阻塞发布并写入 manifest `runs`。

---

## 阶段 5：产品入口与体验（3～5 天）

1. **Intent → 预览**：Sentinel 完成节点或「实现成功」后，**提示**「打开项目预览」并可选 **自动执行** `aicore.openProjectPreview`（仅当检测到 dev URL）。  
2. **预览器**：定稿后按钮文案改为「生成各端工程」；展示 **进度**（按端、按模块）。  
3. **文档**：用户可见的「各端下一步」：Xcode / AS / 微信开发者工具。

**验收**：用户无需记命令即可完成：描述 →（现有 Sentinel）→ 预览 → 定稿 → 一键 → 打开 `exports/`。

---

## 依赖与风险

| 风险 | 缓解 |
|------|------|
| LLM 输出不可编译 | 模板锁定 + 小步落盘 + 构建门 + 重试上限 |
| 多端维护成本高 | 首版只支持 **一种** 移动技术栈（如 RN 同时覆盖 iOS+Android） |
| 小程序与 Web 差异大 | IR 中标注「不支持的 API」，生成时降级为占位页 |

---

## 建议排期（合计约 4～6 周，可并行部分）

| 周 | 里程碑 |
|----|--------|
| 1 | 阶段 0 + 阶段 1（IR schema + 定稿快照） |
| 2 | 阶段 2（四端模板 + 拷贝脚本） |
| 3～4 | 阶段 3（解析器 + 分模块 LLM + Web/小程序优先打通） |
| 5 | 阶段 4（构建门）+ 阶段 5（入口与文案） |
| 6 | Golden path 验收 + 修缺口 |

---

## 实施状态（与代码对齐，2026-03）

| 路线图阶段 | 状态 | 说明与主要路径 |
|------------|------|------------------|
| 0 范围与成功标准 | 文档级 | 仍以本文「首版定义」为准；Golden path 需业务侧用真实仓库走一遍验收。 |
| 1 结构化 IR | **已实现** | `crossPlatformExportTypes.ts`：`irVersion` / `irPath` / `irSnapshotAt`、`CrossPlatformIrSnapshot`。定稿与生成前调用 `crossPlatformIrSnapshotService.ts` 写入 `.sentinel/cross-platform-ir.json`。命令 `aicore.snapshotCrossPlatformIR`（`projectPreview.contribution.ts`）。 |
| 2 分端脚手架 | **已实现** | `crossPlatformTemplates.ts`：`exports/<端>/project/` 下 Web / iOS / Android / 微信小程序最小模板；`crossPlatformExportService.writeScaffold`。 |
| 3 LLM 分模块落盘 | **已实现（首版）** | `crossPlatformLlmParse.ts` 解析 JSON 文件包；`generateLlmFileBundle` 写入增量文件；非整仓直出。 |
| 4 构建与验证门 | **部分实现** | `crossPlatformGates.ts`：小程序 JSON；iOS：`README` + `Sources/AppEntry.swift`；Android：`README` + `stub/.gitkeep`；Web：`README`。Web 可选 `aiCore.crossPlatform.runNpmBuildGateOnWebExport`。另：**本机/CI 脚本** `scripts/sentinel-cross-platform-gates.mjs`（`--workspace` `--target`）可对 web/ios/android/wechat_miniprogram 做可选 `npm run build` / `xcodebuild -version` / `gradlew` 探测。 |
| 5 产品入口 | **已实现** | 预览条定稿/生成；`aiCore.crossPlatform.openProjectPreviewAfterSentinelComplete`：Sentinel 跑完后可选打开项目预览（`sentinelKernelService.tryAutoPreview`）。 |

**产出物**：`.sentinel/cross-platform-export.json`、`.sentinel/cross-platform-ir.json`、`exports/<web|ios|android|wechat_miniprogram>/project/`、`GENERATION.md`（含校验门与 LLM 落盘说明）。

**HGT-024（Golden Path）**：验收以团队选定真实仓「定稿 → 生成 → 各端打开」为准；自动化侧可配合 `npm run harness-eval:full`（Web 构建烟测）与 `node scripts/sentinel-cross-platform-gates.mjs --workspace <根> --target <web|…>`；书面结论维护于本节「实施状态」表。

**HGT-025（回滚）**：单 target 生成管线在 **抛错** 时会递归删除该端 `exports/<target>/`，并在 manifest `runs[target].error` 中记录原因；门禁仅失败（非抛错）时保留目录便于审阅。

---

## 后续演进项（非阻塞首版）

- Golden path 书面验收与示例仓库固化。  
- 跨端 **RN 单栈** 若需与文档「一种移动技术栈」完全对齐，可将 iOS/Android 模板迁为同一 RN 子工程（当前为 Swift / Kotlin 占位）。  
- Web 导出门禁默认关闭（构建慢）；可按团队需要在设置中开启。

---

*文档位置：`vscode/docs/sentinel/cross-platform-export-roadmap.md`。可与 [pipeline-known-gaps-and-remediation.md](./pipeline-known-gaps-and-remediation.md) 交叉引用。*
