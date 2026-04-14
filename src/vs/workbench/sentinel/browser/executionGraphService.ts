/*---------------------------------------------------------------------------------------------
 *  Sentinel Execution Graph Service
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import {
	createDefaultExecutionGraph,
	DefaultExecutionGraphOptions,
	ExecutionGraph,
	ExecutionGraphStatus,
	ExecutionNode,
	ExecutionNodeGate,
	ExecutionNodeStatus,
	ExecutionNodeType,
	GoalDriftCheck,
	FailureAttribution,
} from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { WorkerRole } from '../common/workerTypes.js';

export const IExecutionGraphService = createDecorator<IExecutionGraphService>('IExecutionGraphService');

export interface IExecutionGraphService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateGraph: Event<ExecutionGraph>;

	createGraphForIntent(intent: Intent, options?: DefaultExecutionGraphOptions): ExecutionGraph;
	createDynamicGraphForIntent(intent: Intent, plannerOutput: string, options?: DefaultExecutionGraphOptions): ExecutionGraph;
	/** 从磁盘恢复全部执行图（替换内存） */
	hydrate(graphs: ExecutionGraph[]): void;
	getGraph(intentId: string): ExecutionGraph | undefined;
	listGraphs(): ExecutionGraph[];
	getCurrentNode(intentId: string): ExecutionNode | undefined;
	updateNodeStatus(intentId: string, nodeId: string, status: ExecutionNodeStatus, result?: string): ExecutionNode | undefined;
	updateNodeMetadata(intentId: string, nodeId: string, metadata: Partial<ExecutionNode>): ExecutionNode | undefined;
	runGoalDriftCheck(node: ExecutionNode, changedFiles?: string[], matchedCriteria?: string[]): GoalDriftCheck;
	buildFailureAttribution(node: ExecutionNode, workerFailed: boolean, verificationBlocked: boolean, driftBlocked: boolean, details: string[]): FailureAttribution;
	computeNodeRiskLevel(node: ExecutionNode, intent: Intent): 'low' | 'medium' | 'high' | 'critical';
	computeNodeComplexity(node: ExecutionNode, intent: Intent): number;
	addNode(intentId: string, node: ExecutionNode, afterNodeId?: string): ExecutionNode | undefined;
	removeNode(intentId: string, nodeId: string): boolean;
	moveNode(intentId: string, nodeId: string, direction: 'up' | 'down'): boolean;
	/** 在最后一轮实现后追加「设计对撞」审查 + 实现收敛节点（幂等） */
	appendAnthropicDesignCollisionPass(intentId: string): boolean;
	/** 更新内存中执行图顶层状态（勿对 getGraph 返回的克隆赋值） */
	updateGraphStatus(intentId: string, status: ExecutionGraphStatus): void;
}

export class ExecutionGraphService extends Disposable implements IExecutionGraphService {
	readonly _serviceBrand: undefined;

	private readonly graphs = new Map<string, ExecutionGraph>();
	private readonly _onDidUpdateGraph = this._register(new Emitter<ExecutionGraph>());
	readonly onDidUpdateGraph = this._onDidUpdateGraph.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	createGraphForIntent(intent: Intent, options?: DefaultExecutionGraphOptions): ExecutionGraph {
		const graph = createDefaultExecutionGraph(intent.id, intent.title, {
			allowedFiles: intent.intentCard.allowedFiles,
			successCriteria: intent.intentCard.successCriteria,
			nonGoals: intent.intentCard.nonGoals,
			stopIf: intent.intentCard.stopIf,
		}, options);
		this.graphs.set(intent.id, graph);
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		return graph;
	}

	hydrate(graphs: ExecutionGraph[]): void {
		this.graphs.clear();
		for (const g of graphs) {
			this.graphs.set(g.intentId, this.cloneGraph(g));
		}
		this.logService.info(`[Sentinel] Execution graphs hydrated: ${graphs.length} graph(s)`);
		for (const g of this.graphs.values()) {
			this._onDidUpdateGraph.fire(this.cloneGraph(g));
		}
	}

