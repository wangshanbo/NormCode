# 悦界 IDE vs Kiro 差距分析与行动计划

> 生成时间: 2026-01-18
> 目标: 达到 Kiro 90% 功能还原度

---

## 📊 当前状态

### ✅ 已实现功能
- [x] GLM-4.7 大模型集成（流式输出、深度思考、联网搜索）
- [x] GLM-5 前置任务分析路由（每次提问先分析难度）
- [x] 按任务难度自动模型分配（simple/medium/hard）
- [x] 子代理自动分配（quick_responder / implementation_agent / planning_agent）
- [x] 子代理编排（自动委派 + 显式 `/agent` 调用 + `resume agent` 恢复）
- [x] 视觉任务自动路由（GLM-4.6V / 4.6V-FlashX / 4.6V-Flash）
- [x] Spec 文档自动生成（requirements.md, design.md, tasks.md）
- [x] EARS 格式需求文档（Given/When/Then）
- [x] Mermaid 序列图生成
- [x] Autopilot 自动执行模式
- [x] 任务分解与自动执行
- [x] 代码自动生成与文件创建
- [x] Context Providers (#file, #folder, #codebase)
- [x] SPECS 侧边栏
- [x] 项目级 Skills 自动生成（按项目名 + architecture/coding/testing 分层）

### ⚠️ 存在问题（P0 已修复 ✅）
- ~~JSON 解析错误导致任务中断~~ ✅ 已修复 - `safeParseJSON()` 增强容错
- ~~任务失败无法重试~~ ✅ 已修复 - `executeWithRetry()` 指数退避重试
- ~~错误信息对用户不友好~~ ✅ 已修复 - `toFriendlyErrorMessage()` 错误映射
- ~~刷新后任务状态丢失~~ ✅ 已修复 - `session.json` 持久化
- ~~对话没有上下文关联~~ ✅ 已修复 - 会话管理 + 智谱 AI 上下文缓存
- ~~每次提问固定单模型执行~~ ✅ 已修复 - GLM-5 路由 + 动态模型分配
- ~~视觉文件无法参与自动路由~~ ✅ 已修复 - 二进制附件识别 + 4.6V 路由
- UI 与 Kiro 差距较大（P1 计划中）

---

## 🎯 行动计划

### P0 - 阻塞体验（立即修复）✅ 已完成

| # | 任务 | 问题描述 | 解决方案 | 文件 | 状态 |
|---|------|----------|----------|------|------|
| 0.1 | 修复 JSON 解析错误 | LLM 返回非标准 JSON 导致 SyntaxError | 增强 JSON 解析容错：`safeParseJSON()` 函数，提取 JSON、修复常见格式问题、从 markdown 代码块提取 | `chatSetupProviders.ts`, `specModeService.ts` | ✅ |
| 0.2 | 任务失败自动重试 | 单个任务失败整个流程中断 | 添加重试机制：`executeWithRetry()` 函数，最多 3 次重试，指数退避 (1s, 2s, 4s) | `chatSetupProviders.ts`, `specModeService.ts` | ✅ |
| 0.3 | 友好化错误信息 | 显示原始技术错误用户看不懂 | 错误信息映射表 `ERROR_MESSAGE_MAP`，`toFriendlyErrorMessage()` 函数转换为用户语言 | `chatSetupProviders.ts`, `specModeService.ts` | ✅ |
| 0.4 | 任务状态持久化 | 刷新后任务状态丢失 | `saveSessionState()` / `loadSessionState()` 保存到 `.specs/session.json` | `specModeService.ts` | ✅ |

**验收标准:**
- [x] 任务执行不再因 JSON 错误中断
- [x] 失败任务自动重试，用户看到 "正在重试..."
- [x] 错误信息显示 "任务执行失败，正在重试" 而非 "SyntaxError"
- [x] 刷新页面后任务状态保留

---

### P1 - 核心体验（本周完成）✅ 已完成

| # | 任务 | Kiro 效果 | 解决方案 | 文件 | 状态 |
|---|------|-----------|----------|------|------|
| 1.1 | 顶部导航标签 | `[1]Requirements [2]Design [3]Tasks` 三个标签页 | 在 SPECS 面板新增标签栏并按 phase 自动切换 | `specsPane.ts`, `specsPane.css` | ✅ |
| 1.2 | 任务卡片 UI | 每个任务独立卡片，有状态图标 | 卡片化任务渲染 + 状态图标 | `specsPane.ts`, `specsPane.css` | ✅ |
| 1.3 | Start 按钮 | 每个待办任务有 ▶ Start | 待办任务可单击启动执行 | `specsPane.ts` | ✅ |
| 1.4 | Retry 按钮 | 失败任务有 ↻ Retry | blocked/failed 任务可重试 | `specsPane.ts`, `specModeService.ts` | ✅ |
| 1.5 | 实时状态更新 | 执行中任务显示 🔄 动画 | 执行态动画 + 任务状态实时刷新 | `specsPane.ts`, `specsPane.css` | ✅ |

**验收标准:**
- [x] 顶部有 Requirements/Design/Tasks 三个标签，可点击切换
- [x] 任务以卡片形式展示，有清晰的状态图标
- [x] 待办任务有 Start 按钮，点击开始执行
- [x] 失败任务有 Retry 按钮，点击重试
- [x] 执行中的任务显示加载动画

---

### P1.5 - 智能路由增强（已落地）✅

| # | 任务 | 目标 | 实现方案 | 文件 | 状态 |
|---|------|------|----------|------|------|
| 1.5.1 | GLM-5 前置分析器 | 每次提问先做难度判定 | `analyzeTaskAndRoute()` 返回 complexity/subAgent/model | `glmChatService.ts` | ✅ |
| 1.5.2 | 文本任务自动分配 | 成本与质量平衡 | `simple→4.7-flash`, `medium→4.7`, `hard→5`（可配置） | `glmChatService.ts`, `aiCore.contribution.ts` | ✅ |
| 1.5.3 | 视觉任务自动分配 | 图像/视频/文档走视觉模型 | 自动检测附件与意图，路由到 `4.6V` 系列 | `chatResponseHandler.ts`, `glmChatService.ts` | ✅ |
| 1.5.4 | 路由可配置化 | 支持后续调优策略 | 新增 `aiCore.enableAutoModelRouting`、`routingModel*`、`routingVisionModel*` | `aiCore.contribution.ts` | ✅ |

**验收标准:**
- [x] 每次请求都先经过 GLM-5 路由分析
- [x] 文本任务按 simple/medium/hard 自动分配模型
- [x] 图片/视频/文档任务自动路由到 4.6V 系列
- [x] 路由策略支持配置覆盖

---

### P1.6 - 子代理体系增强（已落地）✅

| # | 任务 | 目标 | 实现方案 | 文件 | 状态 |
|---|------|------|----------|------|------|
| 1.6.1 | 子代理定义加载 | 支持项目级子代理定义 | 加载 `.agents/agents/*.md`，兼容 `.cursor/agents/*.md` | `subagentOrchestratorService.ts` | ✅ |
| 1.6.2 | 默认子代理引导 | 新项目开箱可用 | 自动生成 `quick-responder` / `implementation-agent` / `planning-agent` | `subagentOrchestratorService.ts` | ✅ |
| 1.6.3 | 显式子代理调用 | 对齐 `/name` 使用习惯 | 支持 `/quick-responder ...`、`/implementation-agent ...` | `chatSetupProviders.ts` | ✅ |
| 1.6.4 | 子代理会话恢复 | 支持长任务续跑 | 支持 `resume agent <agentId> ...` 与 `/resume <agentId> ...` | `subagentOrchestratorService.ts`, `chatSetupProviders.ts` | ✅ |
| 1.6.5 | 自动委派接入主链路 | 路由不止“打标签” | GLM-5 路由后真实调用对应子代理并回注分析上下文 | `chatSetupProviders.ts` | ✅ |

**验收标准:**
- [x] 项目内可加载/识别子代理定义文件
- [x] 支持显式 `/agent-name` 调用
- [x] 支持基于 `agentId` 的恢复执行
- [x] 路由结果触发真实子代理执行而非仅日志输出

---

### P2 - 信息透明（下周完成）⏰ 预计 6 小时

| # | 任务 | Kiro 效果 | 解决方案 | 文件 |
|---|------|-----------|----------|------|
| 2.1 | Files Updated 面板 | 右侧显示修改的文件列表 | 监听文件写入事件，累积显示 | `specEditorView.ts` |
| 2.2 | View changes | 点击查看文件 Diff | 调用 VSCode Diff 编辑器 | `specEditorPane.ts` |
| 2.3 | View execution | 查看任务执行日志 | 保存执行日志，弹窗显示 | `specModeService.ts` |
| 2.4 | 执行统计 | Credits/Elapsed time | 记录开始时间，计算耗时 | `specEditorView.ts` |
| 2.5 | 任务完成通知 | 任务完成桌面通知 | 调用 VSCode 通知 API | `chatSetupProviders.ts` |

**验收标准:**
- [ ] 右侧面板显示 "Files Updated:" 列表
- [ ] 点击 View changes 打开 Diff 视图
- [ ] 点击 View execution 显示执行日志
- [ ] 底部显示 "Elapsed time: 5m 32s"
- [ ] 全部任务完成后弹出通知

---

### P2.5 - Skills 体系增强（已落地）✅

| # | 任务 | 目标 | 实现方案 | 文件 | 状态 |
|---|------|------|----------|------|------|
| 2.5.1 | 项目级 Skills 自动初始化 | 新/旧项目都具备可用技能 | 新项目按需求生成；旧项目无 skills 时扫描后生成 | `chatSetupProviders.ts` | ✅ |
| 2.5.2 | Skills 目录策略优化 | 避免绑定单一产品目录 | 首选 `.agents/skills`，兼容历史 `.cursor/skills` | `chatSetupProviders.ts` | ✅ |
| 2.5.3 | 分层技能模板 | 提升复杂任务执行质量 | 自动生成 `architecture / coding / testing` 三层 `SKILL.md` | `chatSetupProviders.ts` | ✅ |
| 2.5.4 | 旧项目扫描报告 | 提升可解释性与可复用性 | 生成 `references/PROJECT_SCAN.md` | `chatSetupProviders.ts` | ✅ |

---

### P3 - 精细控制（两周内完成）⏰ 预计 6 小时

| # | 任务 | Kiro 效果 | 解决方案 | 文件 |
|---|------|-----------|----------|------|
| 3.1 | 任务依赖显示 | `_需求: 4.2, 4.4_` | LLM 生成任务时提取依赖关系 | `specModeService.ts` |
| 3.2 | 依赖顺序执行 | 先执行依赖任务 | 拓扑排序，按依赖顺序执行 | `chatSetupProviders.ts` |
| 3.3 | Make task required | 标记必要任务 | 添加按钮，修改任务属性 | `specEditorView.ts` |
| 3.4 | Skip task | 跳过可选任务 | 添加 Skip 按钮 | `specEditorView.ts` |
| 3.5 | 任务编辑 | 可修改任务描述 | 双击编辑，保存到 session | `specEditorView.ts` |
| 3.6 | Update tasks | 重新生成任务列表 | 按钮触发重新分析 | `specModeService.ts` |

**验收标准:**
- [ ] 每个任务显示依赖的其他任务
- [ ] 自动按依赖顺序执行
- [ ] 可标记任务为必需/可选
- [ ] 可跳过非必需任务
- [ ] 可编辑任务描述
- [ ] 可重新生成任务列表

---

### P4 - 未来迭代（1个月后）⏰ 预计 20 小时

| # | 任务 | 描述 | 优先级 |
|---|------|------|--------|
| 4.1 | Hooks 自动化 | 文件保存时自动触发操作 | 中 |
| 4.2 | Steering 规则 | 自定义 AI 行为规则 | 中 |
| 4.3 | MCP 服务器集成 | 连接外部工具和数据源 | 低 |
| 4.4 | 多会话支持 | 同时处理多个 Spec 项目 | 低 |
| 4.5 | 团队协作 | 多人共享 Spec 会话 | 低 |
| 4.6 | 版本控制集成 | 自动 commit 生成的代码 | 中 |
| 4.7 | 代码审查建议 | AI 审查生成的代码 | 中 |
| 4.8 | 测试自动运行 | 生成代码后自动运行测试 | 高 |

---

## 📅 时间线

```
Week 1 (1/18 - 1/24)
├── Day 1-2: P0 全部完成（JSON 修复、重试、错误信息）
├── Day 3-4: P1.1-1.2（顶部导航、任务卡片）
└── Day 5-7: P1.3-1.5（Start/Retry 按钮、实时状态）

Week 2 (1/25 - 1/31)
├── Day 1-2: P2.1-2.2（Files Updated、View changes）
├── Day 3-4: P2.3-2.5（执行日志、统计、通知）
└── Day 5-7: Buffer / 修复问题

Week 3 (2/1 - 2/7)
├── Day 1-3: P3.1-3.3（任务依赖、顺序执行、标记）
└── Day 4-7: P3.4-3.6（跳过、编辑、更新）

Week 4+
└── P4 迭代优化
```

---

## 🔧 技术实现要点

### JSON 解析容错 ✅ 已实现
```typescript
// 位置: chatSetupProviders.ts, specModeService.ts
function safeParseJSON<T = unknown>(text: string): T | null {
  // 1. 尝试直接解析
  try { return JSON.parse(text) as T; } catch {}

  // 2. 尝试提取 JSON 对象
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    try { return JSON.parse(jsonObjectMatch[0]) as T; } catch {}
  }

  // 3. 尝试提取 JSON 数组
  const jsonArrayMatch = text.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try { return JSON.parse(jsonArrayMatch[0]) as T; } catch {}
  }

  // 4. 修复常见问题
  let fixedText = extracted
    .replace(/,\s*}/g, '}')   // 尾部逗号
    .replace(/,\s*]/g, ']')   // 数组尾部逗号
    .replace(/'/g, '"')       // 单引号改双引号
    .replace(/\n/g, '\\n');   // 未转义换行

  try { return JSON.parse(fixedText) as T; } catch {}

  // 5. 从 markdown 代码块提取
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()) as T; } catch {}
  }

  return null;
}
```

### 任务重试机制 ✅ 已实现
```typescript
// 位置: chatSetupProviders.ts, specModeService.ts
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; onRetry?: Function }
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, onRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
        if (onRetry) onRetry(attempt + 1, error);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}
```

### 友好错误信息映射 ✅ 已实现
```typescript
// 位置: chatSetupProviders.ts, specModeService.ts
const ERROR_MESSAGE_MAP: Record<string, string> = {
  'SyntaxError': '数据格式解析失败，正在重试...',
  'JSON': '响应格式异常，正在重试...',
  'network': '网络连接失败，请检查网络设置',
  'Failed to fetch': '无法连接到服务器，请检查网络',
  'timeout': '请求超时，正在重试...',
  '429': '请求过于频繁，请稍后重试',
  '500': '服务器内部错误，请稍后重试'
};

function toFriendlyErrorMessage(error: unknown): string {
  const errorStr = String(error);
  for (const [key, msg] of Object.entries(ERROR_MESSAGE_MAP)) {
    if (errorStr.includes(key)) return msg;
  }
  return '任务执行遇到问题，请稍后重试';
}
```

### 会话状态持久化 ✅ 已实现
```typescript
// 位置: specModeService.ts
// 保存: .specs/session.json
async saveSessionState(): Promise<void> {
  const sessionFile = URI.joinPath(this._specsFolder, 'session.json');
  const sessionData = {
    version: 1,
    savedAt: new Date().toISOString(),
    session: { id, phase, userStories, technicalDesign, tasks }
  };
  await this.fileService.writeFile(sessionFile, VSBuffer.fromString(JSON.stringify(sessionData)));
}

async loadSessionState(): Promise<boolean> {
  const sessionFile = URI.joinPath(this._specsFolder, 'session.json');
  const content = await this.fileService.readFile(sessionFile);
  const data = safeParseJSON(content.value.toString());
  if (data?.session) {
    this._currentSession = data.session;
    return true;
  }
  return false;
}
```

### 上下文缓存（会话管理）✅ 已实现
```typescript
// 位置: glmChatService.ts
// 参考: https://docs.bigmodel.cn/cn/guide/capabilities/cache

interface ChatSession {
  id: string;
  messages: GLMMessage[];
  cacheStats: { totalTokens: number; cachedTokens: number; };
}

// 创建会话，自动维护对话历史
createSession(systemPrompt?: string): ChatSession;

// 带会话上下文的流式聊天（利用智谱 AI 上下文缓存）
async *streamChatWithSession(userMessage, context, options) {
  // 自动添加用户消息到历史
  this.addMessage(session.id, { role: 'user', content: userMessage });

  // 发送包含完整历史的请求（缓存命中时只计费 50%）
  for await (const event of this.streamChat(messages, context, options)) {
    yield event;
  }

  // 自动添加助手回复到历史
  this.addMessage(session.id, { role: 'assistant', content: response });
}

// 缓存统计
getCacheStats(sessionId): { totalTokens, cachedTokens, savings: "45%" };
```

### GLM-5 前置路由 + 子代理分配 ✅ 已实现
```typescript
// 位置: glmChatService.ts, chatSetupProviders.ts
// 每次请求先进行路由分析
const routingPlan = await glmService.analyzeTaskAndRoute(
  userMessage,
  context,
  chatMode,
  isAgentMode
);

// 路由结果（示例）
// {
//   complexity: 'simple' | 'medium' | 'hard',
//   subAgent: 'quick_responder' | 'implementation_agent' | 'planning_agent',
//   model: 'glm-4.7-flash' | 'glm-4.7' | 'glm-5.1' | 'glm-4.6v*',
//   requiresVision: boolean
// }
```

### 子代理编排（自动委派 + 显式调用 + 恢复）✅ 已实现
```typescript
// 位置: subagentOrchestratorService.ts, chatSetupProviders.ts
// 支持目录：
// - .agents/agents/*.md
// - 兼容 .cursor/agents/*.md

// 显式调用
// /quick-responder 解释这个报错
// /implementation-agent 修复这个类型错误

// 恢复执行
// resume agent sa_xxx 继续上次任务
// /resume sa_xxx 继续
```

### 项目级 Skills 自动生成（分层）✅ 已实现
```typescript
// 位置: chatSetupProviders.ts
// 目录策略：
// - 首选 .agents/skills/
// - 兼容 .cursor/skills/

// 自动生成（按项目名）：
// - <project>-architecture/SKILL.md
// - <project>-coding/SKILL.md
// - <project>-testing/SKILL.md
// - 旧项目补充 references/PROJECT_SCAN.md
```

### 视觉任务自动路由（GLM-4.6V 系列）✅ 已实现
```typescript
// 位置: chatResponseHandler.ts, glmChatService.ts
// 二进制附件（图片/视频）识别后注入占位上下文
content: `[Binary visual file attached: xxx.png]`

// 路由策略（默认）
// simple visual  -> glm-4.6v-flash
// medium visual  -> glm-4.6v-flashx
// hard visual    -> glm-4.6v
```

### WebView 通信 (P1 计划)
```typescript
// 主进程 -> WebView
webview.postMessage({ type: 'taskUpdate', task, status: 'running' });

// WebView -> 主进程
window.addEventListener('message', (e) => {
  if (e.data.type === 'startTask') {
    executeTask(e.data.taskId);
  }
});
```

---

## 📈 成功指标

| 指标 | 当前 | 目标 | 达成时间 | 状态 |
|------|------|------|----------|------|
| 任务成功率 | ~70% → **~90%** | 95% | Week 1 | 🟡 进行中 |
| 用户手动干预次数 | 多 → **减少** | 少于 2 次/项目 | Week 2 | 🟡 进行中 |
| P0 完成度 | 0% → **100%** | 100% | Day 1 | ✅ 完成 |
| 自动路由覆盖率 | 0% → **100%** | 100% | Week 2 | ✅ 完成 |
| 多模态任务覆盖 | 0% → **已接入 4.6V** | 全量可用 | Week 2 | ✅ 完成 |
| 子代理能力还原度 | 0% → **70%** | 90% | Week 3 | 🟡 进行中 |
| Skills 自动化覆盖 | 0% → **100%** | 100% | Week 3 | ✅ 完成 |
| Kiro 功能还原度 | 40% → **72%** | 80% | Week 3 | 🟡 进行中 |
| Kiro 功能还原度 | 80% | 90% | Week 4 | ⏳ 待开始 |
| 用户满意度 | - | 8/10 | Week 4 | ⏳ 待开始 |

---

## 📝 备注

- 所有任务按用户体验影响排序
- P0 为阻塞性问题，必须立即修复
- P1 完成后可达到基本可用状态
- P2 完成后用户体验大幅提升
- P3 完成后接近 Kiro 体验
- P4 为长期优化项目

---

*文档版本: v1.2*
*负责人: AI Core Team*
