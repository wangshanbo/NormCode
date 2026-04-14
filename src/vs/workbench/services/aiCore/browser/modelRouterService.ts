/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 3 — 决策中枢：TCE 评分引擎 + 三层模型分派池 + 动态升级机制

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';

export const IModelRouterService = createDecorator<IModelRouterService>('IModelRouterService');

// ============================================================================
// 类型
// ============================================================================

export enum ModelTier {
	Tier1_Fast = 1,
	Tier2_Balanced = 2,
	Tier3_Power = 3,
}

export interface ModelSpec {
	id: string;
	name: string;
	tier: ModelTier;
	costPer1kTokens: number;
	maxTokens: number;
	supportsThinking: boolean;
	supportsVision: boolean;
}

export interface TaskComplexityIndex {
	/** 综合复杂度得分 (0-100) */
	score: number;
	/** 推荐的模型层级 */
	recommendedTier: ModelTier;
	/** 各维度得分明细 */
	breakdown: {
		fileCount: number;
		cyclomaticComplexity: number;
		crossModuleDeps: number;
		securitySensitivity: number;
		architecturalImpact: number;
	};
	/** 推理理由 */
	reason: string;
}

export interface RoutingDecision {
	model: ModelSpec;
	tier: ModelTier;
	tci: TaskComplexityIndex;
	estimatedCost: number;
	estimatedTokens: number;
	timestamp: number;
}

export interface EscalationRecord {
	taskId: string;
	fromTier: ModelTier;
	toTier: ModelTier;
	reason: string;
	failureLog: string;
	timestamp: number;
}

export interface CostRecord {
	taskId: string;
	model: string;
	tier: ModelTier;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	timestamp: number;
}

export interface CostDashboard {
	totalCost: number;
	totalTokens: number;
	byTier: Record<number, { cost: number; tokens: number; count: number }>;
	byModel: Record<string, { cost: number; tokens: number; count: number }>;
	savings: number;
	escalations: number;
}

// ============================================================================
// 接口
// ============================================================================

export interface IModelRouterService {
	readonly _serviceBrand: undefined;

	readonly onDidRoute: Event<RoutingDecision>;
	readonly onDidEscalate: Event<EscalationRecord>;
	readonly onDidRecordCost: Event<CostRecord>;

	/** 计算任务复杂度指数 (TCI) */
	computeTCI(taskDescription: string, affectedFiles: string[], codeContext?: string): TaskComplexityIndex;

	/** 根据 TCI 选择模型 */
	route(tci: TaskComplexityIndex): RoutingDecision;

	/** 快捷方法：描述 → 直接获取路由决策 */
	routeTask(taskDescription: string, affectedFiles: string[], codeContext?: string): RoutingDecision;

	/** 动态升级：当前层级失败后升级到更高层级 */
	escalate(taskId: string, currentTier: ModelTier, failureLog: string): RoutingDecision | undefined;

	/** 记录 Token 消耗 */
	recordCost(taskId: string, model: string, tier: ModelTier, inputTokens: number, outputTokens: number): void;

	/** 获取成本仪表盘数据 */
	getCostDashboard(): CostDashboard;

	/** 获取所有可用模型 */
	getModels(): ModelSpec[];

	/** 获取指定层级的模型 */
	getModelByTier(tier: ModelTier): ModelSpec;

	/** 获取路由历史 */
	getRoutingHistory(): RoutingDecision[];

	/** 获取升级历史 */
	getEscalationHistory(): EscalationRecord[];
}

// ============================================================================
// 模型配置
// ============================================================================

/** 仅保留 GLM-5 / GLM-5.1（已移除全部 glm-4.x 及以下） */
const MODEL_POOL: ModelSpec[] = [
	{
		id: 'glm-5',
		name: 'GLM-5 (Tier 1)',
		tier: ModelTier.Tier1_Fast,
		costPer1kTokens: 0.008,
		maxTokens: 16384,
		supportsThinking: true,
		supportsVision: false,
	},
	{
		id: 'glm-5',
		name: 'GLM-5 (Tier 2)',
		tier: ModelTier.Tier2_Balanced,
		costPer1kTokens: 0.008,
		maxTokens: 16384,
		supportsThinking: true,
		supportsVision: false,
	},
	{
		id: 'glm-5.1',
		name: 'GLM-5.1 (Tier 3)',
		tier: ModelTier.Tier3_Power,
		costPer1kTokens: 0.05,
		maxTokens: 32768,
		supportsThinking: true,
		supportsVision: true,
	},
];

// ============================================================================
// 实现
// ============================================================================

export class ModelRouterService extends Disposable implements IModelRouterService {
	readonly _serviceBrand: undefined;

	private readonly routingHistory: RoutingDecision[] = [];
	private readonly escalationHistory: EscalationRecord[] = [];
	private readonly costRecords: CostRecord[] = [];

	private readonly _onDidRoute = this._register(new Emitter<RoutingDecision>());
	readonly onDidRoute = this._onDidRoute.event;

	private readonly _onDidEscalate = this._register(new Emitter<EscalationRecord>());
	readonly onDidEscalate = this._onDidEscalate.event;

