/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../base/common/actions.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../common/tools/languageModelToolsService.js';
import { IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatEntitlement, ChatEntitlementContext, ChatEntitlementRequests, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatModel, ChatRequestModel, IChatRequestModel, IChatRequestVariableData } from '../../common/model/chatModel.js';
import { ChatMode } from '../../common/chatModes.js';
import { ChatRequestAgentPart, ChatRequestToolPart } from '../../common/requestParser/chatParserTypes.js';
import { IChatProgress, IChatService } from '../../common/chatService/chatService.js';
import { IChatRequestToolEntry } from '../../common/attachments/chatVariableEntries.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { CHAT_OPEN_ACTION_ID, CHAT_SETUP_ACTION_ID } from '../actions/chatActions.js';
import { IChatWidgetService } from '../chat.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CodeAction, CodeActionList, Command, NewSymbolName, NewSymbolNameTriggerKind } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ISelection, Selection } from '../../../../../editor/common/core/selection.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { CodeActionKind } from '../../../../../editor/contrib/codeAction/common/types.js';
import { ACTION_START as INLINE_CHAT_START } from '../../../inlineChat/common/inlineChat.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ChatSetupController } from './chatSetupController.js';
import { ChatSetupAnonymous, ChatSetupStep, IChatSetupResult } from './chatSetup.js';
import { ChatSetup } from './chatSetupRunner.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IWorkbenchIssueService } from '../../../issue/common/issue.js';
import { IAgentToolService } from '../../../../services/aiCore/browser/agentToolService.js';
import { IGLMChatService, GLMMessage, GLMChatContext, GLMTaskRoutingPlan } from '../../../../services/aiCore/browser/glmChatService.js';
import { ChatResponseHandler, ChatContextCollector } from '../../../../services/aiCore/browser/chatResponseHandler.js';
import { ISpecModeService } from '../../../../services/aiCore/browser/specModeService.js';
import { IChatModeService } from '../../../../services/aiCore/browser/chatModeService.js';
import { ISubagentOrchestratorService } from '../../../../services/aiCore/browser/subagentOrchestratorService.js';
import { SpecSession, SpecTask } from '../../../../services/aiCore/common/chatModeTypes.js';
import { IContextProvidersService } from '../../../../services/aiCore/browser/contextProvidersService.js';

// ============================================================================
// P0.1 - 增强 JSON 解析容错
// ============================================================================

/**
 * 安全解析 JSON，支持从 LLM 响应中提取和修复 JSON
 * @param text LLM 返回的文本
 * @returns 解析后的对象，解析失败返回 null
 */
function safeParseJSON<T = unknown>(text: string): T | null {
	if (!text || typeof text !== 'string') {
		return null;
	}

	// 1. 尝试直接解析
	try {
		return JSON.parse(text) as T;
	} catch {
		// 继续尝试其他方法
	}

	// 2. 尝试提取 JSON 对象
	const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
	if (jsonObjectMatch) {
		try {
			return JSON.parse(jsonObjectMatch[0]) as T;
		} catch {
			// 继续尝试修复
		}
	}

	// 3. 尝试提取 JSON 数组
	const jsonArrayMatch = text.match(/\[[\s\S]*\]/);
	if (jsonArrayMatch) {
		try {
			return JSON.parse(jsonArrayMatch[0]) as T;
		} catch {
			// 继续尝试修复
		}
	}

	// 4. 尝试修复常见的 JSON 格式问题
	let fixedText = text;

	// 提取可能的 JSON 部分
	const extracted = jsonObjectMatch?.[0] || jsonArrayMatch?.[0] || text;

	// 修复尾部逗号
	fixedText = extracted.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

	// 修复单引号改双引号
	fixedText = fixedText.replace(/'/g, '"');

	// 修复未转义的换行符
	fixedText = fixedText.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

	// 修复键名没有引号的情况 (简单情况)
	fixedText = fixedText.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

	try {
		return JSON.parse(fixedText) as T;
	} catch {
		// 继续尝试
	}

	// 5. 最后尝试：从 markdown 代码块中提取
	const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		try {
			return JSON.parse(codeBlockMatch[1].trim()) as T;
		} catch {
			// 放弃
		}
	}

	return null;
}

// ============================================================================
// P0.2 - 任务失败自动重试机制
// ============================================================================

interface RetryOptions {
	maxRetries?: number;        // 最大重试次数，默认 3
	baseDelayMs?: number;       // 基础延迟毫秒，默认 1000
	onRetry?: (attempt: number, error: Error) => void;  // 重试回调
}

/**
 * 带有指数退避的重试机制
 * @param fn 要执行的异步函数
 * @param options 重试选项
 * @returns Promise 执行结果
 */
async function executeWithRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const { maxRetries = 3, baseDelayMs = 1000, onRetry } = options;

	let lastError: Error = new Error('Unknown error');

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt < maxRetries) {
				// 计算指数退避延迟: 1s, 2s, 4s
				const delayMs = baseDelayMs * Math.pow(2, attempt);

				// 触发重试回调
				if (onRetry) {
					onRetry(attempt + 1, lastError);
				}

				// 等待后重试
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
		}
	}

	throw lastError;
}

// ============================================================================
// P0.3 - 友好化错误信息映射
// ============================================================================

const ERROR_MESSAGE_MAP: Record<string, string> = {
	'SyntaxError': '数据格式解析失败，正在重试...',
	'JSON': '响应格式异常，正在重试...',
	'network': '网络连接失败，请检查网络设置',
	'Failed to fetch': '无法连接到服务器，请检查网络',
	'timeout': '请求超时，正在重试...',
	'abort': '请求被取消',
	'401': '认证失败，请检查 API 密钥',
	'403': '访问被拒绝，请检查权限',
	'429': '请求过于频繁，请稍后重试',
	'500': '服务器内部错误，请稍后重试',
	'502': '网关错误，请稍后重试',
	'503': '服务暂时不可用，请稍后重试'
};

/**
 * 将技术错误转换为用户友好的错误信息
 * @param error 原始错误
 * @returns 用户友好的错误信息
 */
function toFriendlyErrorMessage(error: unknown): string {
	const errorStr = String(error);

	// 遍历错误映射表查找匹配
	for (const [key, friendlyMessage] of Object.entries(ERROR_MESSAGE_MAP)) {
		if (errorStr.includes(key)) {
			return friendlyMessage;
		}
	}

	// 默认友好消息
	return '任务执行遇到问题，正在重试...';
}

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, apple: { id: '', name: '' }, google: { id: '', name: '' } },
	outputChannelId: product.defaultChatAgent?.chatExtensionOutputId ?? '',
};

const ToolsAgentContextKey = ContextKeyExpr.and(
	ContextKeyExpr.equals(`config.${ChatConfiguration.AgentEnabled}`, true),
	ContextKeyExpr.not(`previewFeaturesDisabled`) // Set by extension
);

export class SetupAgent extends Disposable implements IChatAgentImplementation {

