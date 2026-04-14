/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// AI Core GLM Chat Service
// 负责处理 GLM 模型的对话请求，包括流式输出、工具调用、深度思考、联网搜索
// 参考文档:
// - 深度思考: https://docs.bigmodel.cn/cn/guide/capabilities/thinking
// - 联网搜索: https://docs.bigmodel.cn/cn/guide/tools/web-search

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IHarnessTraceService } from './harnessTraceService.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface GLMMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string;
	tool_calls?: GLMToolCall[];
	tool_call_id?: string;
}

/** HGT-012：保留最近若干条 tool 消息全文，更早的替换为占位，降低陈旧工具结果体积 */
function compactStaleToolMessagesForHgt012(messages: GLMMessage[], keepLast: number): GLMMessage[] {
	if (keepLast <= 0) {
		return messages;
	}
	const toolIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'tool') {
			toolIndices.push(i);
		}
	}
	if (toolIndices.length <= keepLast) {
		return messages;
	}
	const drop = new Set(toolIndices.slice(0, toolIndices.length - keepLast));
	const placeholder = '[HGT-012：较早的 tool 输出已省略；如需请 read_file 或重新调用工具]';
	return messages.map((m, i) => (drop.has(i) ? { ...m, content: placeholder } : m));
}

/** 非流式 API 返回的 assistant / tool 消息形状 */
export interface GLMCompletionMessage {
	role: string;
	content?: string | null;
	tool_calls?: GLMToolCall[];
}

export interface GLMToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface GLMToolDefinition {
	type: 'function' | 'web_search';
	function?: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, { type: string; description: string }>;
			required?: string[];
		};
	};
	web_search?: {
		enable: boolean;
		search_engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';
		search_result?: boolean;
	};
}

export interface GLMStreamEvent {
	type: 'thinking' | 'content' | 'tool_call' | 'tool_result' | 'web_search' | 'done' | 'error' | 'truncated';
	content?: string;
	toolCall?: GLMToolCall;
	toolResult?: { id: string; output: string; success: boolean };
	webSearchResults?: WebSearchResult[];
	error?: string;
	reason?: string; // 用于 truncated 事件
}

export interface WebSearchResult {
	title: string;
	link: string;
	content: string;
	media?: string;
	icon?: string;
}

export interface GLMChatContext {
	files: Array<{
		uri: URI;
		path: string;
		content: string;
		language?: string;
		lineRange?: string;
	}>;
	webSearchResults?: WebSearchResult[];
}

export interface GLMChatOptions {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	tools?: GLMToolDefinition[];
	/** 启用深度思考模式 */
	enableThinking?: boolean;
	/** 启用联网搜索 */
	enableWebSearch?: boolean;
	/** 搜索引擎类型 */
	searchEngine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';
	/** 会话 ID，用于关联上下文 */
	sessionId?: string;
}

export interface GLMTaskRoutingPlan {
	complexity: 'simple' | 'medium' | 'hard';
	subAgent: 'quick_responder' | 'implementation_agent' | 'planning_agent';
	model: string;
	requiresVision: boolean;
	enableThinking: boolean;
	enableWebSearch: boolean;
	maxTokens: number;
	reason: string;
	confidence: number;
}

// ============================================================================
// 会话管理 - 支持上下文缓存
// 参考: https://docs.bigmodel.cn/cn/guide/capabilities/cache
// ============================================================================

export interface ChatSession {
	id: string;
	messages: GLMMessage[];
	createdAt: Date;
	updatedAt: Date;
	/** 缓存统计 */
	cacheStats: {
		totalTokens: number;
		cachedTokens: number;
	};
}

// ============================================================================
// 服务接口
// ============================================================================

export const IGLMChatService = createDecorator<IGLMChatService>('glmChatService');

export interface IGLMChatService {
	readonly _serviceBrand: undefined;

	/**
	 * 流式发送消息，返回事件流
	 */
	streamChat(
		messages: GLMMessage[],
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken
	): AsyncIterable<GLMStreamEvent>;

	/**
	 * 支持自动续接的流式聊天
	 * 当响应因 token 限制截断时，自动发起续接请求
	 */
	streamChatWithContinuation(
		messages: GLMMessage[],
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken,
		maxContinuations?: number
	): AsyncGenerator<GLMStreamEvent>;

	/**
	 * 单次非流式补全（用于 Sentinel / Agent 工具循环，需完整解析 tool_calls）
	 */
	completeChatTurn(
		messages: GLMMessage[],
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken,
	): Promise<GLMCompletionMessage>;

	/**
	 * 构建系统提示词
	 */
	buildSystemPrompt(context: GLMChatContext, mode: 'chat' | 'agent', chatMode?: 'vibe' | 'spec'): string;

	/**
	 * 执行联网搜索
	 */
	webSearch(query: string): Promise<WebSearchResult[]>;

	/**
	 * 测试连接
	 */
	testConnection(): Promise<boolean>;

	/**
	 * 检查深度思考模式是否开启
	 */
	isThinkingEnabled(): boolean;

	/**
	 * 检查联网搜索是否开启
	 */
	isWebSearchEnabled(): boolean;

	// ========================================================================
	// 会话管理 - 支持上下文缓存
	// 参考: https://docs.bigmodel.cn/cn/guide/capabilities/cache
	// ========================================================================

	/**
	 * 创建新会话
	 * @param systemPrompt 可选的系统提示词
	 */
	createSession(systemPrompt?: string): ChatSession;

	/**
	 * 获取当前会话
	 */
	getCurrentSession(): ChatSession | undefined;

	/**
	 * 获取指定会话
	 */
	getSession(sessionId: string): ChatSession | undefined;

	/**
	 * 清除会话历史
	 */
	clearSession(sessionId?: string): void;

	/**
	 * 添加消息到会话（手动管理）
	 */
	addMessage(sessionId: string, message: GLMMessage): void;

	/**
	 * 获取会话的完整消息列表（用于上下文缓存）
	 */
	getSessionMessages(sessionId: string): GLMMessage[];

