/*---------------------------------------------------------------------------------------------
 *  Sentinel Execution Types
 *  ExecutionGraph / NodeGate / GoalDriftCheck / ContextStateObject
 *--------------------------------------------------------------------------------------------*/

import { WorkerRole } from './workerTypes.js';

export type ExecutionGraphStatus = 'draft' | 'ready' | 'running' | 'blocked' | 'verified' | 'completed';
export type ExecutionNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type ExecutionNodeType = 'analyze' | 'plan' | 'implement' | 'review' | 'test' | 'verify' | 'project';
export type GoalDriftStatus = 'pass' | 'warning' | 'blocked';

export interface ExecutionNodeGate {
	allowedFiles: string[];
	successCriteria: string[];
	nonGoals: string[];
	stopIf: string[];
}

export interface GoalDriftCheck {
	status: GoalDriftStatus;
	reasons: string[];
	outOfScopeFiles: string[];
	unmatchedCriteria: string[];
	triggeredStopConditions: string[];
}

export interface ContextStateObject {
	id: string;
	intentId: string;
	nodeId: string;
	summary: string;
	affectedFiles: string[];
	fileContents: Array<{ path: string; content: string; truncated: boolean }>;
	astSummaries: string[];
	diagnostics: string[];
	pendingTests: string[];
	recentFailures: string[];
	recentDecisions: string[];
	checkpointRef?: string;
	iteration: number;
	createdAt: number;
	updatedAt: number;
}

export interface FailureAttribution {
	source: 'worker' | 'verification' | 'drift' | 'test' | 'materialization' | 'unknown';
	summary: string;
	details: string[];
	suggestedAction: 'retry' | 'rollback' | 'escalate' | 'manual';
}

export interface ExecutionNode {
	id: string;
	title: string;
	description: string;
	type: ExecutionNodeType;
	status: ExecutionNodeStatus;
	workerRole: WorkerRole;
	dependencies: string[];
	gate: ExecutionNodeGate;
	result?: string;
	driftCheck?: GoalDriftCheck;
	checkpointRef?: string;
	verificationRef?: string;
	costRef?: string;
	riskLevel?: 'low' | 'medium' | 'high' | 'critical';
	complexityScore?: number;
	failureAttribution?: FailureAttribution;
	artifactIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface ExecutionGraphProgress {
	completed: number;
	total: number;
	percent: number;
}

export interface ExecutionGraph {
	id: string;
	intentId: string;
	name: string;
	status: ExecutionGraphStatus;
	nodes: ExecutionNode[];
	currentNodeId?: string;
	progress: ExecutionGraphProgress;
	createdAt: number;
	updatedAt: number;
}

export interface CheckpointRecord {
	id: string;
	intentId: string;
	nodeId: string;
	label: string;
	adapterCheckpointId?: string;
	createdAt: number;
}

/** `appendVerifyAfterImplement`：在 harness 开启时于「实现」后追加 Verifier 节点，避免未经验证即收尾。 */
export type DefaultExecutionGraphOptions = {
	appendVerifyAfterImplement?: boolean;
};

export function createDefaultExecutionGraph(
	intentId: string,
	title: string,
	gate: ExecutionNodeGate,
	options?: DefaultExecutionGraphOptions,
): ExecutionGraph {
	const now = Date.now();
	const nodes: ExecutionNode[] = [
		createNode('plan', '任务规划', '分析意图并拆解为实现步骤。', WorkerRole.Planner, [], gate, now),
		createNode('implement', '代码生成', '根据规划生成完整代码文件。', WorkerRole.Implementer, ['node_plan'], gate, now),
	];
	if (options?.appendVerifyAfterImplement) {
		nodes.push(
			createNode(
				'verify',
				'验证与对齐',
				'对照成功标准、验证门禁与漂移检测，确认交付与意图一致。',
				WorkerRole.Verifier,
				['node_implement'],
				gate,
				now,
			),
		);
	}

	nodes[0].status = 'ready';

	return {
		id: `exec_${now}`,
		intentId,
		name: title,
		status: 'ready',
		nodes,
		currentNodeId: nodes[0].id,
		progress: { completed: 0, total: nodes.length, percent: 0 },
		createdAt: now,
		updatedAt: now,
	};
}

function createNode(
	nodeType: ExecutionNodeType,
	title: string,
	description: string,
	workerRole: WorkerRole,
	dependencies: string[],
	gate: ExecutionNodeGate,
	now: number,
): ExecutionNode {
	return {
		id: `node_${nodeType}`,
		title,
		description,
		type: nodeType,
		status: 'pending',
		workerRole,
		dependencies,
		gate: {
			allowedFiles: [...gate.allowedFiles],
			successCriteria: [...gate.successCriteria],
			nonGoals: [...gate.nonGoals],
			stopIf: [...gate.stopIf],
		},
		artifactIds: [],
		createdAt: now,
		updatedAt: now,
	};
}