	static registerDefaultAgents(instantiationService: IInstantiationService, location: ChatAgentLocation, mode: ChatModeKind | undefined, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			let id: string;
			let description = ChatMode.Ask.description.get();
			switch (location) {
				case ChatAgentLocation.Chat:
					if (mode === ChatModeKind.Ask) {
						id = 'setup.chat';
					} else if (mode === ChatModeKind.Edit) {
						id = 'setup.edits';
						description = ChatMode.Edit.description.get();
					} else {
						id = 'setup.agent';
						description = ChatMode.Agent.description.get();
					}
					break;
				case ChatAgentLocation.Terminal:
					id = 'setup.terminal';
					break;
				case ChatAgentLocation.EditorInline:
					id = 'setup.editor';
					break;
				case ChatAgentLocation.Notebook:
					id = 'setup.notebook';
					break;
			}

			return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, `${defaultChat.provider.default.name} Copilot` /* Do NOT change, this hides the username altogether in Chat */, true, description, location, mode, context, controller);
		});
	}

	static registerBuiltInAgents(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			const disposables = new DisposableStore();

			// Register VSCode agent
			const { disposable: vscodeDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.vscode', 'vscode', false, localize2('vscodeAgentDescription', "Ask questions about VS Code").value, ChatAgentLocation.Chat, undefined, context, controller);
			disposables.add(vscodeDisposable);

			// Register workspace agent
			const { disposable: workspaceDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.workspace', 'workspace', false, localize2('workspaceAgentDescription', "Ask about your workspace").value, ChatAgentLocation.Chat, undefined, context, controller);
			disposables.add(workspaceDisposable);

			// Register terminal agent
			const { disposable: terminalDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.terminal.agent', 'terminal', false, localize2('terminalAgentDescription', "Ask how to do something in the terminal").value, ChatAgentLocation.Chat, undefined, context, controller);
			disposables.add(terminalDisposable);

			// Register tools
			disposables.add(SetupTool.registerTool(instantiationService, {
				id: 'setup_tools_createNewWorkspace',
				source: ToolDataSource.Internal,
				icon: Codicon.newFolder,
				displayName: localize('setupToolDisplayName', "New Workspace"),
				modelDescription: 'Scaffold a new workspace in VS Code',
				userDescription: localize('setupToolsDescription', "Scaffold a new workspace in VS Code"),
				canBeReferencedInPrompt: true,
				toolReferenceName: 'new',
				when: ContextKeyExpr.true(),
			}));

			return disposables;
		});
	}

	private static doRegisterAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService, id: string, name: string, isDefault: boolean, description: string, location: ChatAgentLocation, mode: ChatModeKind | undefined, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		const disposables = new DisposableStore();
		disposables.add(chatAgentService.registerAgent(id, {
			id,
			name,
			isDefault,
			isCore: true,
			modes: mode ? [mode] : [ChatModeKind.Ask],
			when: mode === ChatModeKind.Agent ? ToolsAgentContextKey?.serialize() : undefined,
			slashCommands: [],
			disambiguation: [],
			locations: [location],
			metadata: { helpTextPrefix: SetupAgent.SETUP_NEEDED_MESSAGE },
			description,
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher
		}));

		const agent = disposables.add(instantiationService.createInstance(SetupAgent, context, controller, location));
		disposables.add(chatAgentService.registerAgentImplementation(id, agent));
		if (mode === ChatModeKind.Agent) {
			chatAgentService.updateAgent(id, { themeIcon: Codicon.tools });
		}

		return { agent, disposable: disposables };
	}

	private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpCopilotNeeded', "You need to set up GitHub Copilot and be signed in to use Chat."));
	private static readonly TRUST_NEEDED_MESSAGE = new MarkdownString(localize('trustNeeded', "You need to trust this workspace to use Chat."));

	private static CHAT_REPORT_ISSUE_WITH_OUTPUT_ID = 'workbench.action.chat.reportIssueWithOutput';

	private readonly _onUnresolvableError = this._register(new Emitter<void>());
	readonly onUnresolvableError = this._onUnresolvableError.event;

	private readonly pendingForwardedRequests = new ResourceMap<Promise<void>>();
	private readonly autopilotFuseState = new Map<string, {
		nudgeCount: number;
		lastPending: number;
		lastCompleted: number;
	}>();

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		private readonly location: ChatAgentLocation,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		super();

		this.registerCommands();
	}

	private registerCommands(): void {
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_REPORT_ISSUE_WITH_OUTPUT_ID, async accessor => {
			const outputService = accessor.get(IOutputService);
			const textModelService = accessor.get(ITextModelService);
			const issueService = accessor.get(IWorkbenchIssueService);
			const logService = accessor.get(ILogService);

			let outputData = '';
			let channelName = '';

			let channel = outputService.getChannel(defaultChat.outputChannelId);
			if (channel) {
				channelName = defaultChat.outputChannelId;
			} else {
				logService.warn(`[chat setup] Output channel '${defaultChat.outputChannelId}' not found, falling back to Window output channel`);
				channel = outputService.getChannel('rendererLog');
				channelName = 'Window';
			}

			if (channel) {
				try {
					const model = await textModelService.createModelReference(channel.uri);
					try {
						const rawOutput = model.object.textEditorModel.getValue();
						outputData = `<details>\n<summary>GitHub Copilot Chat Output (${channelName})</summary>\n\n\`\`\`\n${rawOutput}\n\`\`\`\n</details>`;
						logService.info(`[chat setup] Retrieved ${rawOutput.length} characters from ${channelName} output channel`);
					} finally {
						model.dispose();
					}
				} catch (error) {
					logService.error(`[chat setup] Failed to retrieve output channel content: ${error}`);
				}
			} else {
				logService.warn(`[chat setup] No output channel available`);
			}

			await issueService.openReporter({
				extensionId: defaultChat.chatExtensionId,
				issueTitle: 'Chat took too long to get ready',
				issueBody: 'Chat took too long to get ready',
				data: outputData || localize('chatOutputChannelUnavailable', "GitHub Copilot Chat output channel not available. Please ensure the GitHub Copilot Chat extension is active and try again. If the issue persists, you can manually include relevant information from the Output panel (View > Output > GitHub Copilot Chat).")
			});
		}));
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void): Promise<IChatAgentResult> {
		return this.instantiationService.invokeFunction(async accessor /* using accessor for lazy loading */ => {
			const chatService = accessor.get(IChatService);
			const languageModelsService = accessor.get(ILanguageModelsService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const chatAgentService = accessor.get(IChatAgentService);
			const languageModelToolsService = accessor.get(ILanguageModelToolsService);

			return this.doInvoke(request, part => progress([part]), chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
		});
	}

	private async doInvoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		// [AI Core] 使用自定义 GLM 模型时，直接处理请求，不走 GitHub Copilot
		if (this.configurationService.getValue<boolean>('aiCore.useGLM') === true) {
			return this.doInvokeWithGLM(request, progress, chatWidgetService);
		}

		if (
			!this.context.state.installed ||									// Extension not installed: run setup to install
			this.context.state.disabled ||										// Extension disabled: run setup to enable
			this.context.state.untrusted ||										// Workspace untrusted: run setup to ask for trust
			this.context.state.entitlement === ChatEntitlement.Available ||		// Entitlement available: run setup to sign up
			(
				this.context.state.entitlement === ChatEntitlement.Unknown &&	// Entitlement unknown: run setup to sign in / sign up
				!this.chatEntitlementService.anonymous							// unless anonymous access is enabled
			)
		) {
			return this.doInvokeWithSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
		}

		return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
	}

	/**
	 * [AI Core] 使用 GLM-4.7 模型处理 Chat 请求
	 * 使用模块化的 GLMChatService 和 ChatResponseHandler
	 */
	private async doInvokeWithGLM(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatWidgetService: IChatWidgetService): Promise<IChatAgentResult> {
		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const chatSessionKey = request.sessionResource.toString();
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);
		if (!requestModel) {
			this.logService.error('[AI Core GLM] Request model not found');
			return {};
		}

		const userMessage = requestModel.message.text;

		// 自动初始化项目级 Skills（新项目按需求生成；旧项目无 skills 时深度扫描后生成）
		await this.ensureProjectSkills(userMessage, progress);

		// ============================================================================
		// 模式选择欢迎卡片 (Kiro 风格)
		// ============================================================================
		const lowerMsg = userMessage.toLowerCase().trim();

		// 检测模式选择命令
		if (lowerMsg === 'vibe' || lowerMsg === 'vibe模式' || lowerMsg === 'vibe mode') {
			const chatModeServiceForWelcome = this.instantiationService.invokeFunction(accessor => accessor.get(IChatModeService));
			chatModeServiceForWelcome.setMode('vibe');
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(`# 💬 Vibe 模式已激活\n\n**边聊边做，快速迭代**\n\n现在可以直接开始编码！我会帮助你：\n- 快速探索和测试想法\n- 实现具体的功能\n- 调试和修复问题\n\n> 💡 如需切换到规划模式，输入 "spec" 或 "规格模式"`)
			});
			return {};
		}

		if (lowerMsg === 'spec' || lowerMsg === 'spec模式' || lowerMsg === 'spec mode' || lowerMsg === '规格模式') {
			const chatModeServiceForWelcome = this.instantiationService.invokeFunction(accessor => accessor.get(IChatModeService));
			chatModeServiceForWelcome.setMode('spec');
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(`# 📋 Spec 模式已激活\n\n**先规划，后执行**\n\n请描述你想要构建的功能，我将帮助你：\n\n1. 📝 **需求分析** - 生成结构化用户故事\n2. 🏗️ **技术设计** - 创建架构和序列图\n3. ✅ **任务执行** - 逐步实现并跟踪进度\n\n---\n\n**开始吧！** 请输入你的需求，例如：\n\n> "我想要一个用户登录系统，支持邮箱和手机号登录"\n\n> 💡 如需切换到快速模式，输入 "vibe" 或 "快速模式"`)
			});
			return {};
		}

		// 检测帮助/模式选择请求
		if (lowerMsg === '?' || lowerMsg === 'help' || lowerMsg === '帮助' || lowerMsg === '选择模式' || lowerMsg === 'mode') {
			const specModeServiceForCard = this.instantiationService.invokeFunction(accessor => {
				try {
					return accessor.get(ISpecModeService);
				} catch {
					return undefined;
				}
			});
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(this.getModeSelectionCard(specModeServiceForCard?.getCurrentSession()))
			});
			return {};
		}

		// Kiro 对齐：新会话/启动语义时展示统一入口页（Vibe + Spec 同页）
		if (lowerMsg === '开始' || lowerMsg === 'start' || lowerMsg === 'new session' || lowerMsg === '新会话') {
			const specModeServiceForCard = this.instantiationService.invokeFunction(accessor => {
				try {
					return accessor.get(ISpecModeService);
				} catch {
					return undefined;
				}
			});
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(this.getModeSelectionCard(specModeServiceForCard?.getCurrentSession()))
			});
			return {};
		}
		const isAgentMode = this.configurationService.getValue<boolean>('aiCore.agentMode') !== false;

		// 使用 ChatContextCollector 收集上下文
		// 同时处理 variableData 和 attachedContext
		const variablesWithAttached = {
			variables: [
				...(requestModel.variableData?.variables || []),
				...(requestModel.attachedContext || [])
			]
		};

		const context = await ChatContextCollector.collectFromRequest(
			variablesWithAttached,
			this.textModelService,
			this.logService
		);

		// ========================================================================
		// 解析 # 符号上下文引用 (Kiro 风格 Context Providers)
		// ========================================================================
		const contextProvidersService = this.instantiationService.invokeFunction(accessor => accessor.get(IContextProvidersService));
		const { contexts: hashContexts, cleanMessage } = await contextProvidersService.resolveAllContexts(userMessage);

		// 如果有 # 上下文引用，使用清理后的消息
		let processedMessage = userMessage;
		let additionalContext = '';

		if (hashContexts.length > 0) {
			processedMessage = cleanMessage || userMessage;
			additionalContext = contextProvidersService.formatContextsForLLM(hashContexts);
			this.logService.info(`[AI Core GLM] Resolved ${hashContexts.length} context references: ${hashContexts.map(c => c.type).join(', ')}`);
		}

		this.logService.info(`[AI Core GLM] User message: "${processedMessage.slice(0, 100)}..."`);
		this.logService.info(`[AI Core GLM] Processing request with ${context.files.length} files, ${hashContexts.length} hash contexts, Agent mode: ${isAgentMode}`);

		// 详细日志
		for (const file of context.files) {
			this.logService.info(`[AI Core GLM] File: ${file.path}${file.lineRange ? `:${file.lineRange}` : ''} (${file.content.length} chars)`);
		}

		// 获取服务
		const glmService = this.instantiationService.invokeFunction(accessor => accessor.get(IGLMChatService));
		const agentToolService = this.instantiationService.invokeFunction(accessor => accessor.get(IAgentToolService));
		const chatModeService = this.instantiationService.invokeFunction(accessor => accessor.get(IChatModeService));
		const subagentService = this.instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(ISubagentOrchestratorService);
			} catch {
				return undefined;
			}
		});

		// 获取当前 Chat 模式 (Vibe/Spec)
		const chatMode = this.configurationService.getValue<'vibe' | 'spec'>('aiCore.defaultChatMode') || 'vibe';

		// 创建响应处理器
		const responseHandler = new ChatResponseHandler(
			progress,
			this.logService,
			agentToolService,
			{ enableThinking: true, enableToolCalls: isAgentMode }
		);
		let subagentDelegationContext = '';

		try {
			// 获取深度思考和联网搜索设置（会被 GLM-5 路由器动态覆盖）
			let enableThinking = glmService.isThinkingEnabled();
			let enableWebSearch = glmService.isWebSearchEnabled();
			let selectedModel: string | undefined = undefined;
			let selectedMaxTokens: number | undefined = undefined;

			this.logService.info(`[AI Core GLM] Settings: Thinking=${enableThinking}, WebSearch=${enableWebSearch}, ChatMode=${chatMode}`);

			// 显式子代理调用：/agent-name ... 或 resume agent <id> ...
			if (subagentService?.isEnabled()) {
				await subagentService.ensureDefaultSubagents();
				const cmd = subagentService.parseUserCommand(processedMessage);
				if (cmd) {
					progress({
						kind: 'progressMessage',
						content: new MarkdownString('🤖 正在调用子代理...')
					});
					const subagentResult = await subagentService.runExplicitSubagent(cmd, context);
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(
							`## Subagent: ${subagentResult.agentName}\n\n` +
							`- Agent ID: \`${subagentResult.agentId}\`\n` +
							`- Session: \`${subagentResult.sessionId}\`\n\n` +
							`${subagentResult.content}`
						)
					});
					return {};
				}
			}

			// 每次提问都先用 GLM-5 做任务分析，再自动分配子代理/模型
			const routingPlan = await glmService.analyzeTaskAndRoute(processedMessage, context, chatMode, isAgentMode);
			selectedModel = routingPlan.model;
			selectedMaxTokens = routingPlan.maxTokens;
			enableThinking = routingPlan.enableThinking;
			enableWebSearch = routingPlan.enableWebSearch;
			this.logService.info(
				`[AI Core Router] subAgent=${routingPlan.subAgent}, complexity=${routingPlan.complexity}, model=${routingPlan.model}, thinking=${routingPlan.enableThinking}, webSearch=${routingPlan.enableWebSearch}, maxTokens=${routingPlan.maxTokens}, confidence=${routingPlan.confidence}, reason=${routingPlan.reason}`
			);

			// 反循环强制策略：
			// 当用户明确要求“继续/自动往下执行”且存在未完成 Spec 任务时，
			// 直接进入 Autopilot 任务执行阶段，不再与用户反复拉扯。
			const specModeServiceForForce = this.instantiationService.invokeFunction(accessor => {
				try {
					return accessor.get(ISpecModeService);
				} catch {
					return undefined;
				}
			});
			const executionMode = this.configurationService.getValue<'autopilot' | 'supervised'>('aiCore.executionMode') || 'autopilot';
			if (
				specModeServiceForForce &&
				executionMode === 'autopilot' &&
				(this.shouldForceAutopilotResume(processedMessage) || this.shouldAutopilotImmediateTakeover(processedMessage))
			) {
				const active = specModeServiceForForce.getCurrentSession();
				const pendingTasks = active?.tasks.filter(t => t.status === 'pending' || t.status === 'blocked') || [];
				if (active && pendingTasks.length > 0) {
					const fuse = this.evaluateAutopilotFuse(chatSessionKey, processedMessage, active.tasks);
					const immediateTakeover = this.shouldAutopilotImmediateTakeover(processedMessage);
					const forceStrongModel = this.isStuckOrLoopMessage(processedMessage) || fuse.triggered || immediateTakeover;
					if (!immediateTakeover && !fuse.triggered && !this.isStuckOrLoopMessage(processedMessage)) {
						// 首次催促只记录状态，不立即熔断，避免误触发。
						this.logService.info(`[AI Core Autopilot Fuse] nudge=${fuse.nudgeCount}, waiting for next confirmation`);
					}
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(
							`## 🚀 强制 Autopilot 执行\n\n` +
							`检测到执行意图，已跳过对话拉扯并直接执行剩余任务。\n\n` +
							`${forceStrongModel ? '⚡ 触发防呆熔断器，本轮已强制切换最强模型 **glm-5**。\n\n' : ''}`
						)
					});
					await this.executeSpecTasksWithAutopilotWorkers(
						pendingTasks,
						context,
						specModeServiceForForce,
						agentToolService,
						progress,
						glmService,
						forceStrongModel
					);
					this.resetAutopilotFuse(chatSessionKey);
					return {};
				}
			}

			// 自动子代理委派（仅在 Vibe 常规对话中启用，Spec 流程保持原逻辑）
			if (subagentService?.isEnabled() && chatMode === 'vibe') {
				try {
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(`🧠 已路由到子代理：${routingPlan.subAgent}，正在分析...`)
					});
					const delegated = await subagentService.runRoutedSubagent(
						routingPlan.subAgent,
						processedMessage,
						context,
						{
							model: selectedModel,
							enableThinking,
							enableWebSearch,
							maxTokens: selectedMaxTokens
						}
					);
					subagentDelegationContext =
						`## Subagent Analysis\n` +
						`- name: ${delegated.agentName}\n` +
						`- agentId: ${delegated.agentId}\n` +
						`- sessionId: ${delegated.sessionId}\n\n` +
						`${delegated.content.slice(0, 4000)}`;
				} catch (subErr) {
					this.logService.warn(`[AI Core Subagent] Delegation failed, fallback to main flow: ${String(subErr)}`);
				}
			}

			// Spec 模式特殊处理
			if (chatMode === 'spec') {
				await this.handleSpecModeRequest(userMessage, context, progress, glmService, agentToolService, responseHandler);
				return {};
			}

			// Vibe → Spec 转换检测 (Kiro 风格)
			// 识别开发需求类型的表达
			const lowerUserMessage = userMessage.toLowerCase();
			const isDevRequest = this.isDevRequest(userMessage); // 传原始消息，中文不需要 toLowerCase
			const isExplicitSpec = lowerUserMessage.includes('生成规格') || lowerUserMessage.includes('生成spec') ||
				lowerUserMessage.includes('generate spec') || lowerUserMessage.includes('create spec');

			this.logService.info(`[AI Core] Dev detection: message="${userMessage.slice(0, 50)}...", isDevRequest=${isDevRequest}, isExplicitSpec=${isExplicitSpec}`);

			if (isExplicitSpec || isDevRequest) {
				// 🚀 真正的 Agent 模式 - Autopilot 自动执行
				const executionMode = this.configurationService.getValue<'autopilot' | 'supervised'>('aiCore.executionMode') || 'autopilot';

				this.logService.info(`[AI Core] 🚀 AUTOPILOT TRIGGERED! executionMode=${executionMode}`);

				// 获取 SpecModeService
				const specModeService = this.instantiationService.invokeFunction(accessor => {
					try {
						return accessor.get(ISpecModeService);
					} catch (e) {
						this.logService.error(`[AI Core] Failed to get SpecModeService: ${String(e)}`);
						return undefined;
					}
				});

				if (specModeService) {
					this.logService.info(`[AI Core] SpecModeService obtained, starting ${executionMode} flow`);

					if (executionMode === 'autopilot') {
						// Autopilot 模式 - 全自动执行
						this.logService.info(`[AI Core] 🚀 Starting executeAutopilotFlow`);
						await this.executeAutopilotFlow(userMessage, context, specModeService, agentToolService, progress, glmService);
					} else {
						// Supervised 模式 - 逐步确认
						chatModeService.setMode('spec');
						specModeService.createSession(userMessage);
						await this.handleSpecStoryGeneration(
							userMessage,
							specModeService,
							progress,
							new ChatResponseHandler(progress, this.logService, agentToolService, { enableThinking: true })
						);
					}
					return {};
				}
			}

			// Vibe 模式 - 常规处理（带上下文缓存）
			// 参考: https://docs.bigmodel.cn/cn/guide/capabilities/cache

			// 🔍 在回答前自动扫描 .specs 目录中的未完成任务
			let specContext = '';
			const specModeService = this.instantiationService.invokeFunction(accessor => {
				try {
					return accessor.get(ISpecModeService);
				} catch {
					return undefined;
				}
			});
			if (specModeService) {
				this.logService.info('[AI Core GLM] SpecModeService available, checking for context...');

				// 1. 先检查当前内存中的会话
				const specSession = specModeService.getCurrentSession();
				if (specSession) {
					specContext = specModeService.getContextForPrompt();
					this.logService.info(`[AI Core GLM] Found active Spec session: ${specSession.id}, phase: ${specSession.phase}`);
				} else {
					this.logService.info('[AI Core GLM] No active Spec session in memory');
				}

				// 2. 扫描 .specs 目录中的未完成项目（即使没有活跃会话）
				this.logService.info('[AI Core GLM] Scanning .specs folder for pending tasks...');
				try {
					const pendingSpecs = await specModeService.scanPendingSpecs();
					this.logService.info(`[AI Core GLM] scanPendingSpecs returned ${pendingSpecs.length} items`);

					if (pendingSpecs.length > 0) {
						specContext += '\n\n## 📁 项目中未完成的开发任务\n\n';
						for (const spec of pendingSpecs) {
							const progressStr = spec.progress.tasksTotal > 0
								? `(${spec.progress.tasksCompleted}/${spec.progress.tasksTotal} 任务已完成)`
								: '';
							specContext += `### ${spec.title} ${progressStr}\n`;
							specContext += `- 目录: \`${spec.folderPath}\`\n`;
							specContext += `- 阶段: ${spec.phase}\n`;
							if (spec.progress.tasksTotal > 0) {
								const remaining = spec.progress.tasksTotal - spec.progress.tasksCompleted;
								specContext += `- 待完成: ${remaining} 个任务\n`;
							}
							specContext += '\n';
						}
						this.logService.info(`[AI Core GLM] Added ${pendingSpecs.length} pending specs to context`);
					}
				} catch (e) {
					this.logService.error(`[AI Core GLM] Failed to scan pending specs: ${String(e)}`);
				}
			} else {
				this.logService.warn('[AI Core GLM] SpecModeService not available');
			}

			// 构建用户消息（包含 # 上下文 + Spec 上下文 + 子代理分析）
			let finalUserMessage = processedMessage;
			if (additionalContext || specContext || subagentDelegationContext) {
				let contextParts = '';
				if (subagentDelegationContext) {
					contextParts += `\n\n${subagentDelegationContext}`;
				}
				if (specContext) {
					contextParts += `\n\n## 当前项目状态\n${specContext}`;
				}
				if (additionalContext) {
					contextParts += `\n\n${additionalContext}`;
				}
				finalUserMessage = `${contextParts}\n\n---\n\n用户问题: ${processedMessage}`;
			}

			// 获取工具定义（如果是 Agent 模式）
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const tools = isAgentMode ? agentToolService.getToolsForGLM() as any : undefined;

			// 检查是否有现有会话，没有则创建（保持对话上下文）
			let currentSession = glmService.getCurrentSession();
			if (!currentSession) {
				// 首次对话，创建会话并设置系统提示词
				const systemPrompt = glmService.buildSystemPrompt(context, isAgentMode ? 'agent' : 'chat', chatMode);
				currentSession = glmService.createSession(systemPrompt);
				this.logService.info(`[AI Core GLM] Created new session: ${currentSession.id}`);
			}

			// 使用带会话上下文的流式聊天（利用智谱 AI 上下文缓存）
			this.logService.info(`[AI Core GLM] Using session: ${currentSession.id} with ${currentSession.messages.length} history messages`);

			for await (const event of glmService.streamChatWithSession(finalUserMessage, context, {
				tools,
				model: selectedModel,
				enableThinking,
				enableWebSearch,
				maxTokens: selectedMaxTokens,
				sessionId: currentSession.id
			}, undefined)) {
				await responseHandler.handleEvent(event);
			}

			// 显示缓存统计（调试信息）
			const cacheStats = glmService.getCacheStats(currentSession.id);
			if (cacheStats.cachedTokens > 0) {
				this.logService.info(`[AI Core GLM] Cache stats: ${cacheStats.cachedTokens}/${cacheStats.totalTokens} tokens cached (${cacheStats.savings} savings)`);
			}

			this.logService.info(`[AI Core GLM] Stream completed, session has ${glmService.getSessionMessages(currentSession.id).length} messages`);
		} catch (error) {
			this.logService.error(`[AI Core GLM] Error: ${toErrorMessage(error)}`);
			progress({
				kind: 'warning',
				content: new MarkdownString(localize('glmError', "GLM request failed: {0}", toErrorMessage(error)))
			});
		}

		return {};
	}

	private async ensureProjectSkills(userMessage: string, progress: (part: IChatProgress) => void): Promise<void> {
		const workspaceService = this.instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceContextService));
		const fileService = this.instantiationService.invokeFunction(accessor => accessor.get(IFileService));
		const roots = workspaceService.getWorkspace().folders;
		if (roots.length === 0) {
			return;
		}

		const root = roots[0].uri;
		const profile = await this.collectProjectProfile(root, fileService);
		const projectSlug = this.toSkillId(profile.rootName);
		const skillsRoot = await this.pickSkillsRoot(root, fileService);
		const generatedFolders = [
			`${projectSlug}-architecture`,
			`${projectSlug}-coding`,
			`${projectSlug}-testing`
		];

		// 当前项目已存在分层 skills 则跳过
		if (await this.hasGeneratedProjectSkills(fileService, skillsRoot, generatedFolders)) {
			return;
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(`🧠 检测到项目缺少项目级 Skills，正在自动生成（${skillsRoot.path}）...`)
		});

		const isNewProject = profile.sourceFiles <= 8;
		const architectureFolder = URI.joinPath(skillsRoot, `${projectSlug}-architecture`);
		const codingFolder = URI.joinPath(skillsRoot, `${projectSlug}-coding`);
		const testingFolder = URI.joinPath(skillsRoot, `${projectSlug}-testing`);
		const scanRefFile = URI.joinPath(architectureFolder, 'references', 'PROJECT_SCAN.md');

		await fileService.createFolder(architectureFolder);
		await fileService.createFolder(codingFolder);
		await fileService.createFolder(testingFolder);

		await fileService.writeFile(
			URI.joinPath(architectureFolder, 'SKILL.md'),
			VSBuffer.fromString(this.buildArchitectureSkillMarkdown(profile, userMessage, isNewProject, projectSlug))
		);
		await fileService.writeFile(
			URI.joinPath(codingFolder, 'SKILL.md'),
			VSBuffer.fromString(this.buildCodingSkillMarkdown(profile, isNewProject, projectSlug))
		);
		await fileService.writeFile(
			URI.joinPath(testingFolder, 'SKILL.md'),
			VSBuffer.fromString(this.buildTestingSkillMarkdown(profile, isNewProject, projectSlug))
		);

		// 旧项目深度扫描报告（供 architecture skill 参考）
		if (!isNewProject) {
			await fileService.createFolder(URI.joinPath(architectureFolder, 'references'));
			const scanDoc = this.buildProjectScanReference(profile);
			await fileService.writeFile(scanRefFile, VSBuffer.fromString(scanDoc));
		}

		this.logService.info(`[AI Core Skills] Generated layered project skills under: ${skillsRoot.fsPath}`);
		progress({
			kind: 'progressMessage',
			content: new MarkdownString(`✅ 已自动生成分层 Skills（${projectSlug}-architecture / coding / testing）`)
		});
	}

	private async pickSkillsRoot(root: URI, fileService: IFileService): Promise<URI> {
		const agentsRoot = URI.joinPath(root, '.agents', 'skills');
		const cursorRoot = URI.joinPath(root, '.cursor', 'skills');

		// 优先使用中立目录 .agents/skills；如果历史项目已存在 .cursor/skills 则兼容复用
		try {
			await fileService.resolve(agentsRoot);
			return agentsRoot;
		} catch {
			// continue
		}

		try {
			await fileService.resolve(cursorRoot);
			return cursorRoot;
		} catch {
			// continue
		}

		return agentsRoot;
	}

	private async hasGeneratedProjectSkills(fileService: IFileService, skillsRoot: URI, folderNames: string[]): Promise<boolean> {
		for (const folderName of folderNames) {
			try {
				const stat = await fileService.resolve(URI.joinPath(skillsRoot, folderName, 'SKILL.md'));
				if (!stat.isDirectory) {
					return true;
				}
			} catch {
				// continue
			}
		}
		return false;
	}

	private async collectProjectProfile(root: URI, fileService: IFileService): Promise<{
		rootName: string;
		topLevelEntries: string[];
		sourceFiles: number;
		majorDirs: string[];
		stackHints: string[];
		topLevelDirSourceCounts: Array<{ name: string; sourceFiles: number }>;
	}> {
		let topLevelEntries: string[] = [];
		let sourceFiles = 0;
		const stackHints = new Set<string>();
		let topLevelDirSourceCounts: Array<{ name: string; sourceFiles: number }> = [];

		try {
			const stat = await fileService.resolve(root);
			topLevelEntries = (stat.children || []).map(c => c.name).slice(0, 40);

			for (const child of stat.children || []) {
				const name = child.name.toLowerCase();
				if (name === 'package.json') {
					stackHints.add('Node.js/TypeScript');
				}
				if (name === 'pubspec.yaml') {
					stackHints.add('Flutter/Dart');
				}
				if (name === 'requirements.txt' || name === 'pyproject.toml') {
					stackHints.add('Python');
				}
				if (name === 'pom.xml') {
					stackHints.add('Java/Maven');
				}
				if (name === 'go.mod') {
					stackHints.add('Go');
				}
				if (name === 'cargo.toml') {
					stackHints.add('Rust');
				}
			}

			const topLevelDirs = (stat.children || []).filter(c => c.isDirectory).slice(0, 20);
			topLevelDirSourceCounts = await Promise.all(
				topLevelDirs.map(async d => ({
					name: d.name,
					sourceFiles: await this.countSourceFiles(d.resource, fileService, 3, 200)
				}))
			);
			topLevelDirSourceCounts.sort((a, b) => b.sourceFiles - a.sourceFiles);
		} catch {
			// ignore
		}

		const majorDirs = topLevelEntries.filter(n => ['src', 'app', 'lib', 'services', 'backend', 'frontend', 'test', 'tests'].includes(n.toLowerCase()));
		sourceFiles = await this.countSourceFiles(root, fileService, 4, 400);

		return {
			rootName: root.path.split('/').pop() || 'project',
			topLevelEntries,
			sourceFiles,
			majorDirs,
			stackHints: Array.from(stackHints),
			topLevelDirSourceCounts
		};
	}

	private async countSourceFiles(root: URI, fileService: IFileService, maxDepth: number, maxFiles: number): Promise<number> {
		let count = 0;
		const exts = /\.(ts|tsx|js|jsx|py|java|go|rs|dart|swift|kt|c|cpp|cs|php|rb|vue|html|css|scss|sql|md)$/i;

		const walk = async (dir: URI, depth: number): Promise<void> => {
			if (depth > maxDepth || count >= maxFiles) {
				return;
			}
			let stat;
			try {
				stat = await fileService.resolve(dir);
			} catch {
				return;
			}
			for (const child of stat.children || []) {
				const name = child.name.toLowerCase();
				if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out' || name === 'build') {
					continue;
				}
				if (child.isDirectory) {
					await walk(child.resource, depth + 1);
				} else if (exts.test(child.name)) {
					count++;
					if (count >= maxFiles) {
						return;
					}
				}
			}
		};

		await walk(root, 0);
		return count;
	}

	private buildArchitectureSkillMarkdown(
		profile: { rootName: string; topLevelEntries: string[]; sourceFiles: number; majorDirs: string[]; stackHints: string[]; topLevelDirSourceCounts: Array<{ name: string; sourceFiles: number }> },
		userMessage: string,
		isNewProject: boolean,
		projectSlug: string
	): string {
		const stack = profile.stackHints.length > 0 ? profile.stackHints.join(' / ') : '待识别';
		const dirs = profile.majorDirs.length > 0 ? profile.majorDirs.join(', ') : '（暂无明显业务目录）';
		const top = profile.topLevelEntries.slice(0, 20).join(', ');
		const projectType = isNewProject ? '新项目' : '存量项目';
		const hotDirs = profile.topLevelDirSourceCounts
			.filter(item => item.sourceFiles > 0)
			.slice(0, 8)
			.map(item => `${item.name}(${item.sourceFiles})`)
			.join(', ') || 'N/A';

		return `---
name: ${projectSlug}-architecture
description: 项目架构分析与方案选择技能。适用于需求澄清、架构决策与实施路径设计。
---

# ${profile.rootName} Architecture Skill

## 项目画像
- 项目名称: ${profile.rootName}
- 项目类型: ${projectType}
- 代码规模(估算): ${profile.sourceFiles} 个源文件
- 技术栈线索: ${stack}
- 核心目录: ${dirs}
- 高活跃目录(源文件数): ${hotDirs}
- 顶层结构: ${top}

## 使用时机
- 用户提出新需求，需要先分析需求再落地实现
- 用户询问架构选择、技术方案对比、任务分解
- 进行跨文件改造或多步骤开发时

## 指令
- 先输出「需求澄清 + 目标边界 + 验收标准」三段摘要
- 若为新项目，先给出推荐架构与目录规范，再拆分里程碑任务
- 若为存量项目，先结合 references/PROJECT_SCAN.md 做模块复用评估，再给最小改动路径
- 实施前给出 1-3 个方案并说明 trade-off（性能、成本、复杂度）
- 执行时按任务顺序推进，并在每步后更新进度与风险

## 当前用户上下文
- 最近用户需求: ${userMessage.slice(0, 400)}

## 输出格式
1. 需求分析
2. 架构方案（含优缺点）
3. 实施任务清单（可执行）
4. 风险与回滚计划
`;
	}

	private buildCodingSkillMarkdown(
		profile: { rootName: string; topLevelEntries: string[]; sourceFiles: number; majorDirs: string[]; stackHints: string[]; topLevelDirSourceCounts: Array<{ name: string; sourceFiles: number }> },
		isNewProject: boolean,
		projectSlug: string
	): string {
		const projectType = isNewProject ? '新项目' : '存量项目';
		const stack = profile.stackHints.length > 0 ? profile.stackHints.join(' / ') : '待识别';
		return `---
name: ${projectSlug}-coding
description: 项目编码实施技能。适用于按任务落地、模块实现、重构与错误修复。
---

# ${profile.rootName} Coding Skill

## 项目上下文
- 项目类型: ${projectType}
- 技术栈线索: ${stack}
- 优先复用目录: ${profile.majorDirs.join(', ') || '请先扫描确定'}

## 指令
- 先确认变更范围，优先最小改动并保持兼容
- 涉及跨模块改动时，先列出依赖关系和影响面
- 对复杂逻辑添加简洁注释，避免冗长注释
- 改动后优先执行与当前变更直接相关的校验与编译
- 发现风险时先反馈，再继续扩展改造

## 输出格式
1. 实施步骤
2. 关键改动点
3. 验证结果
4. 后续建议
`;
	}

	private buildTestingSkillMarkdown(
		profile: { rootName: string; topLevelEntries: string[]; sourceFiles: number; majorDirs: string[]; stackHints: string[]; topLevelDirSourceCounts: Array<{ name: string; sourceFiles: number }> },
		isNewProject: boolean,
		projectSlug: string
	): string {
		const projectType = isNewProject ? '新项目' : '存量项目';
		return `---
name: ${projectSlug}-testing
description: 项目测试与质量保障技能。适用于测试策略、回归验证与风险兜底。
---

# ${profile.rootName} Testing Skill

## 项目上下文
- 项目类型: ${projectType}
- 规模估算: ${profile.sourceFiles} 个源文件

## 指令
- 按“核心流程 > 边界条件 > 回归风险”组织测试计划
- 先覆盖本次变更直接影响的功能，再扩展关联路径
- 对失败用例给出可复现步骤和定位线索
- 无法本地执行的测试要明确标注阻塞原因和替代验证
- 输出风险分级（高/中/低）及上线建议

## 输出格式
1. 测试范围
2. 用例清单
3. 执行结果
4. 风险评估
`;
	}

	private buildProjectScanReference(profile: { rootName: string; topLevelEntries: string[]; sourceFiles: number; majorDirs: string[]; stackHints: string[]; topLevelDirSourceCounts: Array<{ name: string; sourceFiles: number }> }): string {
		return `# PROJECT_SCAN

## Summary
- root: ${profile.rootName}
- sourceFiles(estimated): ${profile.sourceFiles}
- stackHints: ${profile.stackHints.join(', ') || 'N/A'}
- majorDirs: ${profile.majorDirs.join(', ') || 'N/A'}

## Top-level entries
${profile.topLevelEntries.map(e => `- ${e}`).join('\n')}

## Top-level directory source counts
${profile.topLevelDirSourceCounts.map(e => `- ${e.name}: ${e.sourceFiles}`).join('\n') || '- N/A'}
`;
	}

	private toSkillId(input: string): string {
		const normalized = input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		return normalized || 'project';
	}

	/**
	 * 检测用户消息是否是开发需求
	 */
	private isDevRequest(message: string): boolean {
		const lowerMsg = message.toLowerCase();

		// 开发需求关键词 - 强匹配
		const strongDevPatterns = [
			// 中文开发需求
			'我需要开发', '帮我开发', '帮我创建', '帮我实现', '帮我构建',
			'开发一个', '创建一个', '实现一个', '构建一个', '做一个',
			'写一个', '设计一个', '搭建一个',
			'开发这个', '帮我做这个', '帮我写一个',
			'需要开发', '想要开发', '想开发',
			// 英文开发需求
			'develop a', 'create a', 'build a', 'implement a', 'make a',
			'i need to develop', 'i want to create', 'help me build',
			'can you create', 'please develop', 'please build'
		];

		// 产品类型关键词
		const productPatterns = [
			'app', 'application', '应用', 'APP',
			'系统', '平台', '网站', '小程序', '程序',
			'项目', 'project', '软件', 'software',
			'功能', 'feature', '模块', 'module', '工具'
		];

		// 技术栈关键词
		const techPatterns = [
			'flutter', 'react', 'vue', 'angular', 'node', 'python',
			'java', 'swift', 'kotlin', 'typescript', 'javascript',
			'技术栈', 'tech stack', 'framework', '框架',
			'前端', '后端', 'backend', 'frontend', 'api'
		];

		// 检测逻辑：
		// 1. 强匹配开发关键词
		const hasStrongDev = strongDevPatterns.some(p => message.includes(p) || lowerMsg.includes(p.toLowerCase()));

		// 2. 产品类型 + 技术栈组合
		const hasProduct = productPatterns.some(p => message.includes(p) || lowerMsg.includes(p.toLowerCase()));
		const hasTech = techPatterns.some(p => lowerMsg.includes(p.toLowerCase()));

		const result = hasStrongDev || (hasProduct && hasTech) || (hasProduct && message.length > 30);

		this.logService.info(`[AI Core] isDevRequest: strongDev=${hasStrongDev}, product=${hasProduct}, tech=${hasTech}, result=${result}`);

		return result;
	}

	/**
	 * 🚀 Autopilot 模式 - 全自动执行开发流程
	 * 类似 Kiro 的 Autopilot，自动完成：规划 → 设计 → 任务 → 代码生成
	 */
	private async executeAutopilotFlow(
		requirement: string,
		context: GLMChatContext,
		specService: ISpecModeService,
		agentToolService: IAgentToolService,
		progress: (part: IChatProgress) => void,
		glmService: IGLMChatService
	): Promise<void> {
		const startTime = Date.now();

		// ============= 阶段 1: 启动 =============
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('# 🚀 Autopilot 模式启动\n\n正在自动分析并开发您的需求...\n\n')
		});

		// ============= 阶段 2: 需求分析 & 用户故事 =============
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('## 📋 阶段 1/4: 需求分析\n\n🔄 正在生成用户故事...\n\n')
		});

		specService.createSession(requirement);
		const stories = await specService.generateUserStories(requirement);

		progress({
			kind: 'markdownContent',
			content: new MarkdownString(`✅ 已生成 **${stories.length}** 个用户故事\n\n`)
		});

		// 简要显示故事
		let storySummary = '';
		for (const story of stories.slice(0, 3)) {
			storySummary += `- ${story.title}\n`;
		}
		if (stories.length > 3) {
			storySummary += `- ... 和另外 ${stories.length - 3} 个故事\n`;
		}
		progress({
			kind: 'markdownContent',
			content: new MarkdownString(storySummary + '\n')
		});

		// ============= 阶段 3: 技术设计 =============
		await this.delay(100);
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('## 🏗️ 阶段 2/4: 技术设计\n\n🔄 正在生成架构设计...\n\n')
		});

		specService.approveAllStories();
		const design = await specService.generateTechnicalDesign(stories);

		progress({
			kind: 'markdownContent',
			content: new MarkdownString(`✅ 架构: ${design.architecture?.slice(0, 80)}...\n\n`)
		});
		progress({
			kind: 'markdownContent',
			content: new MarkdownString(`✅ 组件: ${design.components.length} 个\n\n`)
		});

		// ============= 阶段 4: 任务规划 =============
		await this.delay(100);
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('## 📝 阶段 3/4: 任务规划\n\n🔄 正在分解开发任务...\n\n')
		});

		specService.approveDesign();
		const tasks = await specService.generateTasks(stories, design);

		progress({
			kind: 'markdownContent',
			content: new MarkdownString(`✅ 已生成 **${tasks.length}** 个开发任务\n\n`)
		});

		// ============= 阶段 5: 自动执行任务 =============
		await this.delay(100);
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('## 💻 阶段 4/4: 代码生成\n\n🔄 正在自动执行任务并生成代码...\n\n')
		});

		let completedTasks = 0;
		const totalTasks = tasks.length;
		completedTasks = await this.executeSpecTasksWithAutopilotWorkers(
			tasks,
			context,
			specService,
			agentToolService,
			progress,
			glmService,
			false
		);

		// ============= 完成总结 =============
		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		progress({
			kind: 'markdownContent',
			content: new MarkdownString(`
---

# 🎉 Autopilot 执行完成

| 指标 | 值 |
|------|------|
| 用户故事 | ${stories.length} 个 |
| 组件设计 | ${design.components.length} 个 |
| 任务完成 | ${completedTasks}/${totalTasks} |
| 总耗时 | ${duration} 秒 |

## 📂 规格文件

规格文件已保存到 \`.specs/\` 目录：
- \`requirements.md\` - 需求文档 (EARS 格式)
- \`design.md\` - 技术设计 (含 Mermaid 图)
- \`tasks.md\` - 任务列表

> 💡 如需调整，可以输入具体修改要求，我会继续帮你完善。
`)
		});
	}

	/**
	 * 使用 Agent 工具执行单个任务
	 * P0.1/P0.2/P0.3 - 增强容错、重试机制、友好错误信息
	 */
	private async executeTaskWithAgent(
		task: SpecTask,
		context: GLMChatContext,
		agentToolService: IAgentToolService,
		glmService: IGLMChatService,
		progress: (part: IChatProgress) => void,
		additionalGuidance?: string,
		taskRouting?: GLMTaskRoutingPlan
	): Promise<{ success: boolean; summary: string; filesCreated?: string[]; error?: string }> {
		const filesCreated: string[] = [];

		// 构建任务执行 prompt
		const taskPrompt = `你是一个专业的开发 Agent，请执行以下任务并生成代码。

## 任务
**标题**: ${task.title}
**描述**: ${task.description}
**类型**: ${task.type}

## 要求
1. 生成完整可用的代码
2. 包含必要的注释
3. 遵循最佳实践
${additionalGuidance ? `\n## 子代理执行建议\n${additionalGuidance}\n` : ''}

## 输出格式
请以 JSON 格式返回：
{
  "files": [
    {
      "path": "文件路径",
      "content": "文件内容",
      "language": "编程语言"
    }
  ],
  "summary": "简要说明做了什么"
}`;

		const messages: GLMMessage[] = [
			{ role: 'system', content: '你是一个代码生成 Agent。直接输出 JSON 格式的结果，不要添加任何多余的解释。' },
			{ role: 'user', content: taskPrompt }
		];

		// P0.2 - 使用重试机制执行任务
		try {
			const result = await executeWithRetry(
				async () => {
					// 收集 LLM 响应
					let responseContent = '';
					for await (const event of glmService.streamChat(messages, context, {
						model: taskRouting?.model,
						maxTokens: taskRouting?.maxTokens || 16384,
						enableThinking: taskRouting ? taskRouting.enableThinking : true,
						enableWebSearch: taskRouting ? taskRouting.enableWebSearch : true
					})) {
						if (event.type === 'content' && event.content) {
							responseContent += event.content;
						}
					}

					// P0.1 - 使用增强的 JSON 解析
					const parsed = safeParseJSON<{
						files?: Array<{ path: string; content: string; language?: string }>;
						summary?: string;
					}>(responseContent);

					if (!parsed) {
						throw new Error('JSON 解析失败');
					}

					return parsed;
				},
				{
					maxRetries: 3,
					baseDelayMs: 1000,
					onRetry: (attempt, error) => {
						// P0.3 - 显示友好的重试信息
						const friendlyMsg = toFriendlyErrorMessage(error);
						progress({
							kind: 'progressMessage',
							content: new MarkdownString(`⚠️ ${friendlyMsg} (重试 ${attempt}/3)`)
						});
						this.logService.warn(`[Agent] Task retry ${attempt}/3: ${error.message}`);
					}
				}
			);

			// 创建文件
			if (result.files && result.files.length > 0) {
				for (const file of result.files) {
					try {
						// 使用 executeTool 调用 write_file 工具
						const writeResult = await agentToolService.executeTool('write_file', {
							path: file.path,
							content: file.content
						});

						if (writeResult.success) {
							filesCreated.push(file.path);
							progress({
								kind: 'markdownContent',
								content: new MarkdownString(`  📄 创建: \`${file.path}\`\n`)
							});
						} else {
							this.logService.warn(`[Agent] Failed to write file ${file.path}: ${writeResult.output}`);
						}
					} catch (writeError) {
						this.logService.warn(`[Agent] Failed to write file ${file.path}: ${String(writeError)}`);
					}
				}
			}

			return {
				success: true,
				summary: result.summary || '任务完成',
				filesCreated
			};
		} catch (error) {
			// P0.3 - 返回友好错误信息
			const friendlyError = toFriendlyErrorMessage(error);
			this.logService.error(`[Agent] Task failed after retries: ${String(error)}`);
			return {
				success: false,
				summary: '',
				error: friendlyError
			};
		}
	}

	private async executeSpecTasksWithAutopilotWorkers(
		tasks: SpecTask[],
		context: GLMChatContext,
		specService: ISpecModeService,
		agentToolService: IAgentToolService,
		progress: (part: IChatProgress) => void,
		glmService: IGLMChatService,
		forceStrongModel: boolean
	): Promise<number> {
		let completedTasks = 0;
		let finishedTasks = 0;
		const totalTasks = tasks.length;
		const subagentService = this.instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(ISubagentOrchestratorService);
			} catch {
				return undefined;
			}
		});
		const parallelEnabled = this.configurationService.getValue<boolean>('aiCore.enableParallelTaskExecution') !== false;
		const configuredParallel = this.configurationService.getValue<number>('aiCore.maxParallelSubagents') || 3;
		const maxConcurrentByProviderLimit = 3; // GLM 官方并发限制兜底
		const workerCount = Math.max(1, Math.min(maxConcurrentByProviderLimit, parallelEnabled ? configuredParallel : 1));
		if ((parallelEnabled ? configuredParallel : 1) > maxConcurrentByProviderLimit) {
			this.logService.warn(`[AI Core Autopilot] Parallel workers reduced to ${maxConcurrentByProviderLimit} due to GLM concurrency limit`);
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(
				`🤖 任务执行模式：${workerCount > 1 ? `并行子代理 x${workerCount}` : '串行执行'}（每任务 GLM-5 路由）` +
				`${forceStrongModel ? ' ｜ ⚡ 强制 glm-5' : ''}`
			)
		});

		let taskCursor = 0;
		const worker = async (workerId: number): Promise<void> => {
			while (true) {
				const currentIndex = taskCursor++;
				if (currentIndex >= tasks.length) {
					return;
				}

				const task = tasks[currentIndex];
				specService.startTask(task.id);
				progress({
					kind: 'markdownContent',
					content: new MarkdownString(`### ▶️ [Worker-${workerId}] 执行任务 ${currentIndex + 1}/${totalTasks}: ${task.title}\n\n`)
				});

				try {
					let subagentGuidance = '';
					const routeInput = `${task.title}\n${task.description}`;
					const routing = await glmService.analyzeTaskAndRoute(routeInput, context, 'spec', true, true);
					const effectiveRouting: GLMTaskRoutingPlan = forceStrongModel
						? {
							...routing,
							model: 'glm-5',
							enableThinking: true,
							enableWebSearch: true,
							maxTokens: Math.max(32768, routing.maxTokens)
						}
						: routing;
					const complexityLabel = effectiveRouting.complexity === 'simple' ? '简单任务' : effectiveRouting.complexity === 'medium' ? '一般任务' : '复杂任务';
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(
							`> 🏷️ 任务分级：**${complexityLabel}** ｜ 🤖 执行模型：\`${effectiveRouting.model}\` ｜ 🧩 子代理：\`${effectiveRouting.subAgent}\`\n\n`
						)
					});

					if (subagentService?.isEnabled()) {
						const delegated = await subagentService.runRoutedSubagent(
							effectiveRouting.subAgent,
							`请为以下任务生成高质量执行建议（聚焦可落地步骤和风险点）：\n\n${routeInput}`,
							context,
							{
								model: effectiveRouting.model,
								enableThinking: effectiveRouting.enableThinking,
								enableWebSearch: effectiveRouting.enableWebSearch,
								maxTokens: effectiveRouting.maxTokens
							}
						);
						subagentGuidance = delegated.content.slice(0, 3000);
						progress({
							kind: 'progressMessage',
							content: new MarkdownString(`🧠 子代理 ${delegated.agentName} 已完成任务预分析`)
						});
					}

					const result = await this.executeTaskWithAgent(task, context, agentToolService, glmService, progress, subagentGuidance, effectiveRouting);
					if (result.success) {
						completedTasks++;
						specService.completeTask(task.id);
						progress({
							kind: 'markdownContent',
							content: new MarkdownString(`✅ 完成: ${result.summary}\n\n`)
						});
						if (result.filesCreated && result.filesCreated.length > 0) {
							let filesContent = '📁 **创建的文件**:\n';
							for (const file of result.filesCreated) {
								filesContent += `- \`${file}\`\n`;
							}
							progress({
								kind: 'markdownContent',
								content: new MarkdownString(filesContent + '\n')
							});
						}
					} else {
						specService.failTask(task.id, result.error || '任务执行失败');
						progress({
							kind: 'markdownContent',
							content: new MarkdownString(`⚠️ 任务未完成: ${result.error || '未知错误'}\n\n`)
						});
					}
				} catch (error) {
					specService.failTask(task.id, String(error));
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(`❌ 执行失败: ${String(error)}\n\n`)
					});
				} finally {
					finishedTasks++;
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(`📊 总体进度：${finishedTasks}/${totalTasks}，已完成 ${completedTasks}`)
					});
				}
			}
		};

		await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
		return completedTasks;
	}

	private shouldForceAutopilotResume(message: string): boolean {
		const text = message.toLowerCase();
		const patterns = [
			'继续', '继续执行', '往下执行', '自动往下', '直接执行', '不要问',
			'continue', 'keep going', 'go on', 'execute all', 'auto execute'
		];
		return patterns.some(p => text.includes(p));
	}

	private shouldAutopilotImmediateTakeover(message: string): boolean {
		const text = message.toLowerCase();
		const patterns = [
			'运行', '启动', '报错', '错误', '修复', '卡住', '失败',
			'run', 'start', 'dev', 'npm', 'error', 'fix', 'failed', 'broken'
		];
		return patterns.some(p => text.includes(p));
	}

	private isStuckOrLoopMessage(message: string): boolean {
		const text = message.toLowerCase();
		const patterns = ['循环', '卡住', '反复', '拉扯', '愚蠢', 'stuck', 'loop', 'repeat'];
		return patterns.some(p => text.includes(p));
	}

	private evaluateAutopilotFuse(
		sessionKey: string,
		message: string,
		tasks: SpecTask[]
	): { triggered: boolean; nudgeCount: number } {
		const pending = tasks.filter(t => t.status === 'pending' || t.status === 'blocked').length;
		const completed = tasks.filter(t => t.status === 'completed').length;
		const previous = this.autopilotFuseState.get(sessionKey) || { nudgeCount: 0, lastPending: pending, lastCompleted: completed };

		const isNudge = this.shouldForceAutopilotResume(message);
		const progressed = completed > previous.lastCompleted || pending < previous.lastPending;
		let nudgeCount = progressed ? 0 : previous.nudgeCount;
		if (isNudge) {
			nudgeCount += 1;
		}

		this.autopilotFuseState.set(sessionKey, {
			nudgeCount,
			lastPending: pending,
			lastCompleted: completed
		});

		return { triggered: nudgeCount >= 2, nudgeCount };
	}

	private resetAutopilotFuse(sessionKey: string): void {
		this.autopilotFuseState.delete(sessionKey);
	}

	/**
	 * 处理 Spec 模式的请求 - 根据当前阶段执行不同操作
	 */
	private async handleSpecModeRequest(
		userMessage: string,
		context: GLMChatContext,
		progress: (part: IChatProgress) => void,
		glmService: IGLMChatService,
		agentToolService: IAgentToolService,
		responseHandler: ChatResponseHandler
	): Promise<void> {
		// 动态获取 SpecModeService
		const specModeService = this.instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(ISpecModeService);
			} catch {
				return undefined;
			}
		});

		if (!specModeService) {
			this.logService.warn('[AI Core GLM] SpecModeService not available');
			// 回退到普通处理
			return;
		}

		const session = specModeService.getCurrentSession();
		const phase = specModeService.getCurrentPhase();

		this.logService.info(`[AI Core GLM] Spec mode - Phase: ${phase}, Session: ${session?.id || 'none'}`);

		// 检测特殊命令
		const lowerMessage = userMessage.toLowerCase();

		// "检查已完成任务" 命令
		if (lowerMessage.includes('检查') && (lowerMessage.includes('完成') || lowerMessage.includes('任务'))) {
			progress({
				kind: 'progressMessage',
				content: new MarkdownString('🔍 正在扫描代码库，检测已完成的任务...')
			});

			const markedCount = await specModeService.scanCompletedTasks();

			progress({
				kind: 'markdownContent',
				content: new MarkdownString(`## ✅ 扫描完成\n\n发现并标记了 **${markedCount}** 个已完成的任务。\n\n${markedCount > 0 ? '任务列表已更新，请查看 Specs 面板。' : '没有发现新的已完成任务。'}`)
			});
			return;
		}

		// "执行所有任务" 命令
		if (lowerMessage.includes('执行所有') || lowerMessage.includes('execute all')) {
			progress({
				kind: 'progressMessage',
				content: new MarkdownString('🚀 开始批量执行所有任务...')
			});

			const currentSession = specModeService.getCurrentSession();
			if (currentSession) {
				const pendingTasks = currentSession.tasks.filter(t => t.status === 'pending' || t.status === 'blocked');
				const completedCount = await this.executeSpecTasksWithAutopilotWorkers(
					pendingTasks,
					context,
					specModeService,
					agentToolService,
					progress,
					glmService,
					false
				);

				progress({
					kind: 'markdownContent',
					content: new MarkdownString(`## 🎉 批量执行完成\n\n成功执行了 **${completedCount}/${pendingTasks.length}** 个任务。\n\n规格文件已保存到 \`.specs/\` 目录。`)
				});
			}
			return;
		}

		// 如果没有会话，创建新会话
		if (!session) {
			specModeService.createSession(userMessage);
			progress({
				kind: 'progressMessage',
				content: new MarkdownString('📋 已创建 Spec 会话，正在分析需求...')
			});
		}

		// 根据阶段处理
		switch (phase) {
			case 'requirement_gathering':
			case 'story_generation':
				await this.handleSpecStoryGeneration(userMessage, specModeService, progress, responseHandler);
				break;

			case 'story_review':
				await this.handleSpecStoryReview(userMessage, specModeService, progress, responseHandler);
				break;

			case 'design_generation':
			case 'design_review':
				await this.handleSpecDesignReview(userMessage, specModeService, progress, responseHandler);
				break;

			case 'task_generation':
			case 'task_execution':
				await this.handleSpecTaskExecution(userMessage, specModeService, progress, responseHandler);
				break;

			default: {
				// 使用会话管理处理默认情况
				let currentSession = glmService.getCurrentSession();
				if (!currentSession) {
					const defaultPrompt = specModeService.getSystemPrompt();
					currentSession = glmService.createSession(defaultPrompt);
				}

				for await (const event of glmService.streamChatWithSession(userMessage, context, {
					sessionId: currentSession.id
				})) {
					await responseHandler.handleEvent(event);
				}
				break;
			}
		}
	}

	private async handleSpecStoryGeneration(
		userMessage: string,
		specService: ISpecModeService,
		progress: (part: IChatProgress) => void,
		_responseHandler: ChatResponseHandler
	): Promise<void> {
		progress({
			kind: 'progressMessage',
			content: new MarkdownString('📝 正在生成用户故事...')
		});

		const stories = await specService.generateUserStories(userMessage);

		// 显示生成的用户故事
		let content = '## 📋 用户故事\n\n';
		content += `已生成 **${stories.length}** 个用户故事：\n\n`;

		let storyIndex = 1;
		for (const story of stories) {
			const priorityIcon = story.priority === 'high' ? '🔴 HIGH' : story.priority === 'medium' ? '🟡 MEDIUM' : '🟢 LOW';
			content += `### US-${String(storyIndex).padStart(3, '0')}: ${story.title}\n\n`;
			content += `| 属性 | 值 |\n|------|----|\n`;
			content += `| **优先级** | ${priorityIcon} |\n\n`;
			content += `> ${story.description}\n\n`;
			content += `**验收标准 (EARS Notation)**:\n\n`;

			// 格式化 EARS 验收标准
			for (let i = 0; i < story.acceptanceCriteria.length; i++) {
				const criteria = story.acceptanceCriteria[i];
				// 高亮 Given/When/Then 关键字
				const formatted = criteria
					.replace(/\bGiven\b/gi, '**Given**')
					.replace(/\bWhen\b/gi, '**When**')
					.replace(/\bThen\b/gi, '**Then**');
				content += `- [ ] **AC-${i + 1}**: ${formatted}\n`;
			}
			content += '\n---\n\n';
			storyIndex++;
		}

		content += '> 📋 **EARS 格式说明**: Given (前置条件) → When (触发条件) → Then (预期行为)\n\n';
		content += '> 💡 请审核以上用户故事。如果满意，请输入 "确认" 或 "批准" 继续生成技术设计。';

		progress({
			kind: 'markdownContent',
			content: new MarkdownString(content)
		});
	}

	private async handleSpecStoryReview(
		userMessage: string,
		specService: ISpecModeService,
		progress: (part: IChatProgress) => void,
		_responseHandler: ChatResponseHandler
	): Promise<void> {
		const lowerMessage = userMessage.toLowerCase();

		if (lowerMessage.includes('确认') || lowerMessage.includes('批准') ||
			lowerMessage.includes('ok') || lowerMessage.includes('approve')) {
			specService.approveAllStories();

			// 流式输出 - 逐步显示
			progress({
				kind: 'markdownContent',
				content: new MarkdownString('✅ **用户故事已批准**\n\n')
			});

			await this.delay(100);
			progress({
				kind: 'markdownContent',
				content: new MarkdownString('🔄 正在生成技术设计文档...\n\n')
			});

			const session = specService.getCurrentSession();
			if (session) {
				try {
					const design = await specService.generateTechnicalDesign(session.userStories);

					// 逐步输出设计文档内容
					progress({
						kind: 'markdownContent',
						content: new MarkdownString('# 🏗️ 技术设计文档\n\n')
					});

					await this.delay(50);
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(`## 概述\n\n${design.overview}\n\n`)
					});

					await this.delay(50);
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(`## 架构\n\n${design.architecture}\n\n`)
					});

					// 显示序列图
					if (design.sequenceDiagram) {
						await this.delay(50);
						let diagramContent = `## 序列图\n\n`;
						diagramContent += '```mermaid\nsequenceDiagram\n';
						diagramContent += design.sequenceDiagram;
						diagramContent += '\n```\n\n';
						progress({
							kind: 'markdownContent',
							content: new MarkdownString(diagramContent)
						});
					}

					await this.delay(50);
					let componentsContent = `## 组件设计\n\n`;
					componentsContent += '| 组件 | 职责 | 接口 | 依赖 |\n|------|------|------|------|\n';
					for (const comp of design.components) {
						const interfaces = comp.interfaces?.join(', ') || '-';
						const dependencies = comp.dependencies?.join(', ') || '-';
						componentsContent += `| **${comp.name}** | ${comp.responsibility} | ${interfaces} | ${dependencies} |\n`;
					}
					componentsContent += '\n';
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(componentsContent)
					});

					if (design.dataFlow) {
						await this.delay(50);
						progress({
							kind: 'markdownContent',
							content: new MarkdownString(`## 数据流\n\n${design.dataFlow}\n\n`)
						});
					}

					if (design.apiDesign) {
						await this.delay(50);
						progress({
							kind: 'markdownContent',
							content: new MarkdownString(`## API 设计\n\n${design.apiDesign.replace(/\\n/g, '\n')}\n\n`)
						});
					}

					if (design.testingStrategy) {
						await this.delay(50);
						progress({
							kind: 'markdownContent',
							content: new MarkdownString(`## 测试策略\n\n${design.testingStrategy}\n\n`)
						});
					}

					// 操作按钮
					await this.delay(50);
					let actionsContent = '---\n\n### 🎮 操作\n\n';
					actionsContent += '| 操作 | 说明 |\n|------|------|\n';
					actionsContent += '| [📄 预览设计文档](command:aicore.previewDesign) | 在编辑器中查看完整设计 |\n';
					actionsContent += '| [💾 保存规格文件](command:aicore.saveSpecFiles) | 保存到 .specs 目录 |\n';
					actionsContent += '\n---\n\n';
					actionsContent += '> 💡 请审核技术设计。如果满意，请输入 **"确认"** 继续生成任务列表。';

					progress({
						kind: 'markdownContent',
						content: new MarkdownString(actionsContent, { isTrusted: true })
					});

				} catch (error) {
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(`\n\n❌ **生成设计文档失败**: ${String(error)}\n\n请重试或检查网络连接。`)
					});
				}
			}
		} else {
			progress({
				kind: 'markdownContent',
				content: new MarkdownString('请输入 **"确认"** 批准用户故事，或提出修改建议。')
			});
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private async handleSpecDesignReview(
		userMessage: string,
		specService: ISpecModeService,
		progress: (part: IChatProgress) => void,
		responseHandler: ChatResponseHandler
	): Promise<void> {
		const lowerMessage = userMessage.toLowerCase();

		if (lowerMessage.includes('确认') || lowerMessage.includes('批准') ||
			lowerMessage.includes('ok') || lowerMessage.includes('approve')) {
			// 用户确认设计，生成任务列表
			await this.handleSpecTaskGeneration(specService, progress, responseHandler);
		} else {
			// 显示当前设计供用户审核
			const session = specService.getCurrentSession();
			if (session?.technicalDesign) {
				let content = '📋 **当前技术设计状态**\n\n';
				content += `设计概述: ${session.technicalDesign.overview?.slice(0, 100)}...\n\n`;
				content += `组件数量: ${session.technicalDesign.components.length} 个\n\n`;
				content += '> 💡 请输入 **"确认"** 批准技术设计并生成任务列表，或提出修改建议。';

				progress({
					kind: 'markdownContent',
					content: new MarkdownString(content)
				});
			} else {
				progress({
					kind: 'markdownContent',
					content: new MarkdownString('⚠️ 未找到技术设计，请先生成用户故事并确认。')
				});
			}
		}
	}

	private async handleSpecTaskGeneration(
		specService: ISpecModeService,
		progress: (part: IChatProgress) => void,
		_responseHandler: ChatResponseHandler
	): Promise<void> {
		// 批准设计并生成任务列表
		specService.approveDesign();

		// 流式输出 - 逐步显示
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('✅ **技术设计已批准**\n\n')
		});

		await this.delay(100);
		progress({
			kind: 'markdownContent',
			content: new MarkdownString('🔄 正在生成任务列表...\n\n')
		});

		const session = specService.getCurrentSession();
		if (session && session.technicalDesign) {
			try {
				const tasks = await specService.generateTasks(session.userStories, session.technicalDesign);

				// 逐步输出任务列表
				progress({
					kind: 'markdownContent',
					content: new MarkdownString(`# 📋 任务列表\n\n共 **${tasks.length}** 个任务：\n\n`)
				});

				// 按类型分组显示任务
				const tasksByType = {
					implementation: tasks.filter(t => t.type === 'implementation'),
					test: tasks.filter(t => t.type === 'test'),
					documentation: tasks.filter(t => t.type === 'documentation'),
					review: tasks.filter(t => t.type === 'review')
				};

				if (tasksByType.implementation.length > 0) {
					await this.delay(50);
					let implContent = '## 💻 开发任务\n\n';
					for (const task of tasksByType.implementation) {
						implContent += `- [ ] **${task.title}**\n`;
						implContent += `  > ${task.description}\n`;
						if (task.estimatedEffort) {
							implContent += `  > ⏱️ 预估: ${task.estimatedEffort}\n`;
						}
						implContent += '\n';
					}
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(implContent)
					});
				}

				if (tasksByType.test.length > 0) {
					await this.delay(50);
					let testContent = '## 🧪 测试任务\n\n';
					for (const task of tasksByType.test) {
						testContent += `- [ ] **${task.title}**\n`;
						testContent += `  > ${task.description}\n`;
						testContent += '\n';
					}
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(testContent)
					});
				}

				if (tasksByType.documentation.length > 0) {
					await this.delay(50);
					let docContent = '## 📝 文档任务\n\n';
					for (const task of tasksByType.documentation) {
						docContent += `- [ ] **${task.title}**\n`;
						docContent += `  > ${task.description}\n`;
						docContent += '\n';
					}
					progress({
						kind: 'markdownContent',
						content: new MarkdownString(docContent)
					});
				}

				// 操作按钮
				await this.delay(50);
				let actionsContent = '---\n\n### 🎮 操作\n\n';
				actionsContent += '| 操作 | 说明 |\n|------|------|\n';
				actionsContent += '| [▶️ 执行所有任务](command:aicore.executeAllTasks) | 自动执行所有待办任务 |\n';
				actionsContent += '| [📋 预览需求](command:aicore.previewRequirements) | 查看 EARS 格式需求 |\n';
				actionsContent += '| [📄 预览设计](command:aicore.previewDesign) | 查看设计文档 |\n';
				actionsContent += '| [💾 保存文件](command:aicore.saveSpecFiles) | 保存所有规格文件 |\n';
				actionsContent += '\n---\n\n';
				actionsContent += '> 💡 输入 **"开始"** 或 **"执行"** 来开始执行任务，或点击上方按钮批量执行。';

				progress({
					kind: 'markdownContent',
					content: new MarkdownString(actionsContent, { isTrusted: true })
				});

			} catch (error) {
				progress({
					kind: 'markdownContent',
					content: new MarkdownString(`\n\n❌ **生成任务列表失败**: ${String(error)}\n\n请重试或检查网络连接。`)
				});
			}
		}
	}

	private async handleSpecTaskExecution(
		userMessage: string,
		specService: ISpecModeService,
		progress: (part: IChatProgress) => void,
		_responseHandler: ChatResponseHandler
	): Promise<void> {
		const lowerMessage = userMessage.toLowerCase();

		if (lowerMessage.includes('开始') || lowerMessage.includes('执行') ||
			lowerMessage.includes('继续') || lowerMessage.includes('continue') ||
			lowerMessage.includes('start') || lowerMessage.includes('execute')) {

			const nextTask = specService.getNextTask();
			if (!nextTask) {
				const session = specService.getCurrentSession();
				const specFolder = specService.getSpecsFolder();
				let completedContent = '# 🎉 所有任务已完成！\n\n';
				completedContent += '## 📊 最终统计\n\n';

				if (session) {
					const total = session.tasks.length;
					completedContent += `| 指标 | 值 |\n|------|----|\n`;
					completedContent += `| 总任务数 | ${total} |\n`;
					completedContent += `| 用户故事 | ${session.userStories.length} |\n`;
					completedContent += `| 完成时间 | ${new Date().toLocaleString()} |\n\n`;
				}

				if (specFolder) {
					completedContent += `## 📁 生成的文件\n\n`;
					completedContent += `规格文件已保存到: \`${specFolder.fsPath}\`\n\n`;
					completedContent += `- 📋 \`requirements.md\` - 需求规格说明\n`;
					completedContent += `- 🏗️ \`design.md\` - 技术设计文档\n`;
					completedContent += `- ✅ \`tasks.md\` - 任务执行记录\n`;
				}

				progress({
					kind: 'markdownContent',
					content: new MarkdownString(completedContent)
				});
				return;
			}

			// 显示当前任务执行状态
			const session = specService.getCurrentSession();
			if (session) {
				const completed = session.tasks.filter(t => t.status === 'completed').length;
				const total = session.tasks.length;
				const progressPercent = Math.round((completed / total) * 100);

				// 生成进度条
				const barLength = 20;
				const filledLength = Math.round((progressPercent / 100) * barLength);
				const progressBar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

				progress({
					kind: 'progressMessage',
					content: new MarkdownString(`🔄 执行任务 ${completed + 1}/${total}: **${nextTask.title}**\n\n\`[${progressBar}] ${progressPercent}%\``)
				});
			}

			const result = await specService.executeTaskWithLLM(nextTask);

			if (result.success) {
				const sessionAfter = specService.getCurrentSession();
				const completedAfter = sessionAfter?.tasks.filter(t => t.status === 'completed').length || 0;
				const totalAfter = sessionAfter?.tasks.length || 0;
				const remainingTasks = totalAfter - completedAfter;
				const progressPercentAfter = totalAfter > 0 ? Math.round((completedAfter / totalAfter) * 100) : 0;

				// 生成进度条
				const barLength = 20;
				const filledLength = Math.round((progressPercentAfter / 100) * barLength);
				const progressBar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

				let content = `## ✅ 任务完成: ${nextTask.title}\n\n`;
				content += `### 📊 进度: ${completedAfter}/${totalAfter}\n\n`;
				content += `\`\`\`\n[${progressBar}] ${progressPercentAfter}%\n\`\`\`\n\n`;
				content += `### 📝 执行结果\n\n`;
				content += result.result;
				content += '\n\n---\n';

				if (remainingTasks > 0) {
					content += `\n> 📋 还有 **${remainingTasks}** 个任务待执行。输入 "继续" 执行下一个任务。`;
				} else {
					content += '\n> 🎉 **所有任务已完成！** 规格文件已保存到 `.specs/` 目录。';
				}

				progress({
					kind: 'markdownContent',
					content: new MarkdownString(content)
				});
			} else {
				progress({
					kind: 'warning',
					content: new MarkdownString(`任务执行失败: ${result.result}`)
				});
			}
		} else {
			// 显示带可点击按钮的任务列表
			const session = specService.getCurrentSession();
			if (session) {
				const content = this.getModeSelectionCard(session) + '\n\n' + this.formatTaskListWithButtons(session);
				progress({
					kind: 'markdownContent',
					content: new MarkdownString(content, { isTrusted: true })
				});
			}
		}
	}

	// ============================================================================
	// 模式选择卡片 (Kiro 风格)
	// ============================================================================

	private getModeSelectionCard(session?: SpecSession): string {
		const hasSession = Boolean(session);
		const completed = session?.tasks.filter(t => t.status === 'completed').length || 0;
		const total = session?.tasks.length || 0;
		const pending = Math.max(0, total - completed);
		const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
		const sessionBlock = hasSession ? `
---

## 📌 Spec 工作台（同页）

| 项目 | 状态 |
|------|------|
| 会话 | \`${session?.id}\` |
| 阶段 | ${session?.phase} |
| 任务进度 | ${completed}/${total}（${progressPercent}%） |
| 待执行 | ${pending} |

> 输入 **"继续"** 可直接执行下一个任务；输入 **"执行所有"** 可并行自动执行。
` : '';

		return `# ✨ Let's build

同一个 Chat 页面内完成 **Vibe / Spec** 全流程（不再拆分多个顶部入口）。

## 💬 Vibe
- Chat first, then build
- 适合快速探索、调试、迭代实现
- 输入 \`vibe\` 切换

## 📋 Spec
- Plan first, then build
- 自动生成 requirements / design / tasks 并执行
- 输入 \`spec\` 切换
${sessionBlock}

---

> 💡 快捷：\`vibe\` / \`spec\` / \`继续\` / \`执行所有\` / \`检查完成\``;
	}

	/**
	 * 生成带可点击按钮的任务列表
	 */
	private formatTaskListWithButtons(session: SpecSession): string {
		const completed = session.tasks.filter((t: SpecTask) => t.status === 'completed').length;
		const total = session.tasks.length;
		const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

		// 进度条
		const barLength = 25;
		const filledLength = Math.round((progressPercent / 100) * barLength);
		const progressBar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

		let content = `# 📋 任务执行面板\n\n`;
		content += `## 进度: ${completed}/${total} (${progressPercent}%)\n\n`;
		content += `\`\`\`\n[${progressBar}] ${progressPercent}%\n\`\`\`\n\n`;
		content += `---\n\n`;
		content += `## 任务列表\n\n`;
		content += `| 状态 | 类型 | 任务 | 操作 |\n`;
		content += `|------|------|------|------|\n`;

		for (const task of session.tasks) {
			const statusIcon = task.status === 'completed' ? '✅' :
				task.status === 'in_progress' ? '🔄' :
				task.status === 'blocked' ? '🚫' : '⏳';

			const typeIcon = task.type === 'implementation' ? '💻' :
				task.type === 'test' ? '🧪' :
				task.type === 'documentation' ? '📝' : '👀';

			// 使用 command: 链接实现可点击按钮
			const actionBtn = task.status === 'pending'
				? `[▶ 执行](command:aicore.executeTask?${encodeURIComponent(JSON.stringify({ taskId: task.id }))})`
				: task.status === 'completed' ? '已完成' : '进行中';

			content += `| ${statusIcon} | ${typeIcon} | ${task.title} | ${actionBtn} |\n`;
		}

		content += `\n---\n\n`;
		content += `### 🎮 快捷操作\n\n`;
		content += `| 命令 | 说明 |\n`;
		content += `|------|------|\n`;
		content += `| 输入 "继续" | 执行下一个任务 |\n`;
		content += `| 输入 "执行所有" | 批量执行所有任务 |\n`;
		content += `| 输入 "检查完成" | 扫描已完成任务 |\n`;
		content += `| 输入 "保存" | 保存规格文件 |\n`;

		return content;
	}

	// ============================================================================
	// 注意：GLM 相关的核心逻辑已移至以下模块：
	// - GLMChatService: vscode/src/vs/workbench/services/aiCore/browser/glmChatService.ts
	// - ChatResponseHandler: vscode/src/vs/workbench/services/aiCore/browser/chatResponseHandler.ts
	// - ChatContextCollector: vscode/src/vs/workbench/services/aiCore/browser/chatResponseHandler.ts
	// ============================================================================

	private async doInvokeWithoutSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		const requestModel = chatWidgetService.getWidgetBySessionResource(request.sessionResource)?.viewModel?.model.getRequests().at(-1);
		if (!requestModel) {
			this.logService.error('[chat setup] Request model not found, cannot redispatch request.');
			return {}; // this should not happen
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('waitingChat', "Getting chat ready...")),
		});

		await this.forwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);

		return {};
	}

	private async forwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		try {
			await this.doForwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		} catch (error) {
			this.logService.error('[chat setup] Failed to forward request to chat', error);

			progress({
				kind: 'warning',
				content: new MarkdownString(localize('copilotUnavailableWarning', "Failed to get a response. Please try again."))
			});
		}
	}

	private async doForwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		if (this.pendingForwardedRequests.has(requestModel.session.sessionResource)) {
			throw new Error('Request already in progress');
		}

		const forwardRequest = this.doForwardRequestToChatWhenReady(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		this.pendingForwardedRequests.set(requestModel.session.sessionResource, forwardRequest);

		try {
			await forwardRequest;
		} finally {
			this.pendingForwardedRequests.delete(requestModel.session.sessionResource);
		}
	}

	private async doForwardRequestToChatWhenReady(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		const widget = chatWidgetService.getWidgetBySessionResource(requestModel.session.sessionResource);
		const modeInfo = widget?.input.currentModeInfo;

		// We need a signal to know when we can resend the request to
		// Chat. Waiting for the registration of the agent is not
		// enough, we also need a language/tools model to be available.

		let agentActivated = false;
		let agentReady = false;
		let languageModelReady = false;
		let toolsModelReady = false;

		const whenAgentActivated = this.whenAgentActivated(chatService).then(() => agentActivated = true);
		const whenAgentReady = this.whenAgentReady(chatAgentService, modeInfo?.kind)?.then(() => agentReady = true);
		const whenLanguageModelReady = this.whenLanguageModelReady(languageModelsService, requestModel.modelId)?.then(() => languageModelReady = true);
		const whenToolsModelReady = this.whenToolsModelReady(languageModelToolsService, requestModel)?.then(() => toolsModelReady = true);

		if (whenLanguageModelReady instanceof Promise || whenAgentReady instanceof Promise || whenToolsModelReady instanceof Promise) {
			const timeoutHandle = setTimeout(() => {
				progress({
					kind: 'progressMessage',
					content: new MarkdownString(localize('waitingChat2', "Chat is almost ready...")),
				});
			}, 10000);

			try {
				const ready = await Promise.race([
					timeout(this.environmentService.remoteAuthority ? 60000 /* increase for remote scenarios */ : 20000).then(() => 'timedout'),
					Promise.allSettled([
						whenAgentActivated,
						whenAgentReady,
						whenLanguageModelReady,
						whenToolsModelReady
					])
				]);

				if (ready === 'timedout') {
					let warningMessage: string;
					if (this.chatEntitlementService.anonymous) {
						warningMessage = localize('chatTookLongWarningAnonymous', "Chat took too long to get ready. Please ensure that the extension `{0}` is installed and enabled.", defaultChat.chatExtensionId);
					} else {
						warningMessage = localize('chatTookLongWarning', "Chat took too long to get ready. Please ensure you are signed in to {0} and that the extension `{1}` is installed and enabled.", defaultChat.provider.default.name, defaultChat.chatExtensionId);
					}

					this.logService.warn(warningMessage, {
						agentActivated,
						agentReady,
						languageModelReady,
						toolsModelReady
					});

					type ChatSetupTimeoutClassification = {
						owner: 'chrmarti';
						comment: 'Provides insight into chat setup timeouts.';
						agentActivated: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was activated.' };
						agentReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was ready.' };
						languageModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the language model was ready.' };
						toolsModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the tools model was ready.' };
						isRemote: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether this is a remote scenario.' };
						isAnonymous: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether anonymous access is enabled.' };
					};
					type ChatSetupTimeoutEvent = {
						agentActivated: boolean;
						agentReady: boolean;
						languageModelReady: boolean;
						toolsModelReady: boolean;
						isRemote: boolean;
						isAnonymous: boolean;
					};
					this.telemetryService.publicLog2<ChatSetupTimeoutEvent, ChatSetupTimeoutClassification>('chatSetup.timeout', {
						agentActivated,
						agentReady,
						languageModelReady,
						toolsModelReady,
						isRemote: !!this.environmentService.remoteAuthority,
						isAnonymous: this.chatEntitlementService.anonymous
					});

					progress({
						kind: 'warning',
						content: new MarkdownString(warningMessage)
					});

					progress({
						kind: 'command',
						command: {
							id: SetupAgent.CHAT_REPORT_ISSUE_WITH_OUTPUT_ID,
							title: localize('reportChatIssue', "Report Issue"),
						}
					});

					// This means Chat is unhealthy and we cannot retry the
					// request. Signal this to the outside via an event.
					this._onUnresolvableError.fire();
					return;
				}
			} finally {
				clearTimeout(timeoutHandle);
			}
		}

		await chatService.resendRequest(requestModel, {
			...widget?.getModeRequestOptions(),
			modeInfo,
			userSelectedModelId: widget?.input.currentLanguageModel
		});
	}

	private whenLanguageModelReady(languageModelsService: ILanguageModelsService, modelId: string | undefined): Promise<unknown> | void {
		const hasModelForRequest = () => {
			if (modelId) {
				return !!languageModelsService.lookupLanguageModel(modelId);
			}

			for (const id of languageModelsService.getLanguageModelIds()) {
				const model = languageModelsService.lookupLanguageModel(id);
				if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
					return true;
				}
			}

			return false;
		};

		if (hasModelForRequest()) {
			return;
		}

		return Event.toPromise(Event.filter(languageModelsService.onDidChangeLanguageModels, () => hasModelForRequest()));
	}

	private whenToolsModelReady(languageModelToolsService: ILanguageModelToolsService, requestModel: IChatRequestModel): Promise<unknown> | void {
		const needsToolsModel = requestModel.message.parts.some(part => part instanceof ChatRequestToolPart);
		if (!needsToolsModel) {
			return; // No tools in this request, no need to check
		}

		// check that tools other than setup. and internal tools are registered.
		for (const tool of languageModelToolsService.getTools()) {
			if (tool.id.startsWith('copilot_')) {
				return; // we have tools!
			}
		}

		return Event.toPromise(Event.filter(languageModelToolsService.onDidChangeTools, () => {
			for (const tool of languageModelToolsService.getTools()) {
				if (tool.id.startsWith('copilot_')) {
					return true; // we have tools!
				}
			}

			return false; // no external tools found
		}));
	}

	private whenAgentReady(chatAgentService: IChatAgentService, mode: ChatModeKind | undefined): Promise<unknown> | void {
		const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
		if (defaultAgent && !defaultAgent.isCore) {
			return; // we have a default agent from an extension!
		}

		return Event.toPromise(Event.filter(chatAgentService.onDidChangeAgents, () => {
			const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
			return Boolean(defaultAgent && !defaultAgent.isCore);
		}));
	}

	private async whenAgentActivated(chatService: IChatService): Promise<void> {
		try {
			await chatService.activateDefaultAgent(this.location);
		} catch (error) {
			this.logService.error(error);
		}
	}

	private async doInvokeWithSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: CHAT_SETUP_ACTION_ID, from: 'chat' });

		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);

		const setupListener = Event.runAndSubscribe(this.controller.value.onDidChange, (() => {
			switch (this.controller.value.step) {
				case ChatSetupStep.SigningIn:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('setupChatSignIn2', "Signing in to {0}...", ChatEntitlementRequests.providerId(this.configurationService) === defaultChat.provider.enterprise.id ? defaultChat.provider.enterprise.name : defaultChat.provider.default.name)),
					});
					break;
				case ChatSetupStep.Installing:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('installingChat', "Getting chat ready...")),
					});
					break;
			}
		}));

		let result: IChatSetupResult | undefined = undefined;
		try {
			result = await ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				disableChatViewReveal: true, 																				// we are already in a chat context
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithoutDialog : undefined	// only enable anonymous selectively
			});
		} catch (error) {
			this.logService.error(`[chat setup] Error during setup: ${toErrorMessage(error)}`);
		} finally {
			setupListener.dispose();
		}

		// User has agreed to run the setup
		if (typeof result?.success === 'boolean') {
			if (result.success) {
				if (result.dialogSkipped) {
					await widget?.clear(); // make room for the Chat welcome experience
				} else if (requestModel) {
					let newRequest = this.replaceAgentInRequestModel(requestModel, chatAgentService); 	// Replace agent part with the actual Chat agent...
					newRequest = this.replaceToolInRequestModel(newRequest); 							// ...then replace any tool parts with the actual Chat tools

					await this.forwardRequestToChat(newRequest, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
				}
			} else {
				progress({
					kind: 'warning',
					content: new MarkdownString(localize('chatSetupError', "Chat setup failed."))
				});
			}
		}

		// User has cancelled the setup
		else {
			progress({
				kind: 'markdownContent',
				content: this.workspaceTrustManagementService.isWorkspaceTrusted() ? SetupAgent.SETUP_NEEDED_MESSAGE : SetupAgent.TRUST_NEEDED_MESSAGE
			});
		}

		return {};
	}

	private replaceAgentInRequestModel(requestModel: IChatRequestModel, chatAgentService: IChatAgentService): IChatRequestModel {
		const agentPart = requestModel.message.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		if (!agentPart) {
			return requestModel;
		}

		const agentId = agentPart.agent.id.replace(/setup\./, `${defaultChat.extensionId}.`.toLowerCase());
		const githubAgent = chatAgentService.getAgent(agentId);
		if (!githubAgent) {
			return requestModel;
		}

		const newAgentPart = new ChatRequestAgentPart(agentPart.range, agentPart.editorRange, githubAgent);

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestAgentPart) {
						return newAgentPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: requestModel.variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: requestModel.attachedContext,
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}

	private replaceToolInRequestModel(requestModel: IChatRequestModel): IChatRequestModel {
		const toolPart = requestModel.message.parts.find((r): r is ChatRequestToolPart => r instanceof ChatRequestToolPart);
		if (!toolPart) {
			return requestModel;
		}

		const toolId = toolPart.toolId.replace(/setup.tools\./, `copilot_`.toLowerCase());
		const newToolPart = new ChatRequestToolPart(
			toolPart.range,
			toolPart.editorRange,
			toolPart.toolName,
			toolId,
			toolPart.displayName,
			toolPart.icon
		);

		const chatRequestToolEntry: IChatRequestToolEntry = {
			id: toolId,
			name: 'new',
			range: toolPart.range,
			kind: 'tool',
			value: undefined
		};

		const variableData: IChatRequestVariableData = {
			variables: [chatRequestToolEntry]
		};

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestToolPart) {
						return newToolPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: [chatRequestToolEntry],
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}
}

