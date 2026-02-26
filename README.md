# NormCode - 智能编程 IDE

[![GitHub](https://img.shields.io/badge/GitHub-NormCode-blue?logo=github)](https://github.com/wangshanbo/NormCode)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.txt)

基于 VS Code 深度定制的 AI 原生集成开发环境，内置智谱 AI GLM 大模型，提供沉浸式的 AI 辅助编程体验。

<p align="center">
  <img alt="NormCode IDE" src="https://user-images.githubusercontent.com/35271042/118224532-3842c400-b438-11eb-923d-a5f66fa6785a.png">
</p>

## ✨ 核心特性

### 🤖 AI 对话助手

内置 AI Chat 面板，支持两种工作模式：

- **⚡ Vibe 模式** - 边聊边做，快速迭代
  - 快速响应，直接给出解决方案
  - 适合探索性开发和快速原型
  - 代码优先，解释辅助

- **📋 Spec 模式** - 先规划后执行
  - 需求理解 → 用户故事 → 技术设计 → 任务分解 → 执行
  - 适合复杂功能开发
  - 结构化输出，便于追踪
  - SPECS 面板支持 Requirements / Design / Tasks 标签切换
  - 任务卡片支持 Start / Retry 与执行中状态展示
  - 打开 `.specs/<session>/tasks.md` 时，任务上方提供 Kiro 风格操作按钮（CodeLens）
    - `Start task` / `Retry` / `Task completed`
    - `View changes`（自动解析并打开改动文件）
    - `View execution`（打开任务执行详情文档）

### 🔧 Agent 工具集

AI 可以直接操作您的工作区：

| 工具 | 功能 |
|------|------|
| `read_file` | 读取文件内容 |
| `list_dir` | 查看目录结构 |
| `grep_search` | 代码搜索 |
| `search_files` | 文件名搜索 |
| `write_file` | 创建/修改文件 |
| `run_command` | 执行终端命令 |
| `get_diagnostics` | 获取代码诊断 |
| `browse_url` | 访问网页 |
| `web_search_deep` | 深度搜索 |

### 🧠 智能模型路由（新增）

每次用户提问前，系统会先使用 **GLM-5** 做任务分析，并自动分配子代理与执行模型：

- **复杂度分级**：`simple` / `medium` / `hard`
- **子代理分配**：`quick_responder` / `implementation_agent` / `planning_agent`
- **默认文本模型策略（可配置）**：
  - `simple` → `glm-4.7-flash`（低成本快速响应）
  - `medium` → `glm-4.7`（平衡成本与效果）
  - `hard` → `glm-5`（质量优先）

### 👁️ 视觉理解自动路由（新增）

当用户附加图片/视频/文档，或提问包含视觉理解意图时，自动路由到 **GLM-4.6V 系列**：

- `simple visual` → `glm-4.6v-flash`
- `medium visual` → `glm-4.6v-flashx`
- `hard visual` → `glm-4.6v`

支持场景：截图解释、图像信息提取、视频片段理解、PDF/文档内容分析等。

### 🧩 项目 Skills 自动生成（新增）

参考 Cursor Agent Skills 规范，系统在聊天时会自动检查项目级 Skills：

- **新项目**：根据用户需求、任务目标与架构选择自动生成分层技能
- **旧项目（无项目级 skills）**：先进行深度结构扫描，再生成分层技能

默认生成位置：

- 首选 `.agents/skills/`（更通用，不绑定 Cursor）
- 兼容复用已存在的 `.cursor/skills/`（历史项目）

按项目名自动生成目录（示例）：

- `.agents/skills/my-project-architecture/SKILL.md`
- `.agents/skills/my-project-coding/SKILL.md`
- `.agents/skills/my-project-testing/SKILL.md`
- （旧项目）`.agents/skills/my-project-architecture/references/PROJECT_SCAN.md`

### 🤖 子代理（Subagents）编排（新增）

系统已支持项目级子代理编排，默认目录为：

- 首选 `.agents/agents/`
- 兼容 `.cursor/agents/`

当项目无子代理定义时，会自动初始化 3 个默认子代理：

- `quick-responder`（简单问题快速响应）
- `implementation-agent`（实现/修复类任务）
- `planning-agent`（架构与规划类任务）

支持能力：

- **自动委派**：GLM-5 路由后，按复杂度自动选择子代理
- **并行执行**：Autopilot 任务执行支持并行子代理 worker（默认 3，可配置 1-3，受 GLM 并发限制）
- **显式调用**：输入 `/quick-responder ...`、`/implementation-agent ...`
- **恢复会话**：输入 `resume agent <agentId> ...` 或 `/resume <agentId> ...`
- **任务即时回写**：任务状态变化会第一时间同步到 `.specs/<session>/tasks.md`

### 🧱 稳定性与兼容性（新增）

- **启动容器安全降级**：若启动阶段暂未拿到内置 Chat 容器（`workbench.panel.chat`），系统会自动回退到 `AI Core` 面板容器，避免应用因视图注册失败崩溃。
- **旧任务文件兼容**：即使历史 `tasks.md` 没有 `task-id` 锚点，也可按任务标题回退匹配并显示任务操作按钮。
- **执行详情可追溯**：每个任务的执行结果会写入 `.specs/<session>/.runs/<taskId>.md`，便于复盘与审查。

### 💭 深度思考模式

基于智谱 AI GLM-5 的深度思考能力：
- 复杂问题的多步推理
- 思考过程可视化展示
- 更准确的代码理解和生成

### 🌐 智能联网搜索

自动判断是否需要搜索最新信息：
- 时效性信息自动联网
- 搜索结果智能整合
- 代码问题默认离线处理

### 📜 项目规范 (.aispec)

通过配置文件定义项目级 AI 规则：

```json
{
  "version": "1.0",
  "rules": [
    {
      "id": "code-style",
      "content": "使用 TypeScript 严格模式，遵循 ESLint 规范",
      "enabled": true
    }
  ],
  "fileRules": {
    "**/*.tsx": [
      {
        "id": "react-rules",
        "content": "使用函数组件和 Hooks，避免 class 组件"
      }
    ]
  }
}
```

## 🚀 快速开始

### 环境要求

- Node.js 22+（推荐，避免 TypeScript ESM 运行问题）
- Python 3.8+ (可选，用于部分扩展)
- Git

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/wangshanbo/NormCode.git
cd NormCode

# 安装依赖
npm install

# 编译
npm run compile

# 启动开发模式
npm run watch
```

### 运行 IDE

```bash
# 推荐：本地开发启动（跳过内置扩展同步）
./scripts/code.sh --skip-builtin
```

## 🏗️ 项目架构

```
src/vs/workbench/
├── contrib/aiCore/              # AI 功能贡献点
│   ├── browser/
│   │   ├── chatWebview/         # React Chat UI
│   │   │   ├── media/           # React 组件
│   │   │   │   ├── components/  # UI 组件
│   │   │   │   ├── useChat.ts   # 状态管理
│   │   │   │   └── types.ts     # 类型定义
│   │   │   ├── chatWebviewPane.ts
│   │   │   └── protocol.ts      # 消息协议
│   │   ├── specEditor/          # Spec 编辑器
│   │   └── specsPane.ts         # Specs 面板
│   └── chatWebview.contribution.ts
│
└── services/aiCore/             # AI 核心服务
    ├── browser/
    │   ├── glmChatService.ts    # GLM 聊天服务（含 GLM-5 路由与 4.6V 视觉路由）
    │   ├── subagentOrchestratorService.ts # 子代理编排（自动委派/显式调用/恢复）
    │   ├── agentToolService.ts  # Agent 工具服务
    │   ├── chatModeService.ts   # 模式管理服务
    │   ├── specModeService.ts   # Spec 生命周期与任务状态管理
    │   ├── codeIndexService.ts  # 代码索引服务
    │   └── contextProvidersService.ts
    └── common/
        ├── aiCoreService.ts     # AI 核心服务
        ├── specService.ts       # 规范服务
        ├── embeddingService.ts  # 向量嵌入服务
        ├── codeChunker.ts       # 代码分块器
        └── llmService.ts        # LLM 服务
```

## ⚙️ 配置选项

在 VS Code 设置中配置 AI 功能：

```json
{
  // GLM API 配置
  "aiCore.glmApiKey": "your-api-key",
  "aiCore.glmModel": "glm-4.7",

  // 自动模型路由（新增）
  "aiCore.enableAutoModelRouting": true,
  "aiCore.routingModelSimple": "glm-4.7-flash",
  "aiCore.routingModelMedium": "glm-4.7",
  "aiCore.routingModelHard": "glm-5",

  // 视觉路由（新增）
  "aiCore.enableVisionRouting": true,
  "aiCore.routingVisionModelSimple": "glm-4.6v-flash",
  "aiCore.routingVisionModelMedium": "glm-4.6v-flashx",
  "aiCore.routingVisionModelHard": "glm-4.6v",

  // 功能开关
  "aiCore.enableThinking": true,
  "aiCore.enableWebSearch": true,
  "aiCore.agentMode": true,

  // 默认模式
  "aiCore.defaultChatMode": "vibe",

  // 搜索引擎
  "aiCore.searchEngine": "search_pro"
}
```

## 📦 Chat Webview 开发

Chat UI 使用 React 构建，支持热更新：

```bash
# 单独构建 Chat Webview
npm run compile-chat-webview

# Watch 模式（集成在主 watch 中）
npm run watch
```

### 组件结构

```
ChatApp
├── ChatHeader        # 头部（模式切换）
├── MessageList       # 消息列表
│   └── Message       # 单条消息
│       ├── ThinkingIndicator  # 思考动画
│       ├── ToolCallCard       # 工具调用卡片
│       ├── MarkdownContent    # Markdown 渲染
│       └── CodeBlock          # 代码块
└── ChatInput         # 输入框
```

## 🔌 扩展开发

AI Code IDE 完全兼容 VS Code 扩展生态，同时提供额外的 AI 能力 API：

```typescript
// 访问 AI 核心服务
import { IAICoreService } from 'vs/workbench/services/aiCore/common/aiCoreService';

// 发送 AI 请求
const response = await aiCoreService.sendRequest({
  sessionId: 'my-session',
  message: '帮我优化这段代码',
  mode: 'agent'
});
```

## 🛠️ 开发命令

| 命令 | 说明 |
|------|------|
| `npm run watch` | 开发模式（包含 Chat Webview） |
| `npm run compile` | 完整编译 |
| `npm run test` | 运行测试 |
| `npm run electron` | 启动 Electron |
| `npm run compile-chat-webview` | 单独编译 Chat UI |

## 🤝 贡献指南

欢迎贡献代码！请遵循以下流程：

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 ESLint 规则
- 编写单元测试
- 保持代码注释完整

## 📄 许可证

本项目基于 [MIT 许可证](LICENSE.txt) 开源。

---

## 致谢

- [Visual Studio Code](https://github.com/microsoft/vscode) - 基础 IDE 框架
- [智谱 AI](https://www.zhipuai.cn/) - GLM 大语言模型
- 所有贡献者和社区成员

---

<p align="center">
  <a href="https://github.com/wangshanbo/NormCode">⭐ Star NormCode on GitHub</a>
</p>
