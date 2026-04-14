/*---------------------------------------------------------------------------------------------
 *  Sentinel Worker Types
 *--------------------------------------------------------------------------------------------*/

export enum WorkerRole {
	Analyst = 'analyst',
	Planner = 'planner',
	Implementer = 'implementer',
	Reviewer = 'reviewer',
	Tester = 'tester',
	Verifier = 'verifier',
	Refiner = 'refiner',
}

export type WorkerRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkerTier = 'fast' | 'balanced' | 'power';

export interface WorkerDefinition {
	role: WorkerRole;
	name: string;
	systemObjective: string;
	canWrite: boolean;
	requiresVerification: boolean;
	defaultTier: WorkerTier;
}

export interface WorkerRun {
	id: string;
	intentId: string;
	nodeId: string;
	role: WorkerRole;
	status: WorkerRunStatus;
	modelId: string;
	tier: WorkerTier;
	inputSummary: string;
	outputSummary: string;
	tokensUsed: number;
	startedAt: number;
	finishedAt?: number;
}

export interface RoutingDecision {
	id: string;
	intentId: string;
	nodeId?: string;
	role: WorkerRole;
	modelId: string;
	tier: WorkerTier;
	reason: string;
	estimatedTokens: number;
	estimatedCost: number;
	createdAt: number;
}

export interface CostRecord {
	id: string;
	intentId: string;
	nodeId?: string;
	modelId: string;
	tier: WorkerTier;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	createdAt: number;
}

export interface CostLedger {
	totalCost: number;
	totalTokens: number;
	records: CostRecord[];
}

export const DEFAULT_WORKERS: WorkerDefinition[] = [
	{
		role: WorkerRole.Analyst,
		name: '需求分析师',
		systemObjective: '深度分析用户需求，识别模糊点和遗漏，生成完整需求规格。',
		canWrite: false,
		requiresVerification: false,
		defaultTier: 'power',
	},
	{
		role: WorkerRole.Planner,
		name: 'Planner Worker',
		systemObjective: '将意图拆解为可执行的任务节点与约束。',
		canWrite: false,
		requiresVerification: false,
		defaultTier: 'balanced',
	},
	{
		role: WorkerRole.Implementer,
		name: 'Implementer Worker',
		systemObjective: '根据意图和约束生成实现方案与工件投影。',
		canWrite: true,
		requiresVerification: true,
		defaultTier: 'balanced',
	},
	{
		role: WorkerRole.Reviewer,
		name: 'Reviewer Worker',
		systemObjective: '从对抗性视角识别逻辑漏洞和规格偏移。',
		canWrite: false,
		requiresVerification: true,
		defaultTier: 'power',
	},
	{
		role: WorkerRole.Tester,
		name: 'Test Worker',
		systemObjective: '生成和执行验证任务，确认无回归。',
		canWrite: true,
		requiresVerification: true,
		defaultTier: 'balanced',
	},
	{
		role: WorkerRole.Verifier,
		name: 'Verifier Worker',
		systemObjective: '汇总证据并对是否可放行给出裁定。',
		canWrite: false,
		requiresVerification: true,
		defaultTier: 'power',
	},
	{
		role: WorkerRole.Refiner,
		name: 'Refiner Worker',
		systemObjective: '整理投影工件并建立意图到工件的引用链。',
		canWrite: true,
		requiresVerification: false,
		defaultTier: 'fast',
	},
];
