/*---------------------------------------------------------------------------------------------
 *  AI Core Subagent Orchestrator Service
 *  提供项目级子代理定义加载、自动委派、显式调用与会话恢复能力
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { GLMChatContext, GLMMessage, IGLMChatService } from './glmChatService.js';

export const ISubagentOrchestratorService = createDecorator<ISubagentOrchestratorService>('ISubagentOrchestratorService');

export type RoutedSubagentKey = 'quick_responder' | 'implementation_agent' | 'planning_agent';

export interface SubagentDefinition {
	name: string;
	description: string;
	model: string;
	readonly: boolean;
	isBackground: boolean;
	prompt: string;
	path?: string;
}

export interface SubagentRunResult {
	agentId: string;
	agentName: string;
	sessionId: string;
	content: string;
}

interface SubagentRunState {
	agentId: string;
	agentName: string;
	messages: GLMMessage[];
	lastUsedAt: Date;
}

export type SubagentUserCommand =
	| { kind: 'invoke'; name: string; task: string }
	| { kind: 'resume'; agentId: string; task: string };

export interface ISubagentOrchestratorService {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	ensureDefaultSubagents(): Promise<void>;
	parseUserCommand(userMessage: string): SubagentUserCommand | undefined;
	runExplicitSubagent(command: SubagentUserCommand, context: GLMChatContext): Promise<SubagentRunResult>;
	runRoutedSubagent(route: RoutedSubagentKey, task: string, context: GLMChatContext, options?: {
		model?: string;
		enableThinking?: boolean;
		enableWebSearch?: boolean;
		maxTokens?: number;
	}): Promise<SubagentRunResult>;
}

export class SubagentOrchestratorService extends Disposable implements ISubagentOrchestratorService {
	readonly _serviceBrand: undefined;

	private readonly _runs = new Map<string, SubagentRunState>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IGLMChatService private readonly glmChatService: IGLMChatService
	) {
		super();
	}

	isEnabled(): boolean {
		return this.configurationService.getValue<boolean>('aiCore.enableSubagents') !== false;
	}

	parseUserCommand(userMessage: string): SubagentUserCommand | undefined {
		const message = userMessage.trim();
		if (!message) {
			return undefined;
		}

		const slashResume = message.match(/^\/resume\s+([a-zA-Z0-9_-]+)\s*(.*)$/i);
		if (slashResume) {
			return {
				kind: 'resume',
				agentId: slashResume[1],
				task: (slashResume[2] || '').trim()
			};
		}

		const textResume = message.match(/^resume agent\s+([a-zA-Z0-9_-]+)\s*(.*)$/i);
		if (textResume) {
			return {
				kind: 'resume',
				agentId: textResume[1],
				task: (textResume[2] || '').trim()
			};
		}

		const slashInvoke = message.match(/^\/([a-z0-9-]+)\s*(.*)$/i);
		if (slashInvoke) {
			return {
				kind: 'invoke',
				name: slashInvoke[1].toLowerCase(),
				task: (slashInvoke[2] || '').trim()
			};
		}

		return undefined;
	}

	async ensureDefaultSubagents(): Promise<void> {
		const root = await this.pickAgentsRoot();
		await this.fileService.createFolder(root);

		const existing = await this.loadSubagents();
		if (existing.length > 0) {
			return;
		}

		const defaults = this.defaultSubagentFiles();
		for (const def of defaults) {
			await this.fileService.writeFile(
				URI.joinPath(root, def.fileName),
				VSBuffer.fromString(def.content)
			);
		}
		this.logService.info(`[SubagentOrchestrator] Bootstrapped ${defaults.length} default subagents at ${root.fsPath}`);
	}

	async runExplicitSubagent(command: SubagentUserCommand, context: GLMChatContext): Promise<SubagentRunResult> {
		await this.ensureDefaultSubagents();

		if (command.kind === 'resume') {
			const run = this._runs.get(command.agentId);
			if (!run) {
				throw new Error(`Unknown agent id: ${command.agentId}`);
			}
			const followup = command.task || '请继续上一次任务并输出当前结论与下一步建议。';
			return this.executeSubagent(run.agentName, followup, context, { existingRun: run });
		}

		const task = command.task || '请执行该子代理的默认职责，并给出结构化结果。';
		return this.executeSubagent(command.name, task, context);
	}

	async runRoutedSubagent(route: RoutedSubagentKey, task: string, context: GLMChatContext, options?: {
		model?: string;
		enableThinking?: boolean;
		enableWebSearch?: boolean;
		maxTokens?: number;
	}): Promise<SubagentRunResult> {
		await this.ensureDefaultSubagents();

		const mappedName = this.mapRouteToSubagentName(route);
		return this.executeSubagent(mappedName, task, context, { options });
	}

	private async executeSubagent(
		agentName: string,
		task: string,
		context: GLMChatContext,
		extra?: {
			existingRun?: SubagentRunState;
			options?: {
				model?: string;
				enableThinking?: boolean;
				enableWebSearch?: boolean;
				maxTokens?: number;
			};
		}
	): Promise<SubagentRunResult> {
		const defs = await this.loadSubagents();
		const def = defs.find(d => d.name === agentName);
		if (!def) {
			throw new Error(`Subagent not found: ${agentName}`);
		}

		const run = extra?.existingRun ?? this.createRunState(def.name);
		if (!extra?.existingRun) {
			const systemPrompt = this.buildSubagentSystemPrompt(def);
			run.messages = [{ role: 'system', content: systemPrompt }];
		}
		run.messages.push({ role: 'user', content: task });

		let content = '';
		const stream = this.glmChatService.streamChatWithContinuation(run.messages, context, {
			model: extra?.options?.model || (def.model !== 'inherit' ? def.model : undefined),
			enableThinking: extra?.options?.enableThinking !== undefined ? extra.options.enableThinking : true,
			enableWebSearch: extra?.options?.enableWebSearch !== undefined ? extra.options.enableWebSearch : true,
			maxTokens: extra?.options?.maxTokens || 16384
		}, undefined);

		for await (const event of stream) {
			if (event.type === 'content' && event.content) {
				content += event.content;
			}
		}

		run.lastUsedAt = new Date();
		run.messages.push({ role: 'assistant', content });
		this._runs.set(run.agentId, run);

		return {
			agentId: run.agentId,
			agentName: def.name,
			sessionId: run.agentId,
			content: content || '（子代理已执行，但未返回可见文本内容）'
		};
	}

	private createRunState(agentName: string): SubagentRunState {
		const suffix = Math.random().toString(36).slice(2, 8);
		return {
			agentId: `sa_${Date.now()}_${suffix}`,
			agentName,
			messages: [],
			lastUsedAt: new Date()
		};
	}

	private buildSubagentSystemPrompt(def: SubagentDefinition): string {
		return [
			'你是一个被主代理委派的子代理。',
			`子代理名称: ${def.name}`,
			`职责描述: ${def.description}`,
			'请严格按该子代理职责执行，并返回结构化、可直接复用的结果。',
			def.readonly ? '该子代理为只读模式：禁止给出写入文件与执行破坏性命令。' : '该子代理可进行实现建议，但优先最小改动。',
			'',
			def.prompt
		].join('\n');
	}

	private async loadSubagents(): Promise<SubagentDefinition[]> {
		const root = await this.pickAgentsRoot();
		let rootStat;
		try {
			rootStat = await this.fileService.resolve(root);
		} catch {
			return [];
		}

		const defs: SubagentDefinition[] = [];
		for (const child of rootStat.children || []) {
			if (child.isDirectory || !child.name.toLowerCase().endsWith('.md')) {
				continue;
			}
			try {
				const raw = (await this.fileService.readFile(child.resource)).value.toString();
				const parsed = this.parseAgentMarkdown(raw);
				if (parsed) {
					parsed.path = child.resource.fsPath;
					defs.push(parsed);
				}
			} catch (error) {
				this.logService.warn(`[SubagentOrchestrator] Failed loading subagent ${child.name}: ${String(error)}`);
			}
		}

		return defs;
	}

	private parseAgentMarkdown(content: string): SubagentDefinition | undefined {
		const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
		if (!match) {
			return undefined;
		}

		const frontmatter = match[1];
		const body = match[2].trim();
		const map = new Map<string, string>();
		for (const line of frontmatter.split('\n')) {
			const idx = line.indexOf(':');
			if (idx <= 0) {
				continue;
			}
			const key = line.slice(0, idx).trim().toLowerCase();
			const value = line.slice(idx + 1).trim();
			map.set(key, value);
		}

		const name = (map.get('name') || '').toLowerCase();
		if (!name) {
			return undefined;
		}

		return {
			name,
			description: map.get('description') || '未提供描述',
			model: map.get('model') || 'inherit',
			readonly: (map.get('readonly') || '').toLowerCase() === 'true',
			isBackground: (map.get('is_background') || '').toLowerCase() === 'true',
			prompt: body
		};
	}

	private mapRouteToSubagentName(route: RoutedSubagentKey): string {
		switch (route) {
			case 'planning_agent':
				return 'planning-agent';
			case 'implementation_agent':
				return 'implementation-agent';
			default:
				return 'quick-responder';
		}
	}

	private async pickAgentsRoot(): Promise<URI> {
		const workspace = this.workspaceService.getWorkspace();
		if (workspace.folders.length === 0) {
			throw new Error('No workspace folder available for subagents');
		}

		const root = workspace.folders[0].uri;
		const neutralRoot = URI.joinPath(root, '.agents', 'agents');
		const cursorRoot = URI.joinPath(root, '.cursor', 'agents');

		try {
			await this.fileService.resolve(neutralRoot);
			return neutralRoot;
		} catch {
			// continue
		}

		try {
			await this.fileService.resolve(cursorRoot);
			return cursorRoot;
		} catch {
			// continue
		}

		return neutralRoot;
	}

	private defaultSubagentFiles(): Array<{ fileName: string; content: string }> {
		return [
			{
				fileName: 'quick-responder.md',
				content: `---
name: quick-responder
description: 快速响应子代理。用于简单问答、短任务和低复杂度请求。use proactively
model: inherit
readonly: true
is_background: false
---

你是 quick-responder 子代理。
目标：快速、准确、简洁地完成简单任务。

执行规则：
1. 优先给出直接答案，避免过度展开。
2. 若信息不足，先列出最小必要假设，再回答。
3. 返回结构：结论 -> 关键依据 -> 下一步建议。
`
			},
			{
				fileName: 'implementation-agent.md',
				content: `---
name: implementation-agent
description: 实现子代理。用于代码实现、重构、修复和工程化改动。use proactively
model: inherit
readonly: false
is_background: false
---

你是 implementation-agent 子代理。
目标：在保证质量的前提下完成实现任务。

执行规则：
1. 先给出变更方案和影响面。
2. 优先最小改动，保持兼容性。
3. 输出包含：实施步骤、关键改动、验证建议、潜在风险。
`
			},
			{
				fileName: 'planning-agent.md',
				content: `---
name: planning-agent
description: 规划子代理。用于复杂需求分析、架构决策、任务拆解与里程碑设计。use proactively
model: inherit
readonly: true
is_background: false
---

你是 planning-agent 子代理。
目标：产出可执行的高质量方案。

执行规则：
1. 先定义目标、约束、验收标准。
2. 提供 2-3 个方案并给出 trade-off。
3. 输出分阶段计划、风险清单与回滚策略。
`
			}
		];
	}
}

registerSingleton(ISubagentOrchestratorService, SubagentOrchestratorService, InstantiationType.Delayed);