export class SetupTool implements IToolImpl {

	static registerTool(instantiationService: IInstantiationService, toolData: IToolData): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const toolService = accessor.get(ILanguageModelToolsService);

			const tool = instantiationService.createInstance(SetupTool);
			return toolService.registerTool(toolData, tool);
		});
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const result: IToolResult = {
			content: [
				{
					kind: 'text',
					value: ''
				}
			]
		};

		return result;
	}

	async prepareToolInvocation?(parameters: unknown, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

export class AINewSymbolNamesProvider {

	static registerProvider(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(AINewSymbolNamesProvider, context, controller);
			return languageFeaturesService.newSymbolNamesProvider.register('*', provider);
		});
	}

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
	}

	async provideNewSymbolNames(model: ITextModel, range: IRange, triggerKind: NewSymbolNameTriggerKind, token: CancellationToken): Promise<NewSymbolName[] | undefined> {
		await this.instantiationService.invokeFunction(accessor => {
			return ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithDialog : undefined
			});
		});

		return [];
	}
}

export class ChatCodeActionsProvider {

	static registerProvider(instantiationService: IInstantiationService): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(ChatCodeActionsProvider);
			return languageFeaturesService.codeActionProvider.register('*', provider);
		});
	}

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
	) {
	}

	async provideCodeActions(model: ITextModel, range: Range | Selection): Promise<CodeActionList | undefined> {
		const actions: CodeAction[] = [];

		// "Generate" if the line is whitespace only
		// "Modify" if there is a selection
		let generateOrModifyTitle: string | undefined;
		let generateOrModifyCommand: Command | undefined;
		if (range.isEmpty()) {
			const textAtLine = model.getLineContent(range.startLineNumber);
			if (/^\s*$/.test(textAtLine)) {
				generateOrModifyTitle = localize('generate', "Generate");
				generateOrModifyCommand = AICodeActionsHelper.generate(range);
			}
		} else {
			const textInSelection = model.getValueInRange(range);
			if (!/^\s*$/.test(textInSelection)) {
				generateOrModifyTitle = localize('modify', "Modify");
				generateOrModifyCommand = AICodeActionsHelper.modify(range);
			}
		}

		if (generateOrModifyTitle && generateOrModifyCommand) {
			actions.push({
				kind: CodeActionKind.RefactorRewrite.append('copilot').value,
				isAI: true,
				title: generateOrModifyTitle,
				command: generateOrModifyCommand,
			});
		}

		const markers = AICodeActionsHelper.warningOrErrorMarkersAtRange(this.markerService, model.uri, range);
		if (markers.length > 0) {

			// "Fix" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('fix', "Fix"),
				command: AICodeActionsHelper.fixMarkers(markers, range)
			});

			// "Explain" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('explain').append('copilot').value,
				isAI: true,
				diagnostics: markers,
				title: localize('explain', "Explain"),
				command: AICodeActionsHelper.explainMarkers(markers)
			});
		}

		return {
			actions,
			dispose() { }
		};
	}
}

export class AICodeActionsHelper {

	static warningOrErrorMarkersAtRange(markerService: IMarkerService, resource: URI, range: Range | Selection): IMarker[] {
		return markerService
			.read({ resource, severities: MarkerSeverity.Error | MarkerSeverity.Warning })
			.filter(marker => range.startLineNumber <= marker.endLineNumber && range.endLineNumber >= marker.startLineNumber);
	}

	static modify(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('modify', "Modify"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	static generate(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('generate', "Generate"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	private static rangeToSelection(range: Range): ISelection {
		return new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
	}

	static explainMarkers(markers: IMarker[]): Command {
		return {
			id: CHAT_OPEN_ACTION_ID,
			title: localize('explain', "Explain"),
			arguments: [
				{
					query: `@workspace /explain ${markers.map(marker => marker.message).join(', ')}`,
					isPartialQuery: true
				} satisfies { query: string; isPartialQuery: boolean }
			]
		};
	}

	static fixMarkers(markers: IMarker[], range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('fix', "Fix"),
			arguments: [
				{
					message: `/fix ${markers.map(marker => marker.message).join(', ')}`,
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { message: string; initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}
}
