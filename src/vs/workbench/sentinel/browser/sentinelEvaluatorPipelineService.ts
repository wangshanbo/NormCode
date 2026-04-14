/*---------------------------------------------------------------------------------------------
 *  HGT-026：独立 Evaluator + Playwright 报告合入验证包（与 Generator/Verifier 工具环分离的评分步）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IGLMChatService } from '../../services/aiCore/browser/glmChatService.js';
import { IModelRouterService, ModelTier } from '../../services/aiCore/browser/modelRouterService.js';
import type { ResolvedHarnessConfig } from './harnessConfigService.js';
import { ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { VerificationBundle } from '../common/verificationTypes.js';

export const ISentinelEvaluatorPipelineService = createDecorator<ISentinelEvaluatorPipelineService>('sentinelEvaluatorPipelineService');

export interface ISentinelEvaluatorPipelineService {
	readonly _serviceBrand: undefined;
	enrichVerifyBundle(
		intent: Intent,
		node: ExecutionNode,
		bundle: VerificationBundle,
		harness: ResolvedHarnessConfig,
	): Promise<VerificationBundle>;
}

const REPORT_REL = '.sentinel/last_playwright_report.json';

const INDEPENDENT_EVALUATOR_SYSTEM = [
	'你是 Sentinel-IDE 的 **独立 Evaluator**（与写代码的 Generator 分离）。',
	'你只根据 **Playwright JSON 报告** 与 **rubric** 做判断，不得编造报告中不存在的用例结果。',
	'输出 **仅** 一段 JSON（不要 markdown 围栏），格式：',
	'{"pass":true|false,"scores":[{"id":"维度或用例","score":0到1}],"rationale":"一句话理由"}',
	'若报告无法解析或缺少 stats，pass 应为 false。',
].join('\n');

export class SentinelEvaluatorPipelineService extends Disposable implements ISentinelEvaluatorPipelineService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IGLMChatService private readonly glmChatService: IGLMChatService,
		@IModelRouterService private readonly modelRouterService: IModelRouterService,
	) {
		super();
	}

	async enrichVerifyBundle(
		intent: Intent,
		node: ExecutionNode,
		bundle: VerificationBundle,
		harness: ResolvedHarnessConfig,
	): Promise<VerificationBundle> {
		if (!harness.enabled || !harness.evaluatorPipelineEnabled || node.type !== 'verify') {
			return bundle;
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return bundle;
		}
		const root = folder.uri;
		const sub = harness.evaluatorPlaywrightDir.replace(/\\/g, '/').replace(/^\//, '');
		const pwRoot = URI.joinPath(root, sub);

		const hasConfig =
			(await this.fileService.exists(URI.joinPath(pwRoot, 'playwright.config.ts'))) ||
			(await this.fileService.exists(URI.joinPath(pwRoot, 'playwright.config.mts'))) ||
			(await this.fileService.exists(URI.joinPath(pwRoot, 'playwright.config.js'))) ||
			(await this.fileService.exists(URI.joinPath(pwRoot, 'playwright.config.mjs')));
		if (!hasConfig) {
			this.logService.warn(`[EvaluatorPipeline] 未找到 ${sub}/playwright.config.*，跳过 E2E`);
			const ev = bundle.evidence;
			return {
				...bundle,
				evidence: [
					...ev,
					{
						id: `evidence_evaluator_skip_${Date.now()}`,
						kind: 'trace' as const,
						summary: `Evaluator 流水线已跳过：未在 ${sub} 下发现 playwright.config（见文档模板）`,
						createdAt: Date.now(),
					},
				],
				evaluatorPipeline: {
					playwrightRan: false,
					llmRan: false,
					skipReason: 'no_playwright_config',
				},
				updatedAt: Date.now(),
			};
		}

		let native: INativeHostService | undefined;
		try {
			native = this.instantiationService.invokeFunction(accessor => accessor.get(INativeHostService));
		} catch {
			native = undefined;
		}
		if (!native) {
			this.logService.warn('[EvaluatorPipeline] 无 INativeHostService（非 Electron ？），无法执行 npx playwright');
			return {
				...bundle,
				evidence: [
					...bundle.evidence,
					{
						id: `evidence_evaluator_no_native_${Date.now()}`,
						kind: 'trace' as const,
						summary: 'Evaluator：当前环境无法执行 Playwright CLI（需桌面端）',
						createdAt: Date.now(),
					},
				],
				evaluatorPipeline: { playwrightRan: false, llmRan: false, skipReason: 'no_native_host' },
				updatedAt: Date.now(),
			};
		}

		const cwd = pwRoot.fsPath.replace(/\\/g, '/');
		const cmd =
			process.platform === 'win32'
				? 'npx.cmd playwright test --reporter=json'
				: 'npx playwright test --reporter=json';

		let pwOut = '';
		let exitCode = 1;
		try {
			const r = await native.runAgentToolShellCommand({ cwd, command: cmd });
			exitCode = r.exitCode;
			pwOut = (r.stdout || '').slice(0, 1_200_000);
			if (!pwOut.trim() && r.stderr) {
				pwOut = r.stderr.slice(0, 200_000);
			}
		} catch (e) {
			this.logService.error(`[EvaluatorPipeline] playwright spawn failed: ${String(e)}`);
			pwOut = String(e);
		}

		const reportUri = URI.joinPath(root, REPORT_REL.replace(/^\//, ''));
		try {
			await this.fileService.createFolder(URI.joinPath(root, '.sentinel'));
			await this.fileService.writeFile(reportUri, VSBuffer.fromString(pwOut.slice(0, 500_000)));
		} catch (e) {
			this.logService.warn(`[EvaluatorPipeline] write report file: ${String(e)}`);
		}

		const pwStats = this.tryParsePlaywrightStats(pwOut);
		const playwrightOk =
			pwStats !== undefined ? pwStats.unexpected === 0 && (pwStats.flaky === undefined || pwStats.flaky === 0) : exitCode === 0;

		let llmPass: boolean | undefined;
		let llmSummary = '';
		let llmRan = false;

		if (harness.evaluatorIndependentLlmEnabled) {
			llmRan = true;
			const rubricPath = harness.evaluatorRubricPath.replace(/^\//, '');
			let rubricText = '';
			try {
				rubricText = (await this.fileService.readFile(URI.joinPath(root, rubricPath))).value.toString();
			} catch {
				rubricText = '（rubric 文件不可读）';
			}
			const fast = this.modelRouterService.getModelByTier(ModelTier.Tier1_Fast);
			const userPayload = [
				`Intent: ${intent.title}`,
				`Node: ${node.title}`,
				`--- RUBRIC ---\n${rubricText.slice(0, 12_000)}`,
				`--- PLAYWRIGHT JSON (stdout) ---\n${pwOut.slice(0, 100_000)}`,
			].join('\n\n');

			try {
				const msg = await this.glmChatService.completeChatTurn(
					[
						{ role: 'system', content: INDEPENDENT_EVALUATOR_SYSTEM },
						{ role: 'user', content: userPayload },
					],
					{ files: [] },
					{
						model: fast.id,
						temperature: 0.1,
						maxTokens: 2048,
						enableThinking: false,
						enableWebSearch: false,
					},
				);
				const raw = (msg.content ?? '').trim();
				llmSummary = raw.slice(0, 8000);
				const parsed = this.tryParseJsonObject(raw);
				if (parsed && typeof parsed.pass === 'boolean') {
					llmPass = parsed.pass;
				}
			} catch (e) {
				llmSummary = `Evaluator LLM 失败：${String(e)}`;
				this.logService.warn(`[EvaluatorPipeline] LLM: ${String(e)}`);
			}
		}

		const blockFromPw = harness.evaluatorPlaywrightBlocksVerify && !playwrightOk;
		const blockFromLlm =
			harness.evaluatorLlmBlocksOnNegative && llmRan && llmPass === false;

		let overallStatus = bundle.overallStatus;
		let blockingIssues = [...bundle.blockingIssues];
		let summary = bundle.summary;

		if (blockFromPw || blockFromLlm) {
			overallStatus = 'blocked';
			blockingIssues.push(`evaluator_pipeline_${Date.now()}`);
			const parts: string[] = [];
			if (blockFromPw) {
				parts.push(`Playwright E2E 未通过（exit=${exitCode}，unexpected=${pwStats?.unexpected ?? '?'})`);
			}
			if (blockFromLlm) {
				parts.push('独立 Evaluator LLM 判定不通过');
			}
			summary = `${summary}\n\n[HGT-026 Evaluator] ${parts.join('；')}`;
		}

		const evidence = [
			...bundle.evidence,
			{
				id: `evidence_evaluator_pw_${Date.now()}`,
				kind: 'trace' as const,
				summary: `Playwright: ok=${playwrightOk} exit=${exitCode} unexpected=${pwStats?.unexpected ?? 'n/a'} → ${REPORT_REL}`,
				createdAt: Date.now(),
			},
		];
		if (llmRan) {
			evidence.push({
				id: `evidence_evaluator_llm_${Date.now()}`,
				kind: 'trace' as const,
				summary: `独立 Evaluator LLM: pass=${llmPass ?? 'unknown'} ${llmSummary.slice(0, 400)}`,
				createdAt: Date.now(),
			});
		}

		return {
			...bundle,
			overallStatus,
			blockingIssues,
			summary,
			evidence,
			evaluatorPipeline: {
				playwrightRan: true,
				playwrightOk,
				playwrightExitCode: exitCode,
				reportRelPath: REPORT_REL,
				llmRan,
				llmPass,
				llmSummary: llmSummary.slice(0, 4000),
			},
			updatedAt: Date.now(),
		};
	}

	private tryParsePlaywrightStats(jsonText: string): { unexpected: number; flaky?: number } | undefined {
		const t = jsonText.trim();
		if (!t.startsWith('{')) {
			const idx = t.indexOf('{');
			if (idx === -1) {
				return undefined;
			}
			return this.tryParsePlaywrightStats(t.slice(idx));
		}
		try {
			const o = JSON.parse(t) as { stats?: { unexpected?: number; flaky?: number } };
			if (o.stats && typeof o.stats.unexpected === 'number') {
				return { unexpected: o.stats.unexpected, flaky: o.stats.flaky };
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private tryParseJsonObject(text: string): { pass?: boolean } | undefined {
		const m = text.match(/\{[\s\S]*\}/);
		if (!m) {
			return undefined;
		}
		try {
			return JSON.parse(m[0]) as { pass?: boolean };
		} catch {
			return undefined;
		}
	}
}

registerSingleton(ISentinelEvaluatorPipelineService, SentinelEvaluatorPipelineService, InstantiationType.Delayed);
