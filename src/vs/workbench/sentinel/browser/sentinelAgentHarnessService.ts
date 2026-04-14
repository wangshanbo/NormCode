/*---------------------------------------------------------------------------------------------
 *  Sentinel Agent Harness — Implementer 工具循环（对齐 Anthropic Agent SDK 范式）
 *  使用 GLM completeChatTurn + AgentToolService 多轮直到无 tool_calls
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IGLMChatService, GLMMessage, GLMToolDefinition } from '../../services/aiCore/browser/glmChatService.js';
import { IAgentToolService } from '../../services/aiCore/browser/agentToolService.js';
import type { ResolvedHarnessConfig } from './harnessConfigService.js';
import { ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { RoutingDecision } from '../common/workerTypes.js';

export const ISentinelAgentHarnessService = createDecorator<ISentinelAgentHarnessService>('sentinelAgentHarnessService');

export interface ISentinelAgentHarnessService {
	readonly _serviceBrand: undefined;
	/** 若配置开启且为 Implementer，则走工具循环；否则返回 undefined 由调用方回退 */
	runImplementerAgentLoopIfEnabled(
		intent: Intent,
		node: ExecutionNode,
		routing: RoutingDecision,
		baseSystemPrompt: string,
		userContent: string,
		harness: ResolvedHarnessConfig,
	): Promise<string | undefined>;
	/** Verifier + 工具循环（read_file / run_command / mcp_call 等） */
	runVerifierAgentLoopIfEnabled(
		intent: Intent,
		node: ExecutionNode,
		routing: RoutingDecision,
		baseSystemPrompt: string,
		userContent: string,
		harness: ResolvedHarnessConfig,
	): Promise<string | undefined>;
	/** 失败/验证阻塞后的自动修复：工具循环 + 联网（不依赖 Implementer 节点是否走工具环） */
	runRepairAgentLoop(
		intent: Intent,
		node: ExecutionNode,
		routing: RoutingDecision,
		baseSystemPrompt: string,
		userContent: string,
		harness: ResolvedHarnessConfig,
	): Promise<string | undefined>;
}

const AGENT_IMPLEMENTER_SUPPLEMENT = [
	'',
	'【工具优先】你是带工具的编码 Agent，对齐 Anthropic 长程 harness：',
	'- 优先使用 write_file / read_file / list_dir / grep_search / run_command / get_diagnostics 完成实现；不要只靠一段 markdown 代码块。',
	'- 每轮尽量增量：先读 .sentinel/feature_registry.json 与进度日志（若存在），再改最少必要文件。',
	'- run_command 会在集成终端执行；用于 npm install、npm test、启动静态服务器等。',
	'- 全部工具调用结束后，用纯文本简要总结改了哪些文件；若仍有文件必须用 ### FILE 格式补充，可附在末尾。',
].join('\n');

const AGENT_REPAIR_SUPPLEMENT = [
	'',
	'【自动修复 Agent】上一阶段报错或验证未通过：',
	'- 必须用工具实际改代码/配置：write_file、read_file、list_dir、grep_search、run_command、get_diagnostics。',
	'- 需要查文档、Issue、兼容性说明时：使用 web_search_deep、browse_url；不要凭空编造 API。',
	'- 浏览器/E2E 相关：在 allowlist 允许时用 mcp_call 驱动浏览器类 MCP。',
	'- 禁止向用户提问；在轮次与 token 限制内尽量收敛到可再通过验证门禁。',
	'- 结束前用简短文字列出改了哪些路径与依据（可引用检索来源）。',
].join('\n');

const AGENT_VERIFIER_SUPPLEMENT = [
	'',
	'【Verifier 工具循环】你是 Evaluator，须用工具验证而非仅凭上文摘要：',
	'- 使用 read_file / grep_search / list_dir / get_diagnostics 核对实现与门禁。',
	'- **外链与多媒体（强制）**：用 grep_search 或 read_file 收集所有 `http(s)://...` 与常见图片/CSS/字体 URL；对 **每条** 远程资源用 `run_command` 执行 `curl -sI -L -m 12 "<URL>"`（或等效）记录 HTTP 状态；**任一关键配图/脚本/CDN 返回 4xx/5xx 或超时 → 必须 BLOCK**，并在证据中列出 URL 与状态码。禁止仅凭「看起来对」放行。',
	'- **页面实测**：Web 应用须在本地起服务后，用 mcp_call 浏览器或 browse_url 打开入口页，核对控制台无致命报错、首屏资源加载失败须在证据中写明。',
	'- 需要浏览器 E2E 时：`.sentinel/mcp_allowlist.json` 通常已由内核自动创建；用 mcp_call 调用白名单内 server_id（如 cursor-ide-browser 的 browser_navigate / browser_snapshot 等）。若未找到 server，可在白名单 definitions 中补充启动配置或依赖 IDE 内置 MCP。',
	'- 可用 run_command 跑 npm test / lint / 本地静态服务；不要编造未执行的检查结果。',
	'- 工具结束后输出固定格式：## 最终裁定：[PASS / BLOCK]、## 证据摘要（须含外链探测表：URL→状态）、## 未解决风险、## 建议。',
].join('\n');

