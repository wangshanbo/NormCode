/*---------------------------------------------------------------------------------------------
 *  Contract Negotiator — Planner 生成 ADR + Evaluator 打分 + 递归修正
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { IGLMChatService, GLMMessage } from '../../services/aiCore/browser/glmChatService.js';
import { IModelRouterService, ModelTier } from '../../services/aiCore/browser/modelRouterService.js';
import { AdrRecord, NegotiationResult } from '../common/harnessTypes.js';
import { ADR_SCHEMA_JSON } from '../common/harnessConstants.js';
import { Intent } from '../common/intentTypes.js';

export const IContractNegotiatorService = createDecorator<IContractNegotiatorService>('IContractNegotiatorService');

export interface IContractNegotiatorService {
	readonly _serviceBrand: undefined;
	negotiateAdr(intent: Intent): Promise<NegotiationResult>;
}

const ADR_GENERATOR_SYSTEM = [
	'你是 Sentinel Harness 的架构决策记录（ADR）生成器。',
	'禁止输出代码或文件路径块。只输出一个 JSON 代码块，严格符合用户提供的 schema。',
	'字段含义：',
	'- logic_path: 用箭头描述底层逻辑路径，如 Event -> Middleware -> State -> View',
	'- dependency_whitelist_check: 说明将使用哪些依赖、如何与白名单核对',
	'- potential_risks: 风险',
	'- rollback_plan: 回滚步骤',
	'输出格式：仅 ```json ... ``` 一个块，内部为合法 JSON 对象。',
].join('\n');

const ADR_EVALUATOR_SYSTEM = [
	'你是 Sentinel Harness 的 ADR 评估器（Evaluator）。',
	'你只根据 ADR 是否完整覆盖「逻辑路径」与 schema 必填字段给出评分。',
	'输出格式：第一行必须为 SCORE: 0.xx  （0 到 1 的小数，保留两位）',
	'第二行起简短说明扣分原因（中文）。',
	'不要输出代码。',
].join('\n');

export class ContractNegotiatorService extends Disposable implements IContractNegotiatorService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IGLMChatService private readonly glmChatService: IGLMChatService,
		@IModelRouterService private readonly modelRouterService: IModelRouterService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async negotiateAdr(intent: Intent): Promise<NegotiationResult> {
		const maxIter = 5;
		const lastErrors: string[] = [];
		let previousAdrJson = '';
		let best: AdrRecord | undefined;
		let bestScore = 0;

		const plannerModel = this.modelRouterService.getModelByTier(ModelTier.Tier2_Balanced);
		const evaluatorModel = this.modelRouterService.getModelByTier(ModelTier.Tier3_Power);

		for (let i = 0; i < maxIter; i++) {
			const userPrompt = this.buildGeneratorUserMessage(intent, ADR_SCHEMA_JSON, previousAdrJson, lastErrors);
			const raw = await this.runLlm(
				[{ role: 'system', content: ADR_GENERATOR_SYSTEM }, { role: 'user', content: userPrompt }],
				plannerModel.id,
			);
			const adr = this.parseAdr(raw);
			if (!adr) {
				lastErrors.push('无法从模型输出解析有效 ADR JSON');
				continue;
			}
			previousAdrJson = JSON.stringify(adr, undefined, '\t');

			const structural = this.scoreStructural(adr);
			const evalScore = await this.runEvaluator(intent, adr, evaluatorModel.id);
			const combined = Math.min(1, 0.4 * structural + 0.6 * evalScore);

			this.logService.info(`[Sentinel Harness] Negotiation iter ${i + 1}: structural=${structural.toFixed(2)} eval=${evalScore.toFixed(2)} combined=${combined.toFixed(2)}`);

			if (combined > bestScore) {
				bestScore = combined;
				best = adr;
			}

			if (combined >= 0.9) {
				await this.persistAdrArtifacts(intent, adr);
				return { ok: true, score: combined, iterations: i + 1, adr, lastErrors: [] };
			}

			lastErrors.push(`第 ${i + 1} 轮综合分 ${combined.toFixed(2)} < 0.9；请补全 logic_path 与依赖说明。`);
		}

		return { ok: false, score: bestScore, iterations: maxIter, adr: best, lastErrors };
	}

	private buildGeneratorUserMessage(intent: Intent, schema: string, previous: string, errors: string[]): string {
		const parts = [
			`# Intent\n${intent.goal}\n`,
			`# IntentCard\n${JSON.stringify(intent.intentCard, undefined, 2)}`,
			`\n# JSON Schema（必须满足 required 字段）\n${schema}`,
		];
		if (previous) {
			parts.push(`\n# 上一轮 ADR（请修正）\n${previous}`);
		}
		if (errors.length > 0) {
			parts.push(`\n# 修正说明\n${errors.join('\n')}`);
		}
		return parts.join('\n');
	}

	private parseAdr(raw: string): AdrRecord | undefined {
		const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;
		try {
			const o = JSON.parse(jsonStr) as Record<string, unknown>;
			if (
				typeof o.logic_path === 'string' &&
				typeof o.dependency_whitelist_check === 'string' &&
				typeof o.potential_risks === 'string' &&
				typeof o.rollback_plan === 'string'
			) {
				return {
					logic_path: o.logic_path,
					dependency_whitelist_check: o.dependency_whitelist_check,
					potential_risks: o.potential_risks,
					rollback_plan: o.rollback_plan,
				};
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private scoreStructural(adr: AdrRecord): number {
		let s = 0;
		const w = 0.25;
		if (adr.logic_path.length >= 4 && /->|→/.test(adr.logic_path)) { s += w; }
		else if (adr.logic_path.length >= 8) { s += w * 0.7; }
		if (adr.dependency_whitelist_check.length >= 4) { s += w; }
		if (adr.potential_risks.length >= 4) { s += w; }
		if (adr.rollback_plan.length >= 4) { s += w; }
		return s;
	}

	private async runEvaluator(intent: Intent, adr: AdrRecord, modelId: string): Promise<number> {
		const user = [
			`Intent: ${intent.goal}`,
			`ADR JSON:\n${JSON.stringify(adr, undefined, 2)}`,
			'请打分：SCORE: 0.xx',
		].join('\n\n');
		const raw = await this.runLlm(
			[{ role: 'system', content: ADR_EVALUATOR_SYSTEM }, { role: 'user', content: user }],
			modelId,
		);
		const m = raw.match(/SCORE:\s*([01](?:\.\d+)?)/i);
		if (m) {
			const v = parseFloat(m[1]);
			if (!isNaN(v) && v >= 0 && v <= 1) {
				return v;
			}
		}
		return this.scoreStructural(adr);
	}

	private async runLlm(messages: GLMMessage[], modelId: string): Promise<string> {
		const cts = new CancellationTokenSource();
		const chunks: string[] = [];
		try {
			const stream = this.glmChatService.streamChat(messages, { files: [] }, { model: modelId, temperature: 0.2, maxTokens: 4096 }, cts.token);
			for await (const ev of stream) {
				if (ev.type === 'content' && ev.content) {
					chunks.push(ev.content);
				} else if (ev.type === 'error') {
					throw new Error(ev.error || 'LLM error');
				}
			}
		} finally {
			cts.dispose();
		}
		return chunks.join('').trim();
	}

	private async persistAdrArtifacts(intent: Intent, adr: AdrRecord): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			this.logService.warn('[Sentinel Harness] No workspace; skipping ADR persist');
			return;
		}
		const sentinel = URI.joinPath(root, '.sentinel');
		const schemas = URI.joinPath(sentinel, 'schemas');
		const md = URI.joinPath(sentinel, 'ARCH_DECISION_RECORD.md');
		const schemaFile = URI.joinPath(schemas, 'adr.schema.json');
		const signoff = URI.joinPath(sentinel, 'adr_signoff.json');

		await this.fileService.createFolder(sentinel);
		await this.fileService.createFolder(schemas);

		const body = [
			'# Architecture Decision Record',
			'',
			`> Intent: ${intent.title}`,
			'',
			'## ADR (JSON)',
			'',
			'```json',
			JSON.stringify(adr, undefined, '\t'),
			'```',
			'',
		].join('\n');

		await this.fileService.writeFile(md, VSBuffer.fromString(body));
		await this.fileService.writeFile(schemaFile, VSBuffer.fromString(ADR_SCHEMA_JSON));
		await this.fileService.writeFile(
			signoff,
			VSBuffer.fromString(JSON.stringify({
				approved: true,
				by: 'contract_negotiator',
				at: Date.now(),
				intentId: intent.id,
				scoreGate: '>=0.9',
			}, undefined, '\t')),
		);
		this.logService.info('[Sentinel Harness] ADR + signoff written under .sentinel/');
	}
}

registerSingleton(IContractNegotiatorService, ContractNegotiatorService, InstantiationType.Delayed);
