/*---------------------------------------------------------------------------------------------
 *  Implementation Plan — Spec-First 硬闸门（M2 P4-4）
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
import { ImplementationPlanRecord, PlanNegotiationResult } from '../common/harnessTypes.js';
import { Intent } from '../common/intentTypes.js';

export const IImplementationPlanService = createDecorator<IImplementationPlanService>('IImplementationPlanService');

export interface IImplementationPlanService {
	readonly _serviceBrand: undefined;
	negotiatePlan(intent: Intent): Promise<PlanNegotiationResult>;
}

const PLAN_SYSTEM = [
	'你是 Sentinel 的 Implementation Plan 生成器。',
	'只输出一个 ```json 代码块，对象字段：',
	'title (string), steps (string[]), acceptance_criteria (string[]), non_goals (string[]), risks (string[])',
	'steps 至少 2 条，acceptance_criteria 至少 2 条。不要输出代码。',
].join('\n');

export class ImplementationPlanService extends Disposable implements IImplementationPlanService {
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

	async negotiatePlan(intent: Intent): Promise<PlanNegotiationResult> {
		const maxIter = 4;
		const lastErrors: string[] = [];
		let best: ImplementationPlanRecord | undefined;
		let bestScore = 0;
		const model = this.modelRouterService.getModelByTier(ModelTier.Tier2_Balanced);

		for (let i = 0; i < maxIter; i++) {
			const user = [
				`Intent: ${intent.goal}`,
				`IntentCard: ${JSON.stringify(intent.intentCard, undefined, 2)}`,
				lastErrors.length ? `修正: ${lastErrors.join('\n')}` : '',
			].filter(Boolean).join('\n\n');

			const raw = await this.runLlm(
				[{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: user }],
				model.id,
			);
			const plan = this.parsePlan(raw);
			if (!plan) {
				lastErrors.push('无法解析 Implementation Plan JSON');
				continue;
			}
			const score = this.scorePlan(plan);
			if (score > bestScore) {
				bestScore = score;
				best = plan;
			}
			if (score >= 0.85) {
				await this.persistPlan(intent, plan);
				return { ok: true, score, plan, lastErrors: [] };
			}
			lastErrors.push(`第 ${i + 1} 轮得分 ${score.toFixed(2)} < 0.85`);
		}
		return { ok: false, score: bestScore, plan: best, lastErrors };
	}

	private parsePlan(raw: string): ImplementationPlanRecord | undefined {
		const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
		const jsonStr = m ? m[1].trim() : raw;
		try {
			const o = JSON.parse(jsonStr) as Record<string, unknown>;
			if (
				typeof o.title === 'string' &&
				Array.isArray(o.steps) &&
				Array.isArray(o.acceptance_criteria)
			) {
				return {
					title: o.title,
					steps: o.steps.map(String),
					acceptance_criteria: o.acceptance_criteria.map(String),
					non_goals: Array.isArray(o.non_goals) ? o.non_goals.map(String) : [],
					risks: Array.isArray(o.risks) ? o.risks.map(String) : [],
				};
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private scorePlan(plan: ImplementationPlanRecord): number {
		let s = 0;
		if (plan.title.length > 2) { s += 0.15; }
		if (plan.steps.length >= 2) { s += 0.35; }
		else if (plan.steps.length >= 1) { s += 0.2; }
		if (plan.acceptance_criteria.length >= 2) { s += 0.35; }
		else if (plan.acceptance_criteria.length >= 1) { s += 0.2; }
		if (plan.non_goals.length > 0) { s += 0.075; }
		if (plan.risks.length > 0) { s += 0.075; }
		return Math.min(1, s);
	}

	private async runLlm(messages: GLMMessage[], modelId: string): Promise<string> {
		const cts = new CancellationTokenSource();
		const chunks: string[] = [];
		try {
			const stream = this.glmChatService.streamChat(messages, { files: [] }, { model: modelId, temperature: 0.25, maxTokens: 4096 }, cts.token);
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

	private async persistPlan(intent: Intent, plan: ImplementationPlanRecord): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const dir = URI.joinPath(root, '.sentinel');
		await this.fileService.createFolder(dir);
		const uri = URI.joinPath(dir, 'IMPLEMENTATION_PLAN.json');
		const body = JSON.stringify({ ...plan, intentId: intent.id, updatedAt: Date.now() }, undefined, '\t');
		await this.fileService.writeFile(uri, VSBuffer.fromString(body));
		this.logService.info('[Sentinel] IMPLEMENTATION_PLAN.json written');
	}
}

registerSingleton(IImplementationPlanService, ImplementationPlanService, InstantiationType.Delayed);