	private readonly _onDidRecordCost = this._register(new Emitter<CostRecord>());
	readonly onDidRecordCost = this._onDidRecordCost.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ========================================================================
	// 任务复杂度评分引擎 (TCE)
	// ========================================================================

	computeTCI(taskDescription: string, affectedFiles: string[], codeContext?: string): TaskComplexityIndex {
		const desc = taskDescription.toLowerCase();
		const fileCount = affectedFiles.length;

		// 维度 1：受影响文件数量 (0-20)
		const fileScore = Math.min(20, fileCount * 4);

		// 维度 2：循环复杂度估算 (0-25) — 基于代码关键词
		let complexityScore = 0;
		const complexPatterns = [
			{ pattern: /async|await|promise|callback/gi, weight: 3 },
			{ pattern: /try\s*\{|catch\s*\(|finally/gi, weight: 2 },
			{ pattern: /if\s*\(|else\s*\{|switch\s*\(|case\s+/gi, weight: 1 },
			{ pattern: /for\s*\(|while\s*\(|\.map\(|\.reduce\(/gi, weight: 2 },
			{ pattern: /class\s+\w+|interface\s+\w+|abstract/gi, weight: 3 },
			{ pattern: /generic|<T>|<T,|extends\s+\w+/gi, weight: 4 },
		];
		const scanText = (codeContext || '') + taskDescription;
		for (const { pattern, weight } of complexPatterns) {
			const matches = scanText.match(pattern);
			complexityScore += (matches?.length || 0) * weight;
		}
		complexityScore = Math.min(25, complexityScore);

		// 维度 3：跨模块依赖 (0-20) — 基于文件路径多样性
		const dirs = new Set(affectedFiles.map(f => f.split('/').slice(0, -1).join('/')));
		const crossModuleScore = Math.min(20, dirs.size * 5);

		// 维度 4：安全敏感度 (0-20) — 关键词匹配
		let securityScore = 0;
		const securityKeywords = [
			'auth', 'login', 'password', 'token', 'jwt', 'session',
			'encrypt', 'decrypt', 'hash', 'secret', 'credential',
			'sql', 'query', 'database', 'migration', 'schema',
			'permission', 'role', 'access', 'admin', 'privilege',
		];
		for (const kw of securityKeywords) {
			if (desc.includes(kw) || affectedFiles.some(f => f.toLowerCase().includes(kw))) {
				securityScore += 4;
			}
		}
		securityScore = Math.min(20, securityScore);

		// 维度 5：架构影响 (0-15) — 关键词匹配
		let architecturalScore = 0;
		const archKeywords = [
			'refactor', 'migrate', 'redesign', 'rewrite', 'architecture',
			'api', 'endpoint', 'service', 'interface', 'protocol',
			'infrastructure', 'deploy', 'config', 'pipeline',
		];
		for (const kw of archKeywords) {
			if (desc.includes(kw)) {
				architecturalScore += 3;
			}
		}
		architecturalScore = Math.min(15, architecturalScore);

		const totalScore = fileScore + complexityScore + crossModuleScore + securityScore + architecturalScore;

		// 确定推荐层级
		let recommendedTier: ModelTier;
		let reason: string;

		if (totalScore <= 25) {
			recommendedTier = ModelTier.Tier1_Fast;
			reason = `Low complexity (TCI=${totalScore}): simple task suitable for fast model`;
		} else if (totalScore <= 55) {
			recommendedTier = ModelTier.Tier2_Balanced;
			reason = `Medium complexity (TCI=${totalScore}): requires balanced model for multi-file reasoning`;
		} else {
			recommendedTier = ModelTier.Tier3_Power;
			reason = `High complexity (TCI=${totalScore}): needs power model for architectural/security reasoning`;
		}

		const tci: TaskComplexityIndex = {
			score: totalScore,
			recommendedTier,
			breakdown: {
				fileCount: fileScore,
				cyclomaticComplexity: complexityScore,
				crossModuleDeps: crossModuleScore,
				securitySensitivity: securityScore,
				architecturalImpact: architecturalScore,
			},
			reason,
		};

		this.logService.info(`[ModelRouterService] TCI computed: ${totalScore} → Tier ${recommendedTier}`);
		return tci;
	}

	// ========================================================================
	// 模型路由
	// ========================================================================

	route(tci: TaskComplexityIndex): RoutingDecision {
		const model = this.getModelByTier(tci.recommendedTier);
		const estimatedTokens = this.estimateTokens(tci);
		const estimatedCost = (estimatedTokens / 1000) * model.costPer1kTokens;

		const decision: RoutingDecision = {
			model,
			tier: tci.recommendedTier,
			tci,
			estimatedCost,
			estimatedTokens,
			timestamp: Date.now(),
		};

		this.routingHistory.push(decision);
		this._onDidRoute.fire(decision);

		this.logService.info(
			`[ModelRouterService] Routed to ${model.name}: ` +
			`TCI=${tci.score}, est. cost=$${estimatedCost.toFixed(4)}`
		);

		return decision;
	}

	routeTask(taskDescription: string, affectedFiles: string[], codeContext?: string): RoutingDecision {
		const tci = this.computeTCI(taskDescription, affectedFiles, codeContext);
		return this.route(tci);
	}

	// ========================================================================
	// 动态升级 (Escalation)
	// ========================================================================

	escalate(taskId: string, currentTier: ModelTier, failureLog: string): RoutingDecision | undefined {
		if (currentTier >= ModelTier.Tier3_Power) {
			this.logService.warn('[ModelRouterService] Already at Tier 3, cannot escalate further');
			return undefined;
		}

		const nextTier = currentTier + 1 as ModelTier;
		const record: EscalationRecord = {
			taskId,
			fromTier: currentTier,
			toTier: nextTier,
			reason: `Tier ${currentTier} failed verification`,
			failureLog: failureLog.substring(0, 2000),
			timestamp: Date.now(),
		};

		this.escalationHistory.push(record);
		this._onDidEscalate.fire(record);

		this.logService.info(
			`[ModelRouterService] Escalating task ${taskId}: Tier ${currentTier} → Tier ${nextTier}`
		);

		const model = this.getModelByTier(nextTier);
		const estimatedTokens = 4000;
		const decision: RoutingDecision = {
			model,
			tier: nextTier,
			tci: {
				score: nextTier === ModelTier.Tier3_Power ? 80 : 50,
				recommendedTier: nextTier,
				breakdown: { fileCount: 0, cyclomaticComplexity: 0, crossModuleDeps: 0, securitySensitivity: 0, architecturalImpact: 0 },
				reason: `Escalated from Tier ${currentTier} after failure`,
			},
			estimatedCost: (estimatedTokens / 1000) * model.costPer1kTokens,
			estimatedTokens,
			timestamp: Date.now(),
		};

		this.routingHistory.push(decision);
		this._onDidRoute.fire(decision);

		return decision;
	}

	// ========================================================================
	// 成本追踪
	// ========================================================================

	recordCost(taskId: string, model: string, tier: ModelTier, inputTokens: number, outputTokens: number): void {
		const modelSpec = MODEL_POOL.find(m => m.id === model);
		const rate = modelSpec?.costPer1kTokens || 0.01;
		const cost = ((inputTokens + outputTokens) / 1000) * rate;

		const record: CostRecord = {
			taskId,
			model,
			tier,
			inputTokens,
			outputTokens,
			cost,
			timestamp: Date.now(),
		};

		this.costRecords.push(record);
		this._onDidRecordCost.fire(record);
	}

	getCostDashboard(): CostDashboard {
		const dashboard: CostDashboard = {
			totalCost: 0,
			totalTokens: 0,
			byTier: {},
			byModel: {},
			savings: 0,
			escalations: this.escalationHistory.length,
		};

		for (const record of this.costRecords) {
			const tokens = record.inputTokens + record.outputTokens;
			dashboard.totalCost += record.cost;
			dashboard.totalTokens += tokens;

			// 按层级
			if (!dashboard.byTier[record.tier]) {
				dashboard.byTier[record.tier] = { cost: 0, tokens: 0, count: 0 };
			}
			dashboard.byTier[record.tier].cost += record.cost;
			dashboard.byTier[record.tier].tokens += tokens;
			dashboard.byTier[record.tier].count++;

			// 按模型
			if (!dashboard.byModel[record.model]) {
				dashboard.byModel[record.model] = { cost: 0, tokens: 0, count: 0 };
			}
			dashboard.byModel[record.model].cost += record.cost;
			dashboard.byModel[record.model].tokens += tokens;
			dashboard.byModel[record.model].count++;
		}

		// 节省估算：如果全部使用 Tier 3 的成本 vs 实际分层成本
		const tier3Rate = MODEL_POOL.find(m => m.tier === ModelTier.Tier3_Power)?.costPer1kTokens || 0.05;
		const allTier3Cost = (dashboard.totalTokens / 1000) * tier3Rate;
		dashboard.savings = Math.max(0, allTier3Cost - dashboard.totalCost);

		return dashboard;
	}

	// ========================================================================
	// 查询方法
	// ========================================================================

	getModels(): ModelSpec[] {
		return [...MODEL_POOL];
	}

	getModelByTier(tier: ModelTier): ModelSpec {
		const found = MODEL_POOL.find(m => m.tier === tier);
		if (found) {
			return found;
		}
		return MODEL_POOL.find(m => m.id === 'glm-5.1') ?? MODEL_POOL[MODEL_POOL.length - 1];
	}

	getRoutingHistory(): RoutingDecision[] {
		return [...this.routingHistory];
	}

	getEscalationHistory(): EscalationRecord[] {
		return [...this.escalationHistory];
	}

	// ========================================================================
	// 私有方法
	// ========================================================================

	private estimateTokens(tci: TaskComplexityIndex): number {
		switch (tci.recommendedTier) {
			case ModelTier.Tier1_Fast: return 1000 + tci.score * 20;
			case ModelTier.Tier2_Balanced: return 2000 + tci.score * 40;
			case ModelTier.Tier3_Power: return 4000 + tci.score * 80;
			default: return 2000;
		}
	}
}

registerSingleton(IModelRouterService, ModelRouterService, InstantiationType.Delayed);
