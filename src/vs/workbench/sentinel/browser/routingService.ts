/*---------------------------------------------------------------------------------------------
 *  Sentinel Routing Service
 *  智能路由 — CodeGraph 指标接入 TCI / 升级链路日志 / 失败自动升级
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IModelRouterService, ModelTier } from '../../services/aiCore/browser/modelRouterService.js';
import { ICodeGraphService } from '../../services/aiCore/browser/codeGraphService.js';
import { ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { CostLedger, CostRecord, RoutingDecision, WorkerRole, WorkerTier } from '../common/workerTypes.js';

export const IRoutingService = createDecorator<IRoutingService>('IRoutingService');

export interface EscalationLogEntry {
	id: string;
	intentId: string;
	nodeId: string;
	fromTier: WorkerTier;
	toTier: WorkerTier;
	reason: string;
	failureLog: string;
	timestamp: number;
}

export interface RoutingRouteOptions {
	/** HGT-010：超软预算时强制降级 tier（不升 estimatedTokens，避免与账本双重计数冲突） */
	budgetDegrade?: boolean;
}

export interface IRoutingService {
	readonly _serviceBrand: undefined;
	route(intent: Intent, node: ExecutionNode, options?: RoutingRouteOptions): RoutingDecision;
	escalateOnFailure(intent: Intent, node: ExecutionNode, failureLog: string, previousDecision: RoutingDecision): RoutingDecision | undefined;
	getCostLedger(): CostLedger;
	getEscalationLog(): EscalationLogEntry[];
	hydrateCostLedger(ledger: CostLedger): void;
}

export class RoutingService extends Disposable implements IRoutingService {
	readonly _serviceBrand: undefined;

	private readonly ledger: CostLedger = {
		totalCost: 0,
		totalTokens: 0,
		records: [],
	};

	private readonly escalationLog: EscalationLogEntry[] = [];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IModelRouterService private readonly modelRouterService: IModelRouterService,
		@ICodeGraphService _codeGraphService: ICodeGraphService,
	) {
		super();
	}

	route(intent: Intent, node: ExecutionNode, options?: RoutingRouteOptions): RoutingDecision {
		let tier = this.selectTier(intent, node);
		if (options?.budgetDegrade) {
			const before = tier;
			tier = this.downgradeTier(tier);
			if (before !== tier) {
				this.logService.info(`[Sentinel Routing] HGT-010 budget degrade: ${before} → ${tier} (${node.id})`);
			}
		}
		const modelTier = tier === 'power' ? ModelTier.Tier3_Power
			: tier === 'balanced' ? ModelTier.Tier2_Balanced
				: ModelTier.Tier1_Fast;
		const model = this.modelRouterService.getModelByTier(modelTier);

		const estimatedTokens = tier === 'power' ? 6000 : tier === 'balanced' ? 4000 : 2000;

		const decision: RoutingDecision = {
			id: `routing_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			role: node.workerRole,
			modelId: model.id,
			tier,
			reason: this.buildRoutingReason(intent, node, tier),
			estimatedTokens,
			estimatedCost: (estimatedTokens / 1000) * model.costPer1kTokens,
			createdAt: Date.now(),
		};

		const costRecord: CostRecord = {
			id: `cost_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			modelId: decision.modelId,
			tier,
			inputTokens: Math.round(decision.estimatedTokens * 0.6),
			outputTokens: Math.round(decision.estimatedTokens * 0.4),
			cost: decision.estimatedCost,
			createdAt: Date.now(),
		};
		this.ledger.records.push(costRecord);
		this.ledger.totalCost += costRecord.cost;
		this.ledger.totalTokens += costRecord.inputTokens + costRecord.outputTokens;

		this.logService.info(`[Sentinel Routing] ${node.id} → ${model.id} (tier=${tier}, role=${node.workerRole})`);

		return decision;
	}

	private downgradeTier(t: WorkerTier): WorkerTier {
		if (t === 'power') {
			return 'balanced';
		}
		return 'fast';
	}

	private selectTier(intent: Intent, node: ExecutionNode): WorkerTier {
		const role = node.workerRole;
		const isHighRisk = intent.riskLevel === 'critical' || intent.riskLevel === 'high';

		const powerRoles = [WorkerRole.Analyst, WorkerRole.Planner, WorkerRole.Reviewer, WorkerRole.Verifier];
		if (powerRoles.includes(role as WorkerRole)) {
			return 'power';
		}

		if (role === WorkerRole.Implementer) {
			return isHighRisk ? 'power' : 'balanced';
		}

		if (role === WorkerRole.Tester) {
			return 'balanced';
		}

		if (role === WorkerRole.Refiner) {
			return isHighRisk ? 'balanced' : 'fast';
		}

		return isHighRisk ? 'power' : 'balanced';
	}

	private buildRoutingReason(intent: Intent, node: ExecutionNode, tier: WorkerTier): string {
		const risk = intent.riskLevel || 'low';
		return `风险=${risk}, 角色=${node.workerRole} → 分层路由至 ${tier}`;
	}

	escalateOnFailure(
		intent: Intent,
		node: ExecutionNode,
		failureLog: string,
		previousDecision: RoutingDecision,
	): RoutingDecision | undefined {
		const tierOrder: WorkerTier[] = ['fast', 'balanced', 'power'];
		const currentIdx = tierOrder.indexOf(previousDecision.tier);

		if (currentIdx >= tierOrder.length - 1) {
			this.logService.warn(`[Sentinel Routing] Already at highest tier (power), cannot escalate for node ${node.id}`);
			return undefined;
		}

		const nextTier = tierOrder[currentIdx + 1];
		const modelTier = nextTier === 'power' ? ModelTier.Tier3_Power : ModelTier.Tier2_Balanced;
		const model = this.modelRouterService.getModelByTier(modelTier);

		const entry: EscalationLogEntry = {
			id: `esc_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			fromTier: previousDecision.tier,
			toTier: nextTier,
			reason: `Tier ${previousDecision.tier} 执行失败，升级至 ${nextTier}`,
			failureLog: failureLog.slice(0, 2000),
			timestamp: Date.now(),
		};
		this.escalationLog.push(entry);

		this.logService.info(`[Sentinel Routing] ESCALATION: ${node.id} ${previousDecision.tier} → ${nextTier} | ${entry.reason}`);

		this.modelRouterService.escalate(
			`${intent.id}_${node.id}`,
			previousDecision.tier === 'fast' ? ModelTier.Tier1_Fast : ModelTier.Tier2_Balanced,
			failureLog,
		);

		const decision: RoutingDecision = {
			id: `routing_esc_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			role: node.workerRole,
			modelId: model.id,
			tier: nextTier,
			reason: `升级路由：${previousDecision.tier} → ${nextTier}（前次失败）`,
			estimatedTokens: previousDecision.estimatedTokens * 1.5,
			estimatedCost: (previousDecision.estimatedTokens * 1.5 / 1000) * model.costPer1kTokens,
			createdAt: Date.now(),
		};

		return decision;
	}

	getCostLedger(): CostLedger {
		return {
			totalCost: this.ledger.totalCost,
			totalTokens: this.ledger.totalTokens,
			records: [...this.ledger.records],
		};
	}

	getEscalationLog(): EscalationLogEntry[] {
		return [...this.escalationLog];
	}

	hydrateCostLedger(ledger: CostLedger): void {
		this.ledger.totalCost = ledger.totalCost;
		this.ledger.totalTokens = ledger.totalTokens;
		this.ledger.records = ledger.records.map(r => ({ ...r }));
	}
}

registerSingleton(IRoutingService, RoutingService, InstantiationType.Delayed);