	/**
	 * 流式聊天（带会话上下文）
	 * 自动维护对话历史，利用智谱 AI 的上下文缓存功能
	 */
	streamChatWithSession(
		userMessage: string,
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken
	): AsyncIterable<GLMStreamEvent>;

	/**
	 * 获取缓存统计信息
	 */
	getCacheStats(sessionId?: string): { totalTokens: number; cachedTokens: number; savings: string };

	/**
	 * 使用 GLM-5.1 做前置任务分析，返回自动路由计划
	 */
	analyzeTaskAndRoute(userMessage: string, context: GLMChatContext, chatMode: 'vibe' | 'spec', isAgentMode: boolean, forceRouter?: boolean): Promise<GLMTaskRoutingPlan>;
}

// ============================================================================
// 服务实现
// ============================================================================

export class GLMChatService extends Disposable implements IGLMChatService {
	readonly _serviceBrand: undefined;

	private readonly API_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
	private readonly DEFAULT_API_KEY = '20cca2b90c8c4348aaab3d4f6814c33b.Ow4WJfqfc06uB4KI';
	private readonly DEFAULT_MODEL = 'glm-5.1';
	private readonly ROUTER_MODEL = 'glm-5.1';
	/** 应用仅支持 glm-5 / glm-5.1，其余配置值会回落并打日志 */
	private readonly ALLOWED_GLM_MODEL_IDS = new Set<string>(['glm-5', 'glm-5.1']);

	// ========================================================================
	// 会话管理 - 支持上下文缓存
	// ========================================================================
	private readonly _sessions: Map<string, ChatSession> = new Map();
	private _currentSessionId: string | undefined;
	private _activeRequestCount = 0;
	private readonly _pendingRequestQueue: Array<() => void> = [];

	/** 最大历史消息数量（避免超出 token 限制） */
	private readonly MAX_HISTORY_MESSAGES = 50;