	updateGraphStatus(intentId: string, status: ExecutionGraphStatus): void {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return;
		}
		graph.status = status;
		graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
	}

	appendAnthropicDesignCollisionPass(intentId: string): boolean {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return false;
		}
		if (graph.nodes.some(n => n.id.startsWith('node_review_critique_'))) {
			return false;
		}
		const implementers = graph.nodes.filter(
			n => n.type === 'implement' && n.workerRole === WorkerRole.Implementer,
		);
		if (implementers.length === 0) {
			return false;
		}
		const lastImpl =
			[...implementers].reverse().find(
				impl => !implementers.some(other => other.id !== impl.id && other.dependencies.includes(impl.id)),
			) ?? implementers[implementers.length - 1];

		const now = Date.now();
		const suffix = `${now}`;
		const reviewId = `node_review_critique_${suffix}`;
		const refineId = `node_implement_refine_${suffix}`;
		const gate = lastImpl.gate;

		const reviewNode = this.buildNode(
			reviewId,
			'设计对撞·产品/设计审查',
			'从产品设计、视觉工艺、外链与多媒体可达性等维度输出可执行修订清单；可联网对照当前主流界面范式。',
			'review',
			WorkerRole.Reviewer,
			[lastImpl.id],
			gate,
			now,
		);
		const refineNode = this.buildNode(
			refineId,
			'设计对撞·实现收敛',
			'依据上一轮审查逐项落地：修复失效外链/配图、统一视觉与交互；可用工具改文件并复测。',
			'implement',
			WorkerRole.Implementer,
			[reviewId],
			gate,
			now,
		);

		graph.nodes.push(reviewNode, refineNode);
		graph.progress = {
			...graph.progress,
			total: graph.nodes.length,
			percent: graph.progress.completed > 0
				? Math.round((graph.progress.completed / Math.max(graph.nodes.length, 1)) * 100)
				: 0,
		};
		graph.updatedAt = now;
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		this.logService.info(`[Sentinel] Appended design-collision pass after ${lastImpl.id} → ${reviewId} → ${refineId}`);
		return true;
	}

	createDynamicGraphForIntent(intent: Intent, plannerOutput: string, options?: DefaultExecutionGraphOptions): ExecutionGraph {
		const steps = this.parsePlannerOutput(plannerOutput);

		if (steps.length === 0) {
			this.logService.trace('[Sentinel] Planner output parsing failed, falling back to default graph');
			return this.createGraphForIntent(intent, options);
		}

		const now = Date.now();
		const baseGate: ExecutionNodeGate = {
			allowedFiles: intent.intentCard.allowedFiles,
			successCriteria: intent.intentCard.successCriteria,
			nonGoals: intent.intentCard.nonGoals,
			stopIf: intent.intentCard.stopIf,
		};

		const nodes: ExecutionNode[] = [];

		nodes.push(this.buildNode('plan_0', 'Plan Intent', '将意图拆解为可执行任务节点。', 'plan', WorkerRole.Planner, [], baseGate, now));

		let lastDep = 'plan_0';
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const implId = `impl_${i}`;

			const stepGate: ExecutionNodeGate = {
				allowedFiles: step.files.length > 0 ? step.files : baseGate.allowedFiles,
				successCriteria: step.criteria.length > 0 ? step.criteria : baseGate.successCriteria,
				nonGoals: baseGate.nonGoals,
				stopIf: baseGate.stopIf,
			};

			nodes.push(this.buildNode(implId, step.title, step.description, 'implement', WorkerRole.Implementer, [lastDep], stepGate, now));
			lastDep = implId;
		}

		if (options?.appendVerifyAfterImplement && lastDep.startsWith('impl_')) {
			const verifyId = `verify_${now}`;
			nodes.push(
				this.buildNode(
					verifyId,
					'验证与对齐',
					'对照成功标准、验证门禁与漂移检测，确认交付与意图一致。',
					'verify',
					WorkerRole.Verifier,
					[lastDep],
					baseGate,
					now,
				),
			);
		}

		nodes[0].status = 'ready';

		const graph: ExecutionGraph = {
			id: `exec_${now}`,
			intentId: intent.id,
			name: intent.title,
			status: 'ready',
			nodes,
			currentNodeId: nodes[0].id,
			progress: { completed: 0, total: nodes.length, percent: 0 },
			createdAt: now,
			updatedAt: now,
		};

		this.graphs.set(intent.id, graph);
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		this.logService.trace(`[Sentinel] Dynamic graph created with ${nodes.length} nodes for intent ${intent.id}`);
		return graph;
	}

	getGraph(intentId: string): ExecutionGraph | undefined {
		const graph = this.graphs.get(intentId);
		return graph ? this.cloneGraph(graph) : undefined;
	}

	listGraphs(): ExecutionGraph[] {
		return Array.from(this.graphs.values()).map(graph => this.cloneGraph(graph));
	}

	getCurrentNode(intentId: string): ExecutionNode | undefined {
		const graph = this.graphs.get(intentId);
		if (!graph?.currentNodeId) {
			return undefined;
		}

		return graph.nodes.find(node => node.id === graph.currentNodeId);
	}

	updateNodeStatus(intentId: string, nodeId: string, status: ExecutionNodeStatus, result?: string): ExecutionNode | undefined {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return undefined;
		}

		const node = graph.nodes.find(item => item.id === nodeId);
		if (!node) {
			return undefined;
		}

		node.status = status;
		node.result = result || node.result;
		node.updatedAt = Date.now();

		if (status === 'completed') {
			const next = graph.nodes.find(candidate =>
				candidate.status === 'pending' &&
				candidate.dependencies.every(dep => graph.nodes.find(nodeItem => nodeItem.id === dep)?.status === 'completed')
			);
			if (next) {
				next.status = 'ready';
				next.updatedAt = Date.now();
				graph.currentNodeId = next.id;
				graph.status = 'running';
			} else {
				graph.currentNodeId = undefined;
				graph.status = 'completed';
			}
		} else if (status === 'failed' || status === 'blocked') {
			graph.status = 'blocked';
		} else if (status === 'running') {
			graph.status = 'running';
			graph.currentNodeId = node.id;
		}

		const completed = graph.nodes.filter(item => item.status === 'completed').length;
		graph.progress = {
			completed,
			total: graph.nodes.length,
			percent: Math.round((completed / Math.max(graph.nodes.length, 1)) * 100),
		};
		graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		this.logService.trace(`[Sentinel] Node ${nodeId} -> ${status}`);
		return { ...node, gate: { ...node.gate }, artifactIds: [...node.artifactIds] };
	}

	updateNodeMetadata(intentId: string, nodeId: string, metadata: Partial<ExecutionNode>): ExecutionNode | undefined {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return undefined;
		}

		const node = graph.nodes.find(item => item.id === nodeId);
		if (!node) {
			return undefined;
		}

		Object.assign(node, metadata, {
			updatedAt: Date.now(),
			gate: metadata.gate ? { ...metadata.gate } : node.gate,
			artifactIds: metadata.artifactIds ? [...metadata.artifactIds] : node.artifactIds,
		});
		graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		return { ...node, gate: { ...node.gate }, artifactIds: [...node.artifactIds] };
	}

	runGoalDriftCheck(node: ExecutionNode, changedFiles: string[] = [], matchedCriteria: string[] = []): GoalDriftCheck {
		const outOfScopeFiles = changedFiles.filter(file =>
			node.gate.allowedFiles.length > 0 && !node.gate.allowedFiles.some(allowed => file.includes(allowed))
		);
		/**
		 * 仅当调用方显式传入「已验证满足的条件」子集时，才对剩余 successCriteria 报未覆盖。
		 * 若 matchedCriteria 为空，则不把「整表未匹配」当作漂移（避免内核误传 [criteria[0]] 时每节点恒告警）。
		 */
		const unmatchedCriteria = matchedCriteria.length > 0
			? node.gate.successCriteria.filter(criteria => !matchedCriteria.includes(criteria))
			: [];
		const triggeredStopConditions = node.gate.stopIf.filter(condition =>
			outOfScopeFiles.length > 0 && /扩张|越界|范围/i.test(condition)
		);

		const reasons: string[] = [];
		if (outOfScopeFiles.length > 0) {
			reasons.push('检测到超出允许范围的文件变更');
		}
		if (unmatchedCriteria.length > 0) {
			reasons.push('尚未覆盖全部成功标准（已声明满足的子集之外仍有未验证项）');
		}
		if (triggeredStopConditions.length > 0) {
			reasons.push('命中停止条件，必须中断执行');
		}

		return {
			status: triggeredStopConditions.length > 0 ? 'blocked' : (reasons.length > 0 ? 'warning' : 'pass'),
			reasons,
			outOfScopeFiles,
			unmatchedCriteria,
			triggeredStopConditions,
		};
	}

	buildFailureAttribution(
		node: ExecutionNode,
		workerFailed: boolean,
		verificationBlocked: boolean,
		driftBlocked: boolean,
		details: string[],
	): FailureAttribution {
		if (workerFailed) {
			return {
				source: 'worker',
				summary: `Worker ${node.workerRole} 执行失败`,
				details,
				suggestedAction: 'retry',
			};
		}
		if (driftBlocked) {
			return {
				source: 'drift',
				summary: '目标漂移检测触发阻塞',
				details,
				suggestedAction: 'rollback',
			};
		}
		if (verificationBlocked) {
			const hasCritical = details.some(d => /critical|安全|security/i.test(d));
			return {
				source: 'verification',
				summary: '验证门阻塞',
				details,
				suggestedAction: hasCritical ? 'escalate' : 'retry',
			};
		}
		return {
			source: 'unknown',
			summary: '未知原因导致节点阻塞',
			details,
			suggestedAction: 'manual',
		};
	}

	computeNodeRiskLevel(node: ExecutionNode, intent: Intent): 'low' | 'medium' | 'high' | 'critical' {
		let riskScore = 0;

		if (node.type === 'implement' || node.type === 'project') {
			riskScore += 2;
		}
		if (node.workerRole === WorkerRole.Implementer || node.workerRole === WorkerRole.Refiner) {
			riskScore += 1;
		}

		const securityKeywords = ['auth', 'password', 'token', 'secret', 'permission', 'encrypt', 'sql', 'injection'];
		const goalLower = intent.goal.toLowerCase();
		for (const kw of securityKeywords) {
			if (goalLower.includes(kw) || node.description.toLowerCase().includes(kw)) {
				riskScore += 2;
			}
		}

		if (node.gate.allowedFiles.length > 5) {
			riskScore += 2;
		} else if (node.gate.allowedFiles.length > 2) {
			riskScore += 1;
		}

		if (intent.intentCard.stopIf.length > 0) {
			riskScore += 1;
		}

		if (riskScore >= 6) { return 'critical'; }
		if (riskScore >= 4) { return 'high'; }
		if (riskScore >= 2) { return 'medium'; }
		return 'low';
	}

	computeNodeComplexity(node: ExecutionNode, intent: Intent): number {
		let score = 0;

		score += Math.min(20, node.gate.allowedFiles.length * 4);
		score += Math.min(15, node.gate.successCriteria.length * 5);
		score += Math.min(10, node.gate.nonGoals.length * 3);

		const complexKeywords = ['refactor', 'migrate', 'rewrite', 'multi-file', 'cross-module', 'concurrent', 'async'];
		const text = (intent.goal + ' ' + node.description).toLowerCase();
		for (const kw of complexKeywords) {
			if (text.includes(kw)) {
				score += 5;
			}
		}

		if (node.dependencies.length > 2) {
			score += (node.dependencies.length - 2) * 3;
		}

		return Math.min(100, score);
	}

	addNode(intentId: string, node: ExecutionNode, afterNodeId?: string): ExecutionNode | undefined {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return undefined;
		}

		if (afterNodeId) {
			const idx = graph.nodes.findIndex(n => n.id === afterNodeId);
			if (idx >= 0) {
				graph.nodes.splice(idx + 1, 0, node);
			} else {
				graph.nodes.push(node);
			}
		} else {
			graph.nodes.push(node);
		}

		graph.progress.total = graph.nodes.length;
		graph.progress.percent = Math.round((graph.progress.completed / Math.max(graph.nodes.length, 1)) * 100);
		graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		return { ...node, gate: { ...node.gate }, artifactIds: [...node.artifactIds] };
	}

	removeNode(intentId: string, nodeId: string): boolean {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return false;
		}

		const idx = graph.nodes.findIndex(n => n.id === nodeId);
		if (idx < 0) {
			return false;
		}

		const node = graph.nodes[idx];
		if (node.status === 'running' || node.status === 'completed') {
			return false;
		}

		graph.nodes.splice(idx, 1);

		for (const n of graph.nodes) {
			n.dependencies = n.dependencies.filter(d => d !== nodeId);
		}

		graph.progress.total = graph.nodes.length;
		graph.progress.percent = Math.round((graph.progress.completed / Math.max(graph.nodes.length, 1)) * 100);
		graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		return true;
	}

	moveNode(intentId: string, nodeId: string, direction: 'up' | 'down'): boolean {
		const graph = this.graphs.get(intentId);
		if (!graph) {
			return false;
		}

		const idx = graph.nodes.findIndex(n => n.id === nodeId);
		if (idx < 0) {
			return false;
		}

		const node = graph.nodes[idx];
		if (node.status === 'running' || node.status === 'completed') {
			return false;
		}

		const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= graph.nodes.length) {
			return false;
		}

		const swapNode = graph.nodes[swapIdx];
		if (swapNode.status === 'running' || swapNode.status === 'completed') {
			return false;
		}

		graph.nodes[idx] = swapNode;
		graph.nodes[swapIdx] = node;
		graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.cloneGraph(graph));
		return true;
	}

	private parsePlannerStepsFromSectionMatches(
		matches: RegExpMatchArray[],
		output: string,
	): { title: string; description: string; files: string[]; criteria: string[] }[] {
		const steps: { title: string; description: string; files: string[]; criteria: string[] }[] = [];
		for (let i = 0; i < matches.length; i++) {
			const title = matches[i][1].trim();
			const startIdx = matches[i].index! + matches[i][0].length;
			const endIdx = i + 1 < matches.length ? matches[i + 1].index! : output.length;
			const body = output.substring(startIdx, endIdx);

			const filesMatch = body.match(/[-*]\s*影响文件\s*[:：]\s*(.+)/);
			const criteriaMatch = body.match(/[-*]\s*成功标准\s*[:：]\s*(.+)/);
			const descLines = body.split('\n').filter(l => l.trim() && !l.match(/[-*]\s*(影响文件|成功标准)/));

			steps.push({
				title,
				description: descLines.join(' ').trim(),
				files: filesMatch ? filesMatch[1].split(/[,，]/).map(f => f.trim()).filter(Boolean) : [],
				criteria: criteriaMatch ? criteriaMatch[1].split(/[,，]/).map(c => c.trim()).filter(Boolean) : [],
			});
		}
		return steps;
	}

	private parsePlannerOutput(output: string): { title: string; description: string; files: string[]; criteria: string[] }[] {
		const steps: { title: string; description: string; files: string[]; criteria: string[] }[] = [];

		const headerPattern = /##\s*(?:步骤|STEP)\s*\d+\s*[:：]\s*(.+)/gi;
		const headerMatches = [...output.matchAll(headerPattern)];

		if (headerMatches.length > 0) {
			return this.parsePlannerStepsFromSectionMatches(headerMatches, output);
		}

		const h3Pattern = /###\s*(?:步骤|STEP|Step)\s*\d+\s*[:：]\s*(.+)/gi;
		const h3Matches = [...output.matchAll(h3Pattern)];
		if (h3Matches.length > 0) {
			return this.parsePlannerStepsFromSectionMatches(h3Matches, output);
		}

		const h4Pattern = /####\s*(?:步骤|STEP|Step)\s*\d+\s*[:：]\s*(.+)/gi;
		const h4Matches = [...output.matchAll(h4Pattern)];
		if (h4Matches.length > 0) {
			return this.parsePlannerStepsFromSectionMatches(h4Matches, output);
		}

		const numberedPattern = /^\d+\.\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)/gm;
		const numberedMatches = [...output.matchAll(numberedPattern)];

		for (const match of numberedMatches) {
			steps.push({
				title: match[1].trim(),
				description: match[2].trim(),
				files: [],
				criteria: [],
			});
		}

		if (steps.length === 0) {
			const loosePattern = /^\d+\.\s+(?!\*\*)([^\n]+)$/gm;
			const looseMatches = [...output.matchAll(loosePattern)];
			if (looseMatches.length >= 2) {
				for (const m of looseMatches) {
					const title = m[1].trim();
					if (title.length >= 2 && title.length < 240) {
						steps.push({ title, description: '', files: [], criteria: [] });
					}
				}
			}
		}

		return steps;
	}

	private buildNode(
		id: string,
		title: string,
		description: string,
		type: ExecutionNodeType,
		workerRole: WorkerRole,
		dependencies: string[],
		gate: ExecutionNodeGate,
		now: number,
	): ExecutionNode {
		return {
			id,
			title,
			description,
			type,
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

	private cloneGraph(graph: ExecutionGraph): ExecutionGraph {
		return {
			...graph,
			nodes: graph.nodes.map(node => ({
				...node,
				gate: { ...node.gate },
				driftCheck: node.driftCheck ? {
					...node.driftCheck,
					reasons: [...node.driftCheck.reasons],
					outOfScopeFiles: [...node.driftCheck.outOfScopeFiles],
					unmatchedCriteria: [...node.driftCheck.unmatchedCriteria],
					triggeredStopConditions: [...node.driftCheck.triggeredStopConditions],
				} : undefined,
				artifactIds: [...node.artifactIds],
			})),
			progress: { ...graph.progress },
		};
	}
}

registerSingleton(IExecutionGraphService, ExecutionGraphService, InstantiationType.Delayed);