/** 工具环疑似空转时注入，促使模型联网或换路径（冗余设计，避免死循环只靠同一工具） */
const STALL_USER_NUDGE_ZH =
	'【系统】检测到工具轮次已较深或连续多轮结果高度重复，可能陷入局部循环。请优先使用 web_search_deep / browse_url 查阅文档或同类错误，或换一个实现假设；仍需用工具落地修改，勿空泛回答。';

export class SentinelAgentHarnessService extends Disposable implements ISentinelAgentHarnessService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IGLMChatService private readonly glmChatService: IGLMChatService,
		@IAgentToolService private readonly agentToolService: IAgentToolService,
	) {
		super();
	}

	private digestToolRound(
		toolCalls: Array<{ function?: { name?: string } }>,
		outputs: string[],
	): string {
		return toolCalls
			.map((tc, j) => `${tc.function?.name ?? '?'}:${(outputs[j] ?? '').slice(0, 120)}`)
			.join('§');
	}

	/** 连续 3 轮工具摘要完全一致 → 视为卡死风险 */
	private isTripleRepeatDigest(digests: string[]): boolean {
		if (digests.length < 3) {
			return false;
		}
		const a = digests[digests.length - 1];
		if (a.length < 24) {
			return false;
		}
		return digests[digests.length - 2] === a && digests[digests.length - 3] === a;
	}

	/**
	 * 统一工具循环：全程 enableThinking；联网在 repair 模式常开，否则进入后半程或卡死检测后打开。
	 */
	private async runBoundedToolLoop(
		routing: RoutingDecision,
		harness: ResolvedHarnessConfig,
		systemPrompt: string,
		userContent: string,
		cts: CancellationTokenSource,
		opts: { maxIterations: number; temperature: number; repairMode: boolean; logTag: string },
	): Promise<string> {
		const tools = this.agentToolService.getToolsForGLM() as GLMToolDefinition[];
		const messages: GLMMessage[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userContent },
		];
		const recentDigests: string[] = [];
		let stallHintSent = false;
		const transcript: string[] = [];
		const { maxIterations, temperature, repairMode, logTag } = opts;

		for (let i = 0; i < maxIterations; i++) {
			if (cts.token.isCancellationRequested) {
				break;
			}
			const stuck = this.isTripleRepeatDigest(recentDigests);
			const late = !repairMode && i >= Math.max(5, Math.floor(maxIterations * 0.45));
			if ((stuck || late) && !stallHintSent) {
				stallHintSent = true;
				messages.push({ role: 'user', content: STALL_USER_NUDGE_ZH });
			}
			const enableWebSearch = repairMode || late || stuck;
			this.logService.info(`[SentinelAgentHarness] ${logTag} turn=${i}/${maxIterations} web=${enableWebSearch} stuck=${stuck}`);

			const completion = await this.glmChatService.completeChatTurn(
				messages,
				{ files: [] },
				{
					model: routing.modelId,
					temperature,
					maxTokens: harness.agentToolMaxTokensPerTurn ?? 16384,
					enableThinking: true,
					enableWebSearch,
					tools,
				},
				cts.token,
			);

			const toolCalls = completion.tool_calls?.filter(tc => tc?.function?.name);
			if (!toolCalls || toolCalls.length === 0) {
				const tail = (completion.content || '').trim();
				if (tail) {
					transcript.push(tail);
				}
				break;
			}

			messages.push({
				role: 'assistant',
				content: completion.content || '',
				tool_calls: toolCalls,
			});

			const outs: string[] = [];
			for (const tc of toolCalls) {
				const name = tc.function?.name || '';
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
				} catch {
					args = {};
				}
				this.logService.info(`[SentinelAgentHarness] ${logTag} tool #${i} ${name}`);
				const result = await this.agentToolService.executeTool(name, args);
				const out = result.success
					? (result.output || JSON.stringify(result.data ?? {}) || 'ok')
					: `Error: ${result.error || 'unknown'}`;
				outs.push(out.slice(0, 400));
				messages.push({
					role: 'tool',
					tool_call_id: tc.id,
					content: out.slice(0, 120000),
				});
			}
			recentDigests.push(this.digestToolRound(toolCalls, outs));
			if (recentDigests.length > 8) {
				recentDigests.shift();
			}
		}

		return transcript.join('\n\n---\n\n');
	}

	async runImplementerAgentLoopIfEnabled(
		intent: Intent,
		node: ExecutionNode,
		routing: RoutingDecision,
		baseSystemPrompt: string,
		userContent: string,
		harness: ResolvedHarnessConfig,
	): Promise<string | undefined> {
		if (!harness.enabled || !harness.implementerAgentToolLoop) {
			return undefined;
		}

		const prevMode = this.agentToolService.getExecutionMode();
		this.agentToolService.setExecutionMode('autopilot');
		const cts = new CancellationTokenSource();
		const maxIterations = harness.agentToolMaxIterations ?? 24;

		try {
			const systemPrompt = `${baseSystemPrompt}${AGENT_IMPLEMENTER_SUPPLEMENT}`;
			const output = await this.runBoundedToolLoop(
				routing,
				harness,
				systemPrompt,
				userContent,
				cts,
				{ maxIterations, temperature: 0.45, repairMode: false, logTag: 'implementer' },
			);
			this.logService.info(`[SentinelAgentHarness] completed, transcript length=${output.length}`);
			return output || '（Agent 工具循环结束，请查看工作区文件变更与终端）';
		} catch (e) {
			this.logService.error(`[SentinelAgentHarness] ${String(e)}`);
			return `Agent 工具循环失败：${String(e)}`;
		} finally {
			this.agentToolService.setExecutionMode(prevMode);
			cts.dispose();
		}
	}

	async runVerifierAgentLoopIfEnabled(
		intent: Intent,
		node: ExecutionNode,
		routing: RoutingDecision,
		baseSystemPrompt: string,
		userContent: string,
		harness: ResolvedHarnessConfig,
	): Promise<string | undefined> {
		if (!harness.enabled || !harness.verifierAgentToolLoop) {
			return undefined;
		}

		const prevMode = this.agentToolService.getExecutionMode();
		this.agentToolService.setExecutionMode('autopilot');
		const cts = new CancellationTokenSource();
		const maxIterations = Math.min(harness.agentToolMaxIterations ?? 24, 32);

		try {
			const systemPrompt = `${baseSystemPrompt}${AGENT_VERIFIER_SUPPLEMENT}`;
			const output = await this.runBoundedToolLoop(
				routing,
				harness,
				systemPrompt,
				userContent,
				cts,
				{ maxIterations, temperature: 0.25, repairMode: false, logTag: 'verifier' },
			);
			this.logService.info(`[SentinelAgentHarness] Verifier loop done, length=${output.length}`);
			return output || '（Verifier 工具循环结束，请结合工作区与 MCP 输出核对）';
		} catch (e) {
			this.logService.error(`[SentinelAgentHarness] Verifier loop ${String(e)}`);
			return `Verifier 工具循环失败：${String(e)}`;
		} finally {
			this.agentToolService.setExecutionMode(prevMode);
			cts.dispose();
		}
	}

	async runRepairAgentLoop(
		intent: Intent,
		node: ExecutionNode,
		routing: RoutingDecision,
		baseSystemPrompt: string,
		userContent: string,
		harness: ResolvedHarnessConfig,
	): Promise<string | undefined> {
		if (!harness.enabled || !harness.autoRepairOnFailure) {
			return undefined;
		}

		const prevMode = this.agentToolService.getExecutionMode();
		this.agentToolService.setExecutionMode('autopilot');
		const cts = new CancellationTokenSource();
		const maxIterations = harness.agentRepairMaxIterations ?? harness.agentToolMaxIterations ?? 24;

		try {
			const systemPrompt = `${baseSystemPrompt}${AGENT_REPAIR_SUPPLEMENT}`;
			const output = await this.runBoundedToolLoop(
				routing,
				harness,
				systemPrompt,
				userContent,
				cts,
				{ maxIterations, temperature: 0.35, repairMode: true, logTag: 'repair' },
			);
			this.logService.info(`[SentinelAgentHarness] repair loop done, length=${output.length}`);
			return output || '（自动修复工具循环结束）';
		} catch (e) {
			this.logService.error(`[SentinelAgentHarness] repair ${String(e)}`);
			return `自动修复失败：${String(e)}`;
		} finally {
			this.agentToolService.setExecutionMode(prevMode);
			cts.dispose();
		}
	}
}

registerSingleton(ISentinelAgentHarnessService, SentinelAgentHarnessService, InstantiationType.Delayed);