	/** 最大历史 token 估算（约 100K，留 28K 给新消息和输出） */
	private readonly MAX_HISTORY_TOKENS = 100000;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHarnessTraceService private readonly harnessTraceService: IHarnessTraceService,
	) {
		super();
	}

	private getMaxConcurrentRequests(): number {
		const configured = this.configurationService.getValue<number>('aiCore.maxParallelSubagents') || 3;
		return Math.max(1, Math.min(3, configured));
	}

	private async acquireRequestSlot(label: string): Promise<() => void> {
		const limit = this.getMaxConcurrentRequests();
		if (this._activeRequestCount < limit) {
			this._activeRequestCount++;
			this.logService.trace(`[GLMChatService] Acquired request slot for ${label}. active=${this._activeRequestCount}/${limit}`);
			return () => this.releaseRequestSlot(label);
		}

		this.logService.trace(`[GLMChatService] Queuing request for ${label}. active=${this._activeRequestCount}/${limit}`);
		return await new Promise(resolve => {
			this._pendingRequestQueue.push(() => {
				this._activeRequestCount++;
				this.logService.trace(`[GLMChatService] Dequeued request for ${label}. active=${this._activeRequestCount}/${limit}`);
				resolve(() => this.releaseRequestSlot(label));
			});
		});
	}

	private releaseRequestSlot(label: string): void {
		this._activeRequestCount = Math.max(0, this._activeRequestCount - 1);
		const limit = this.getMaxConcurrentRequests();
		this.logService.trace(`[GLMChatService] Released request slot for ${label}. active=${this._activeRequestCount}/${limit}`);
		const next = this._pendingRequestQueue.shift();
		if (next) {
			next();
		}
	}

	// ========================================================================
	// 会话管理方法实现
	// ========================================================================

	createSession(systemPrompt?: string): ChatSession {
		const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const session: ChatSession = {
			id: sessionId,
			messages: [],
			createdAt: new Date(),
			updatedAt: new Date(),
			cacheStats: {
				totalTokens: 0,
				cachedTokens: 0
			}
		};

		// 如果有系统提示词，添加为第一条消息
		if (systemPrompt) {
			session.messages.push({
				role: 'system',
				content: systemPrompt
			});
		}

		this._sessions.set(sessionId, session);
		this._currentSessionId = sessionId;

		this.logService.info(`[GLMChatService] Created session: ${sessionId}`);
		return session;
	}

	getCurrentSession(): ChatSession | undefined {
		if (!this._currentSessionId) {
			return undefined;
		}
		return this._sessions.get(this._currentSessionId);
	}

	getSession(sessionId: string): ChatSession | undefined {
		return this._sessions.get(sessionId);
	}

	clearSession(sessionId?: string): void {
		if (sessionId) {
			this._sessions.delete(sessionId);
			if (this._currentSessionId === sessionId) {
				this._currentSessionId = undefined;
			}
			this.logService.info(`[GLMChatService] Cleared session: ${sessionId}`);
		} else {
			// 清除当前会话
			if (this._currentSessionId) {
				this._sessions.delete(this._currentSessionId);
				this._currentSessionId = undefined;
			}
			this.logService.info(`[GLMChatService] Cleared current session`);
		}
	}

	addMessage(sessionId: string, message: GLMMessage): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			this.logService.warn(`[GLMChatService] Session not found: ${sessionId}`);
			return;
		}

		session.messages.push(message);
		session.updatedAt = new Date();

		// 管理历史长度，避免超出限制
		this.trimSessionHistory(session);
	}

	getSessionMessages(sessionId: string): GLMMessage[] {
		const session = this._sessions.get(sessionId);
		// 返回深拷贝，避免外部修改影响原始会话历史
		return session?.messages.map(m => ({ ...m })) || [];
	}

	/**
	 * 修剪会话历史，避免超出 token 限制
	 * 保留系统提示词和最近的消息
	 */
	private trimSessionHistory(session: ChatSession): void {
		const messages = session.messages;

		// 如果消息数量超过限制
		if (messages.length > this.MAX_HISTORY_MESSAGES) {
			// 保留系统消息
			const systemMessages = messages.filter(m => m.role === 'system');
			const nonSystemMessages = messages.filter(m => m.role !== 'system');

			// 保留最近的消息
			const recentMessages = nonSystemMessages.slice(-this.MAX_HISTORY_MESSAGES + systemMessages.length);

			session.messages = [...systemMessages, ...recentMessages];
			this.logService.info(`[GLMChatService] Trimmed session history from ${messages.length} to ${session.messages.length} messages`);
		}

		// 估算 token 数量并进一步修剪
		const estimatedTokens = this.estimateTokens(session.messages);
		if (estimatedTokens > this.MAX_HISTORY_TOKENS) {
			const systemMessages = session.messages.filter(m => m.role === 'system');
			const nonSystemMessages = session.messages.filter(m => m.role !== 'system');

			// 逐步移除旧消息直到 token 数量合适
			while (nonSystemMessages.length > 2 && this.estimateTokens([...systemMessages, ...nonSystemMessages]) > this.MAX_HISTORY_TOKENS) {
				nonSystemMessages.shift();
			}

			session.messages = [...systemMessages, ...nonSystemMessages];
			this.logService.info(`[GLMChatService] Trimmed session to fit token limit: ~${this.estimateTokens(session.messages)} tokens`);
		}
	}

	/**
	 * 估算消息的 token 数量（粗略估计：中文约 2 字符/token，英文约 4 字符/token）
	 */
	private estimateTokens(messages: GLMMessage[]): number {
		let totalChars = 0;
		for (const msg of messages) {
			if (msg.content) {
				totalChars += msg.content.length;
			}
		}
		// 粗略估计：平均 3 字符/token
		return Math.ceil(totalChars / 3);
	}

	/**
	 * 流式聊天（带会话上下文）
	 * 自动维护对话历史，利用智谱 AI 的上下文缓存功能
	 */
	async *streamChatWithSession(
		userMessage: string,
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken
	): AsyncIterable<GLMStreamEvent> {
		// 获取或创建会话
		let session = options?.sessionId
			? this.getSession(options.sessionId)
			: this.getCurrentSession();

		if (!session) {
			// 创建新会话，使用当前模式构建系统提示词
			const isAgentMode = this.configurationService.getValue<boolean>('aiCore.agentMode') !== false;
			const chatMode = this.configurationService.getValue<'vibe' | 'spec'>('aiCore.defaultChatMode') || 'vibe';
			const systemPrompt = this.buildSystemPrompt(context, isAgentMode ? 'agent' : 'chat', chatMode);
			session = this.createSession(systemPrompt);
			this.logService.info(`[GLMChatService] Auto-created session for chat: ${session.id}`);
		}

		// 添加用户消息到会话
		this.addMessage(session.id, {
			role: 'user',
			content: userMessage
		});

		// 构建完整的消息列表（利用上下文缓存）
		const messages = this.getSessionMessages(session.id);

		this.logService.info(`[GLMChatService] Sending chat with ${messages.length} messages (session: ${session.id})`);

		// 收集助手回复
		let assistantContent = '';

		// 使用流式聊天
		for await (const event of this.streamChatWithContinuation(messages, context, options, token)) {
			// 收集内容用于添加到历史
			if (event.type === 'content' && event.content) {
				assistantContent += event.content;
			}

			yield event;
		}

		// 添加助手回复到会话历史
		if (assistantContent) {
			this.addMessage(session.id, {
				role: 'assistant',
				content: assistantContent
			});
			this.logService.info(`[GLMChatService] Added assistant response to session (${assistantContent.length} chars)`);
		}
	}

	getCacheStats(sessionId?: string): { totalTokens: number; cachedTokens: number; savings: string } {
		const session = sessionId ? this.getSession(sessionId) : this.getCurrentSession();
		if (!session) {
			return { totalTokens: 0, cachedTokens: 0, savings: '0%' };
		}

		const { totalTokens, cachedTokens } = session.cacheStats;
		const savingsPercent = totalTokens > 0 ? ((cachedTokens / totalTokens) * 100).toFixed(1) : '0';

		return {
			totalTokens,
			cachedTokens,
			savings: `${savingsPercent}%`
		};
	}

	/**
	 * 更新缓存统计（从 API 响应中提取）
	 */
	private updateCacheStats(sessionId: string, usage: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }): void {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return;
		}

		if (usage.prompt_tokens) {
			session.cacheStats.totalTokens += usage.prompt_tokens;
		}
		if (usage.prompt_tokens_details?.cached_tokens) {
			session.cacheStats.cachedTokens += usage.prompt_tokens_details.cached_tokens;
			this.logService.info(`[GLMChatService] Cache hit: ${usage.prompt_tokens_details.cached_tokens} tokens cached`);
		}
	}

	private getApiKey(): string {
		return this.configurationService.getValue<string>('aiCore.glmApiKey') || this.DEFAULT_API_KEY;
	}

	private normalizeGlmModelId(raw: string | undefined, fallback: string): string {
		const m = (raw ?? '').trim();
		if (this.ALLOWED_GLM_MODEL_IDS.has(m)) {
			return m;
		}
		if (m) {
			this.logService.warn(`[GLMChatService] Unsupported or deprecated model "${m}" — only glm-5 and glm-5.1 are allowed. Using ${fallback}.`);
		}
		return fallback;
	}

	private getModel(): string {
		return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.glmModel'), this.DEFAULT_MODEL);
	}

	private isAutoRoutingEnabled(): boolean {
		return this.configurationService.getValue<boolean>('aiCore.enableAutoModelRouting') !== false;
	}

	private isVisionRoutingEnabled(): boolean {
		return this.configurationService.getValue<boolean>('aiCore.enableVisionRouting') !== false;
	}

	private getModelByComplexity(complexity: 'simple' | 'medium' | 'hard'): string {
		const fallback = 'glm-5.1';
		if (complexity === 'simple') {
			return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.routingModelSimple'), 'glm-5');
		}
		if (complexity === 'medium') {
			return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.routingModelMedium'), fallback);
		}
		return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.routingModelHard'), fallback);
	}

	private getVisionModelByComplexity(complexity: 'simple' | 'medium' | 'hard'): string {
		const defSimple = 'glm-5';
		const defHard = 'glm-5.1';
		if (complexity === 'simple') {
			return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.routingVisionModelSimple'), defSimple);
		}
		if (complexity === 'medium') {
			return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.routingVisionModelMedium'), defHard);
		}
		return this.normalizeGlmModelId(this.configurationService.getValue<string>('aiCore.routingVisionModelHard'), defHard);
	}

	private hasVisualInputs(userMessage: string, context: GLMChatContext): boolean {
		const visualExtRe = /\.(png|jpg|jpeg|webp|gif|bmp|svg|mp4|mov|avi|mkv|webm|pdf)$/i;
		const hasVisualFile = context.files.some(f => visualExtRe.test(f.path) || f.language === 'binary');
		const hasVisualIntent = /图片|图像|看图|识图|截图|视频|多模态|视觉|ocr|pdf|文档解析|image|video|vision/i.test(userMessage);
		return hasVisualFile || hasVisualIntent;
	}

	private getFallbackRoutingPlan(userMessage: string): GLMTaskRoutingPlan {
		const len = userMessage.length;
		const hasCodeIntent = /代码|修复|调试|实现|重构|架构|设计|性能|bug|error|refactor|implement|debug/i.test(userMessage);
		const hasPlanningIntent = /方案|架构|设计|规划|spec|需求|任务分解|trade-?off/i.test(userMessage);

		if (hasPlanningIntent || len > 500) {
			return {
				complexity: 'hard',
				subAgent: 'planning_agent',
				model: this.getModelByComplexity('hard'),
				requiresVision: false,
				enableThinking: true,
				enableWebSearch: true,
				maxTokens: 32768,
				reason: '本地启发式判定为复杂规划类任务',
				confidence: 0.62
			};
		}

		if (hasCodeIntent || len > 120) {
			return {
				complexity: 'medium',
				subAgent: 'implementation_agent',
				model: this.getModelByComplexity('medium'),
				requiresVision: false,
				enableThinking: true,
				enableWebSearch: true,
				maxTokens: 16384,
				reason: '本地启发式判定为中等实现类任务',
				confidence: 0.58
			};
		}

		return {
			complexity: 'simple',
			subAgent: 'quick_responder',
			model: this.getModelByComplexity('simple'),
			requiresVision: false,
			enableThinking: false,
			enableWebSearch: false,
			maxTokens: 8192,
			reason: '本地启发式判定为简单问答',
			confidence: 0.55
		};
	}

	async analyzeTaskAndRoute(userMessage: string, context: GLMChatContext, chatMode: 'vibe' | 'spec', isAgentMode: boolean, forceRouter: boolean = false): Promise<GLMTaskRoutingPlan> {
		if (!this.isAutoRoutingEnabled() && !forceRouter) {
			return {
				complexity: 'medium',
				subAgent: 'implementation_agent',
				model: this.getModel(),
				requiresVision: false,
				enableThinking: this.isThinkingEnabled(),
				enableWebSearch: this.isWebSearchEnabled(),
				maxTokens: 16384,
				reason: '自动路由已关闭，使用默认配置',
				confidence: 1
			};
		}

		const hasVisionInputs = this.hasVisualInputs(userMessage, context) && this.isVisionRoutingEnabled();
		const prompt = [
			'你是一个任务路由器。请评估用户请求难度并返回 JSON，不要输出其他内容。',
			'可选复杂度：simple | medium | hard',
			'可选子代理：quick_responder | implementation_agent | planning_agent',
			'是否需要视觉模型：requiresVision=true|false',
			'仅返回如下 JSON:',
			'{"complexity":"simple|medium|hard","subAgent":"quick_responder|implementation_agent|planning_agent","requiresVision":true,"reason":"简短理由","confidence":0.0}',
			'',
			`ChatMode: ${chatMode}`,
			`AgentMode: ${isAgentMode}`,
			`AttachedFiles: ${context.files.length}`,
			`HasVisionInputs: ${hasVisionInputs}`,
			`UserMessage: ${userMessage}`
		].join('\n');

		try {
			const release = await this.acquireRequestSlot('analyzeTaskAndRoute');
			try {
				const response = await fetch(this.API_ENDPOINT, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this.getApiKey()}`
					},
					body: JSON.stringify({
						model: this.ROUTER_MODEL,
						messages: [
							{ role: 'system', content: '你是严谨的任务难度评估器。输出必须是合法 JSON。' },
							{ role: 'user', content: prompt }
						],
						temperature: 0.1,
						max_tokens: 300,
						stream: false
					})
				});

				if (!response.ok) {
					this.logService.warn(`[GLMChatService] Router model failed: ${response.status}, fallback to heuristic`);
					return this.getFallbackRoutingPlan(userMessage);
				}

				const data = await response.json();
				const content = data?.choices?.[0]?.message?.content || '';
				const match = content.match(/\{[\s\S]*\}/);
				if (!match) {
					this.logService.warn('[GLMChatService] Router JSON not found, fallback to heuristic');
					return this.getFallbackRoutingPlan(userMessage);
				}

				const parsed = JSON.parse(match[0]) as {
					complexity?: 'simple' | 'medium' | 'hard';
					subAgent?: 'quick_responder' | 'implementation_agent' | 'planning_agent';
					requiresVision?: boolean;
					reason?: string;
					confidence?: number;
				};

				const complexity = parsed.complexity ?? 'medium';
				const subAgent = parsed.subAgent ?? (complexity === 'hard' ? 'planning_agent' : complexity === 'simple' ? 'quick_responder' : 'implementation_agent');
				const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.7;
				const requiresVision = Boolean(parsed.requiresVision) || hasVisionInputs;
				const routedModel = requiresVision ? this.getVisionModelByComplexity(complexity) : this.getModelByComplexity(complexity);

				const plan: GLMTaskRoutingPlan = {
					complexity,
					subAgent,
					model: routedModel,
					requiresVision,
					enableThinking: complexity !== 'simple',
					enableWebSearch: complexity !== 'simple',
					maxTokens: complexity === 'hard' ? 32768 : complexity === 'medium' ? 16384 : 8192,
					reason: parsed.reason || 'GLM-5.1 路由评估',
					confidence
				};

				this.logService.info(`[GLMChatService] Routing plan: complexity=${plan.complexity}, subAgent=${plan.subAgent}, vision=${plan.requiresVision}, model=${plan.model}, confidence=${plan.confidence}`);
				return plan;
			} finally {
				release();
			}
		} catch (error) {
			this.logService.warn(`[GLMChatService] Router error, fallback to heuristic: ${String(error)}`);
			return this.getFallbackRoutingPlan(userMessage);
		}
	}

	/**
	 * 检查深度思考模式是否开启（默认开启）
	 */
	isThinkingEnabled(): boolean {
		return this.configurationService.getValue<boolean>('aiCore.enableThinking') !== false;
	}

	/**
	 * 检查联网搜索是否开启（默认开启，强制开启）
	 */
	isWebSearchEnabled(): boolean {
		// 联网搜索强制开启，不可关闭
		return true;
	}

	/**
	 * 获取搜索引擎类型
	 */
	private getSearchEngine(): 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark' {
		return this.configurationService.getValue<'search_std' | 'search_pro'>('aiCore.searchEngine') || 'search_pro';
	}

	async testConnection(): Promise<boolean> {
		try {
			const release = await this.acquireRequestSlot('testConnection');
			try {
				const response = await fetch(this.API_ENDPOINT, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this.getApiKey()}`
					},
					body: JSON.stringify({
						model: this.getModel(),
						messages: [{ role: 'user', content: 'Hello' }],
						max_tokens: 10,
						stream: false
					})
				});

				if (response.ok) {
					this.logService.info('[GLMChatService] Connection test successful');
					return true;
				}
				return false;
			} finally {
				release();
			}
		} catch (error) {
			this.logService.error(`[GLMChatService] Connection test failed: ${String(error)}`);
			return false;
		}
	}

	/**
	 * 单次 Chat API 联网搜索（内部；HGT-022 由 {@link webSearch} 决定是否重试）
	 */
	private async webSearchSingleAttempt(query: string): Promise<WebSearchResult[]> {
		const apiKey = this.getApiKey();
		const searchEngine = this.getSearchEngine();

		try {
			const release = await this.acquireRequestSlot('webSearch');
			try {
				const response = await fetch(this.API_ENDPOINT, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${apiKey}`
					},
					body: JSON.stringify({
						model: this.DEFAULT_MODEL,
						messages: [{ role: 'user', content: query }],
						tools: [{
							type: 'web_search',
							web_search: {
								enable: true,
								search_engine: searchEngine,
								search_result: true
							}
						}],
						stream: false
					})
				});

				if (!response.ok) {
					const errData = await response.json().catch(() => ({}));
					this.logService.error(`[GLMChatService] Web search failed: ${response.status} - ${JSON.stringify(errData)}`);
					return [];
				}

				const data = await response.json();
				this.logService.trace(`[GLMChatService] Web search response: ${JSON.stringify(data).slice(0, 500)}`);

				const results: WebSearchResult[] = [];

				if (data.choices?.[0]?.message?.tool_calls) {
					for (const toolCall of data.choices[0].message.tool_calls) {
						if (toolCall.type === 'web_browser' && toolCall.web_browser?.outputs) {
							for (const output of toolCall.web_browser.outputs) {
								results.push({
									title: output.title || '',
									link: output.link || '',
									content: output.content || '',
									media: output.media,
									icon: output.icon
								});
							}
						}
						if (toolCall.type === 'web_search' && toolCall.web_search) {
							const ws = toolCall.web_search;
							if (ws.search_result) {
								for (const result of ws.search_result) {
									results.push({
										title: result.title || '',
										link: result.link || result.url || '',
										content: result.content || result.snippet || '',
										media: result.media,
										icon: result.icon
									});
								}
							}
						}
					}
				}

				if (data.web_search && Array.isArray(data.web_search)) {
					for (const item of data.web_search) {
						results.push({
							title: item.title || '',
							link: item.link || item.url || '',
							content: item.content || item.snippet || '',
							media: item.media,
							icon: item.icon
						});
					}
				}

				this.logService.info(`[GLMChatService] Web search returned ${results.length} results`);
				return results;
			} finally {
				release();
			}
		} catch (error) {
			this.logService.error(`[GLMChatService] Web search error: ${String(error)}`);
			return [];
		}
	}

	/**
	 * 执行联网搜索
	 * 参考: https://docs.bigmodel.cn/cn/guide/tools/web-search
	 * 使用智谱 AI 的 Chat API + web_search 工具
	 */
	async webSearch(query: string): Promise<WebSearchResult[]> {
		const searchEngine = this.getSearchEngine();
		this.logService.info(`[GLMChatService] Web search: "${query}" using ${searchEngine}`);

		let results = await this.webSearchSingleAttempt(query);
		if (results.length === 0) {
			this.logService.warn('[GLMChatService] HGT-022: 首次联网 0 条，500ms 后重试一次');
			await new Promise<void>(resolve => setTimeout(resolve, 500));
			results = await this.webSearchSingleAttempt(query);
		}
		if (results.length === 0) {
			this.logService.warn('[GLMChatService] HGT-022: 联网搜索返回 0 条（请检查密钥/网络或改用 browse_url）');
		}
		return results;
	}

	buildSystemPrompt(context: GLMChatContext, mode: 'chat' | 'agent', chatMode?: 'vibe' | 'spec'): string {
		let prompt = '';

		// 根据 Chat 模式（Vibe/Spec）设置基础提示词
		if (chatMode === 'spec') {
			prompt = `你是一个规范驱动的 AI 编程助手，工作在 **Spec 模式**。

## 工作方式
你将帮助用户按以下阶段完成需求：

### 阶段 1: 需求理解
- 理解用户的核心需求，澄清模糊的地方

### 阶段 2: 用户故事生成
将需求拆解为用户故事，每个故事包含：
- 标题和描述（As a... I want... So that...）
- 验收标准（Acceptance Criteria，至少3条）
- 优先级（高/中/低）

### 阶段 3: 技术设计
生成技术设计文档：
- 架构概述
- 组件设计
- 数据流
- 测试策略

### 阶段 4: 任务分解
将用户故事和设计转化为可执行的任务清单

### 阶段 5: 任务执行
逐个执行任务，每个任务完成后显示进度

请用结构化的 Markdown 格式输出。

`;
		} else if (mode === 'agent') {
			prompt = `你是一个敏捷的 AI 编程助手，工作在 **Vibe 模式**。

## 工作风格
- 快速响应，边聊边做
- 直接给出解决方案和代码
- 迭代式改进，根据反馈调整

## 可用工具
- 读取和分析代码文件 (read_file)
- 搜索项目中的代码 (grep_search, search_files)
- 修改和创建文件 (write_file) - 需要用户确认
- 执行终端命令 (run_command)
- 诊断和修复错误 (get_diagnostics)
- 浏览网页 (browse_url) - 访问任意 URL
- 深度搜索 (web_search_deep) - 搜索并综合分析

## 重要
- 不要说"我无法访问链接"，你有工具可以做到
- 保持简洁高效

请用中文回答。

`;
		} else {
			prompt = `你是一个专业的编程助手。请用中文回答，擅长代码分析和技术解释。

`;
		}

		// 添加上下文文件信息
		if (context.files.length > 0) {
			prompt += '## 用户提供的代码上下文\n\n';

			for (const file of context.files) {
				const fileName = file.path.split('/').pop() || file.path;
				const lineInfo = file.lineRange ? `:${file.lineRange}` : '';

				prompt += `### 📄 ${fileName}${lineInfo}\n\n`;
				prompt += '```' + (file.language || '') + '\n';
				prompt += file.content;
				prompt += '\n```\n\n';
			}
		}

		if (context.webSearchResults && context.webSearchResults.length > 0) {
			prompt += this.formatWebSearchAppendix(context.webSearchResults);
		}

		return prompt;
	}

	/**
	 * 联网摘要块（追加到已有 system 提示末尾，禁止覆盖 Sentinel Worker 等专用 system）。
	 */
	private formatWebSearchAppendix(results: WebSearchResult[]): string {
		let block = '## 联网搜索结果\n\n';
		block += '**重要提示**：以下是已经为你检索到的互联网资料，你不需要再访问这些链接。请直接根据这些已提供的信息来回答，并可引用来源。\n\n';

		for (const result of results) {
			block += `### 📄 ${result.title}\n`;
			block += `- 链接: ${result.link}\n`;
			if (result.media) {
				block += `- 来源: ${result.media}\n`;
			}
			if (result.content) {
				block += `- 摘要: ${result.content}\n`;
			}
			block += '\n';
		}

		block += '请基于以上搜索结果，结合你的知识，完成当前角色任务。不要说"无法访问链接"等，因为内容已经提供给你了。\n\n';
		return block;
	}

	async completeChatTurn(
		messages: GLMMessage[],
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken,
	): Promise<GLMCompletionMessage> {
		const traceId = this.harnessTraceService.beginTrace(`glm:completeChatTurn:${options?.sessionId ?? 'na'}`);
		try {
		const apiKey = this.getApiKey();
		const model = options?.model || this.getModel();
		const messagesCopy = messages.map(m => ({ ...m }));
		const enableThinking = options?.enableThinking ?? this.isThinkingEnabled();
		const enableWebSearch = options?.enableWebSearch ?? this.isWebSearchEnabled();

		this.logService.info(`[trace=${traceId}] [GLMChatService] completeChatTurn: thinking=${enableThinking}, webSearch=${enableWebSearch}`);

		const ctxWarnCt = this.configurationService.getValue<number>('aiCore.contextEstimatedCharsWarn') ?? 0;
		const keepToolRounds = this.configurationService.getValue<number>('aiCore.contextKeepStaleToolRounds') ?? 0;
		if (ctxWarnCt > 0) {
			let estCt = JSON.stringify(messagesCopy).length;
			if (keepToolRounds > 0 && estCt > ctxWarnCt) {
				const next = compactStaleToolMessagesForHgt012(messagesCopy, keepToolRounds);
				messagesCopy.length = 0;
				messagesCopy.push(...next);
				estCt = JSON.stringify(messagesCopy).length;
				this.logService.info(`[GLMChatService] HGT-012: compacted stale tool messages, est=${estCt}`);
			}
			if (estCt > ctxWarnCt) {
				this.logService.warn(`[GLMChatService] HGT-012: completeChatTurn 估计上下文 ${estCt} 字符 > 阈值 ${ctxWarnCt}`);
			}
		}

		if (enableWebSearch) {
			const userMessages = messagesCopy.filter(m => m.role === 'user');
			const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
			if (lastUserMessage) {
				const searchResults = await this.webSearch(lastUserMessage);
				const systemMessage = messagesCopy.find(m => m.role === 'system');
				if (searchResults.length > 0) {
					context.webSearchResults = searchResults;
					if (systemMessage) {
						systemMessage.content = `${systemMessage.content}\n\n---\n${this.formatWebSearchAppendix(context.webSearchResults)}`;
					}
				} else if (systemMessage) {
					// HGT-022：非流式路径也要把「0 条」写进 system，避免模型静默编造来源
					systemMessage.content = `${systemMessage.content}\n\n[系统提示·HGT-022] 本轮联网搜索返回 0 条结果。请在答复中明确说明，并建议用户检查密钥/网络；可基于已有知识回答但须标注不确定性。若用户消息中含具体 http(s) 链接，应优先调用 browse_url 抓取正文；或稍后再试联网。`;
				}
			}
		}

		const requestBody: Record<string, unknown> = {
			model,
			messages: messagesCopy,
			temperature: options?.temperature ?? 0.7,
			max_tokens: options?.maxTokens ?? 32768,
			stream: false,
		};

		if (enableThinking) {
			requestBody.thinking = { type: 'enabled', budget_tokens: 4096 };
		}

		const tools: GLMToolDefinition[] = options?.tools || [];
		if (enableWebSearch && !context.webSearchResults?.length) {
			tools.push({
				type: 'web_search',
				web_search: {
					enable: true,
					search_engine: this.getSearchEngine(),
					search_result: true
				}
			});
		}
		if (tools.length > 0) {
			requestBody.tools = tools;
			requestBody.tool_choice = 'auto';
		}

		const release = await this.acquireRequestSlot('completeChatTurn');
		try {
			if (token?.isCancellationRequested) {
				throw new Error('Cancelled');
			}
			const response = await fetch(this.API_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				body: JSON.stringify(requestBody)
			});
			if (!response.ok) {
				const errData = await response.json().catch(() => ({}));
				const msg = (errData as { error?: { message?: string } }).error?.message || response.statusText;
				throw new Error(`API Error: ${response.status} - ${msg}`);
			}
			const data = await response.json() as {
				choices?: Array<{ message?: { role?: string; content?: string | null; tool_calls?: GLMToolCall[] } }>;
			};
			const msg = data.choices?.[0]?.message;
			if (!msg) {
				throw new Error('Empty completion response');
			}
			return {
				role: msg.role || 'assistant',
				content: msg.content ?? undefined,
				tool_calls: msg.tool_calls,
			};
		} finally {
			release();
		}
		} finally {
			this.harnessTraceService.endTrace();
		}
	}

	async *streamChat(
		messages: GLMMessage[],
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken
	): AsyncIterable<GLMStreamEvent> {
		const apiKey = this.getApiKey();
		const model = options?.model || this.getModel();
		const sessionId = options?.sessionId || this._currentSessionId;

		/** HGT-002：与 completeChatTurn 一致，流式路径也可 grep `[trace=…]` 串联 Agent 工具与上游日志 */
		const traceId = this.harnessTraceService.beginTrace(`glm:streamChat:${sessionId ?? 'na'}`);
		try {

		// 重要：创建消息的深拷贝，避免修改原始会话历史
		const messagesCopy = messages.map(m => ({ ...m }));

		// 检查是否启用深度思考和联网搜索
		const enableThinking = options?.enableThinking ?? this.isThinkingEnabled();
		const enableWebSearch = options?.enableWebSearch ?? this.isWebSearchEnabled();

		this.logService.info(`[trace=${traceId}] [GLMChatService] streamChat: thinking=${enableThinking}, webSearch=${enableWebSearch}, messages=${messagesCopy.length}`);

		const ctxWarn = this.configurationService.getValue<number>('aiCore.contextEstimatedCharsWarn') ?? 0;
		const keepToolRounds = this.configurationService.getValue<number>('aiCore.contextKeepStaleToolRounds') ?? 0;
		if (ctxWarn > 0) {
			let est = JSON.stringify(messagesCopy).length;
			if (keepToolRounds > 0 && est > ctxWarn) {
				const next = compactStaleToolMessagesForHgt012(messagesCopy, keepToolRounds);
				messagesCopy.length = 0;
				messagesCopy.push(...next);
				est = JSON.stringify(messagesCopy).length;
				this.logService.info(`[GLMChatService] HGT-012: compacted stale tool messages (stream), est=${est}`);
			}
			if (est > ctxWarn) {
				this.logService.warn(`[GLMChatService] HGT-012: 估计上下文 ${est} 字符 > 阈值 ${ctxWarn}`);
				yield { type: 'thinking', content: `⚠️ 上下文体积较大（约 ${est} 字符，阈值 ${ctxWarn}）。建议摘要历史、清理陈旧工具结果或新开会话。` };
			}
		}

		// 如果启用联网搜索，先执行搜索
		if (enableWebSearch) {
			// 从用户消息中提取搜索关键词（使用最后一条用户消息）
			const userMessages = messagesCopy.filter(m => m.role === 'user');
			const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
			if (lastUserMessage) {
				yield { type: 'thinking', content: '🔍 正在联网搜索相关资料...' };

				const searchResults = await this.webSearch(lastUserMessage);
				if (searchResults.length > 0) {
					context.webSearchResults = searchResults;
					yield {
						type: 'web_search',
						content: `找到 ${searchResults.length} 条相关结果`,
						webSearchResults: searchResults
					};

					// 必须把检索结果并入 system，但绝不能覆盖 Sentinel / Agent 专用 system（否则会丢失 ### FILE 等硬性格式）
					const systemMessage = messagesCopy.find(m => m.role === 'system');
					if (systemMessage) {
						systemMessage.content = `${systemMessage.content}\n\n---\n${this.formatWebSearchAppendix(context.webSearchResults)}`;
					}
				} else {
					yield {
						type: 'thinking',
						content: '⚠️ 联网搜索未返回条目（HGT-022）：请检查网络/密钥，或改用 browse_url / 关闭联网后重试。',
					};
					const systemMessage = messagesCopy.find(m => m.role === 'system');
					if (systemMessage) {
						systemMessage.content = `${systemMessage.content}\n\n[HGT-022] 联网 0 条：若用户消息含 http(s) 链接，可调用 browse_url 抓取正文。`;
					}
				}
			}
		}

		// 构建请求体（使用副本，保护原始会话历史）
		const requestBody: Record<string, unknown> = {
			model,
			messages: messagesCopy,
			temperature: options?.temperature ?? 0.7,
			max_tokens: options?.maxTokens ?? 32768, // GLM-5.x 支持大上下文，提高默认输出上限
			stream: true
		};

		// 添加深度思考模式
		// 参考: https://docs.bigmodel.cn/cn/guide/capabilities/thinking
		if (enableThinking) {
			requestBody.thinking = {
				type: 'enabled',
				budget_tokens: 4096  // 思考 token 预算
			};
		}

		// 添加工具定义（如果有）
		const tools: GLMToolDefinition[] = options?.tools || [];

		// 如果启用联网搜索，添加 web_search 工具
		if (enableWebSearch && !context.webSearchResults?.length) {
			tools.push({
				type: 'web_search',
				web_search: {
					enable: true,
					search_engine: this.getSearchEngine(),
					search_result: true
				}
			});
		}

		if (tools.length > 0) {
			requestBody.tools = tools;
			requestBody.tool_choice = 'auto';
		}

		this.logService.trace(`[GLMChatService] Sending request to ${this.API_ENDPOINT}`);
		this.logService.trace(`[GLMChatService] Request body: ${JSON.stringify(requestBody).slice(0, 500)}...`);

		try {
			const release = await this.acquireRequestSlot('streamChat');
			try {
				const response = await fetch(this.API_ENDPOINT, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${apiKey}`
					},
					body: JSON.stringify(requestBody)
				});

				if (!response.ok) {
					const errorData = await response.json().catch(() => ({}));
					const errorMessage = errorData.error?.message || response.statusText;
					yield { type: 'error', error: `API Error: ${response.status} - ${errorMessage}` };
					return;
				}

				const reader = response.body?.getReader();
				if (!reader) {
					yield { type: 'error', error: 'No response body' };
					return;
				}

				const decoder = new TextDecoder();
				let buffer = '';
				let isInThinkingBlock = false;

				while (true) {
					if (token?.isCancellationRequested) {
						reader.cancel();
						break;
					}

					const { done, value } = await reader.read();
					if (done) {
						break;
					}

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (!line.startsWith('data: ')) {
							continue;
						}

						const data = line.slice(6).trim();
						if (data === '[DONE]') {
							yield { type: 'done' };
							continue;
						}

						try {
							const parsed = JSON.parse(data);
							const choice = parsed.choices?.[0];

							// 提取并更新缓存统计（上下文缓存功能）
							if (parsed.usage && sessionId) {
								this.updateCacheStats(sessionId, parsed.usage);
							}

							if (!choice) {
								continue;
							}

							const delta = choice.delta;

							// 处理思考内容（深度思考模式）
							if (delta?.reasoning_content) {
								if (!isInThinkingBlock) {
									isInThinkingBlock = true;
									yield { type: 'thinking', content: '💭 思考中...\n' };
								}
								yield { type: 'thinking', content: delta.reasoning_content };
							}

							// 处理工具调用
							if (delta?.tool_calls) {
								for (const toolCall of delta.tool_calls) {
									// 检查是否是 web_search 工具
									if (toolCall.type === 'web_browser') {
										yield {
											type: 'web_search',
											content: '🔍 正在搜索网络...'
										};
									} else {
										yield {
											type: 'tool_call',
											toolCall: {
												id: toolCall.id || '',
												type: 'function',
												function: {
													name: toolCall.function?.name || '',
													arguments: toolCall.function?.arguments || ''
												}
											}
										};
									}
								}
							}

							// 处理内容输出
							if (delta?.content) {
								if (isInThinkingBlock) {
									isInThinkingBlock = false;
									yield { type: 'content', content: '\n\n---\n\n' };
								}
								yield { type: 'content', content: delta.content };
							}

							// 检测是否因 token 限制而中断
							const finishReason = choice.finish_reason;
							if (finishReason === 'length') {
								this.logService.warn('[GLMChatService] Response truncated due to token limit, signaling continuation needed');
								yield { type: 'truncated', reason: 'length' };
							}

						} catch {
							// 忽略解析错误
						}
					}
				}
			} finally {
				release();
			}

		} catch (error) {
			if (token?.isCancellationRequested) {
				return;
			}
			yield { type: 'error', error: String(error) };
		}
		} finally {
			this.harnessTraceService.endTrace();
			this.logService.info(`[trace=${traceId}] [GLMChatService] streamChat end`);
		}
	}

	/**
	 * 支持自动续接的流式聊天
	 * 当响应因 token 限制截断时，自动发起续接请求
	 */
	async *streamChatWithContinuation(
		messages: GLMMessage[],
		context: GLMChatContext,
		options?: GLMChatOptions,
		token?: CancellationToken,
		maxContinuations: number = 3
	): AsyncGenerator<GLMStreamEvent> {
		let continuationCount = 0;
		let currentMessages = [...messages];
		let accumulatedContent = '';

		while (continuationCount <= maxContinuations) {
			let needsContinuation = false;

			for await (const event of this.streamChat(currentMessages, context, options, token)) {
				if (event.type === 'content') {
					accumulatedContent += event.content;
				}

				if (event.type === 'truncated') {
					needsContinuation = true;
					this.logService.info(`[GLMChatService] Continuation ${continuationCount + 1}/${maxContinuations}`);
					continue;
				}

				yield event;
			}

			if (!needsContinuation) {
				break;
			}

			// 准备续接请求
			continuationCount++;
			if (continuationCount > maxContinuations) {
				yield { type: 'thinking', content: '\n\n⚠️ 回复过长，已达到续接上限。' };
				break;
			}

			// 添加已生成的内容作为 assistant 消息，然后请求继续
			currentMessages = [
				...currentMessages,
				{ role: 'assistant', content: accumulatedContent },
				{ role: 'user', content: '请继续你的回答。' }
			];

			// 使用 thinking，避免污染需要拼接的正文（如 Sentinel ### FILE 物化）
			yield { type: 'thinking', content: '*[继续生成中...]*\n' };
		}
	}
}

registerSingleton(IGLMChatService, GLMChatService, InstantiationType.Delayed);
