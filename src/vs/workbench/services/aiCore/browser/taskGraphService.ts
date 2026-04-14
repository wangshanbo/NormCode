/*---------------------------------------------------------------------------------------------
 *  Task Graph Service (DAG)
 *  可视化任务图服务 —— 管理 DAG 的创建、拓扑排序、执行控制
 *---------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ISpecModeService } from './specModeService.js';
import {
	TaskGraph,
	TaskNode,
	TaskEdge,
	TaskNodeStatus,
	TaskNodeType,
	ExecutionPlan,
} from '../common/taskGraphTypes.js';
import { SpecTask } from '../common/chatModeTypes.js';

export const ITaskGraphService = createDecorator<ITaskGraphService>('ITaskGraphService');

// ============================================================================
// 接口定义
// ============================================================================

export interface ITaskGraphService {
	readonly _serviceBrand: undefined;

	readonly onDidUpdateGraph: Event<TaskGraph>;
	readonly onDidUpdatePlan: Event<ExecutionPlan>;
	readonly onDidChangeNodeStatus: Event<{ nodeId: string; status: TaskNodeStatus }>;

	/** 从 SpecModeService 的任务列表构建 DAG */
	buildFromSpec(): TaskGraph | undefined;

	/** 手动创建 DAG */
	createGraph(name: string, tasks: TaskNode[], edges: TaskEdge[]): TaskGraph;

	/** 获取当前 DAG */
	getGraph(): TaskGraph | undefined;

	/** 获取执行计划 */
	getPlan(): ExecutionPlan | undefined;

	/** 添加任务节点 */
	addNode(node: TaskNode): void;

	/** 添加依赖边（自动验证无环） */
	addEdge(sourceId: string, targetId: string): boolean;

	/** 移除任务节点 */
	removeNode(nodeId: string): void;

	/** 拓扑排序 */
	topologicalSort(): string[];

	/** 计算关键路径 */
	computeCriticalPath(): string[];

	/** 获取就绪任务（所有依赖已完成） */
	getReadyTasks(): TaskNode[];

	/** 更新任务状态 */
	updateNodeStatus(nodeId: string, status: TaskNodeStatus, result?: string): void;

	/** 暂停执行 */
	pause(): void;

	/** 恢复执行 */
	resume(): void;

	/** 检测是否有环 */
	hasCycle(): boolean;

	/** 获取进度信息 */
	getProgress(): { completed: number; total: number; percent: number };

	/** 自动布局：为节点分配 column/row 坐标 */
	autoLayout(): void;

	/** 用户编辑执行顺序 */
	reorderExecution(newOrder: string[]): void;
}

// ============================================================================
// 服务实现
// ============================================================================

export class TaskGraphService extends Disposable implements ITaskGraphService {
	readonly _serviceBrand: undefined;

	private _graph: TaskGraph | undefined;
	private _plan: ExecutionPlan | undefined;
	private edgeIdCounter = 0;

	private readonly _onDidUpdateGraph = this._register(new Emitter<TaskGraph>());
	readonly onDidUpdateGraph = this._onDidUpdateGraph.event;

	private readonly _onDidUpdatePlan = this._register(new Emitter<ExecutionPlan>());
	readonly onDidUpdatePlan = this._onDidUpdatePlan.event;

	private readonly _onDidChangeNodeStatus = this._register(new Emitter<{ nodeId: string; status: TaskNodeStatus }>());
	readonly onDidChangeNodeStatus = this._onDidChangeNodeStatus.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ISpecModeService private readonly specModeService: ISpecModeService,
	) {
		super();

		this._register(this.specModeService.onDidUpdateSession(session => {
			if (session.tasks.length > 0 && session.phase === 'task_execution') {
				this.buildFromSpec();
			}
		}));
	}

	// ========================================================================
	// 从 Spec 构建 DAG
	// ========================================================================

	buildFromSpec(): TaskGraph | undefined {
		const session = this.specModeService.getCurrentSession();
		if (!session || session.tasks.length === 0) {
			this.logService.warn('[TaskGraphService] No spec session or tasks');
			return undefined;
		}

		const nodes: TaskNode[] = session.tasks.map(task => this.specTaskToNode(task));
		const edges: TaskEdge[] = [];

		// 从 SpecTask.dependencies 构建边
		for (const task of session.tasks) {
			if (task.dependencies) {
				for (const depId of task.dependencies) {
					edges.push({
						id: `tedge_${this.edgeIdCounter++}`,
						source: depId,
						target: task.id,
					});
				}
			}
		}

		// 如果没有显式依赖，按类型推断：同一 story 的 test 依赖 implementation
		if (edges.length === 0) {
			this.inferDependencies(nodes, edges);
		}

		this._graph = this.createGraph(session.originalRequirement.substring(0, 50), nodes, edges);
		return this._graph;
	}

	private specTaskToNode(task: SpecTask): TaskNode {
		return {
			id: task.id,
			title: task.title,
			description: task.description,
			type: this.mapTaskType(task.type),
			status: this.mapTaskStatus(task.status),
			column: 0,
			row: 0,
			dependencies: task.dependencies || [],
			storyId: task.storyId,
			estimatedEffort: task.estimatedEffort,
			result: task.result,
			createdAt: Date.now(),
		};
	}

	private mapTaskType(type: string): TaskNodeType {
		switch (type) {
			case 'implementation': return TaskNodeType.Implementation;
			case 'test': return TaskNodeType.Test;
			case 'documentation': return TaskNodeType.Documentation;
			case 'review': return TaskNodeType.Review;
			default: return TaskNodeType.Implementation;
		}
	}

	private mapTaskStatus(status: string): TaskNodeStatus {
		switch (status) {
			case 'pending': return TaskNodeStatus.Pending;
			case 'in_progress': return TaskNodeStatus.InProgress;
			case 'completed': return TaskNodeStatus.Completed;
			case 'blocked': return TaskNodeStatus.Blocked;
			case 'failed': return TaskNodeStatus.Failed;
			default: return TaskNodeStatus.Pending;
		}
	}

	/**
	 * 推断任务间的依赖关系：
	 * - 同一 story 的 test 任务依赖该 story 的 implementation 任务
	 * - review 任务依赖所有 implementation + test
	 * - documentation 可以并行
	 */
	private inferDependencies(nodes: TaskNode[], edges: TaskEdge[]): void {
		const byStory = new Map<string, TaskNode[]>();

		for (const node of nodes) {
			const storyId = node.storyId || 'default';
			const list = byStory.get(storyId) || [];
			list.push(node);
			byStory.set(storyId, list);
		}

		for (const [, storyNodes] of byStory) {
			const implNodes = storyNodes.filter(n => n.type === TaskNodeType.Implementation);
			const testNodes = storyNodes.filter(n => n.type === TaskNodeType.Test);
			const reviewNodes = storyNodes.filter(n => n.type === TaskNodeType.Review);

			// test 依赖 impl
			for (const testNode of testNodes) {
				for (const implNode of implNodes) {
					edges.push({
						id: `tedge_${this.edgeIdCounter++}`,
						source: implNode.id,
						target: testNode.id,
					});
					testNode.dependencies.push(implNode.id);
				}
			}

			// review 依赖 impl + test
			for (const reviewNode of reviewNodes) {
				for (const implNode of implNodes) {
					edges.push({
						id: `tedge_${this.edgeIdCounter++}`,
						source: implNode.id,
						target: reviewNode.id,
					});
					reviewNode.dependencies.push(implNode.id);
				}
				for (const testNode of testNodes) {
					edges.push({
						id: `tedge_${this.edgeIdCounter++}`,
						source: testNode.id,
						target: reviewNode.id,
					});
					reviewNode.dependencies.push(testNode.id);
				}
			}
		}
	}

	// ========================================================================
	// 图操作
	// ========================================================================

	createGraph(name: string, tasks: TaskNode[], edges: TaskEdge[]): TaskGraph {
		const graph: TaskGraph = {
			id: `graph_${Date.now()}`,
			name,
			nodes: new Map(tasks.map(t => [t.id, t])),
			edges,
			layers: [],
			criticalPath: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		this._graph = graph;
		this.autoLayout();
		this.computeCriticalPath();
		this.createExecutionPlan();

		this.logService.info(`[TaskGraphService] Created graph "${name}": ${tasks.length} nodes, ${edges.length} edges`);
		this._onDidUpdateGraph.fire(graph);

		return graph;
	}

	getGraph(): TaskGraph | undefined {
		return this._graph;
	}

	getPlan(): ExecutionPlan | undefined {
		return this._plan;
	}

	addNode(node: TaskNode): void {
		if (!this._graph) {
			return;
		}
		this._graph.nodes.set(node.id, node);
		this._graph.updatedAt = Date.now();
		this.autoLayout();
		this._onDidUpdateGraph.fire(this._graph);
	}

	addEdge(sourceId: string, targetId: string): boolean {
		if (!this._graph) {
			return false;
		}

		if (!this._graph.nodes.has(sourceId) || !this._graph.nodes.has(targetId)) {
			this.logService.warn(`[TaskGraphService] Cannot add edge: node not found`);
			return false;
		}

		// 临时添加边检测是否产生环
		const edge: TaskEdge = {
			id: `tedge_${this.edgeIdCounter++}`,
			source: sourceId,
			target: targetId,
		};
		this._graph.edges.push(edge);

		if (this.hasCycle()) {
			// 回滚
			this._graph.edges.pop();
			this.logService.warn(`[TaskGraphService] Cannot add edge: would create a cycle`);
			return false;
		}

		// 更新目标节点的依赖列表
		const targetNode = this._graph.nodes.get(targetId);
		if (targetNode && !targetNode.dependencies.includes(sourceId)) {
			targetNode.dependencies.push(sourceId);
		}

		this._graph.updatedAt = Date.now();
		this.autoLayout();
		this.computeCriticalPath();
		this._onDidUpdateGraph.fire(this._graph);
		return true;
	}

	removeNode(nodeId: string): void {
		if (!this._graph) {
			return;
		}

		this._graph.nodes.delete(nodeId);
		this._graph.edges = this._graph.edges.filter(e => e.source !== nodeId && e.target !== nodeId);

		// 清理其他节点的依赖引用
		for (const [, node] of this._graph.nodes) {
			node.dependencies = node.dependencies.filter(d => d !== nodeId);
		}

		this._graph.updatedAt = Date.now();
		this.autoLayout();
		this._onDidUpdateGraph.fire(this._graph);
	}

	// ========================================================================
	// 拓扑排序 (Kahn's Algorithm)
	// ========================================================================

	topologicalSort(): string[] {
		if (!this._graph) {
			return [];
		}

		const inDegree = new Map<string, number>();
		for (const [id] of this._graph.nodes) {
			inDegree.set(id, 0);
		}

		for (const edge of this._graph.edges) {
			inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
		}

		const queue: string[] = [];
		for (const [id, degree] of inDegree) {
			if (degree === 0) {
				queue.push(id);
			}
		}

		const result: string[] = [];
		while (queue.length > 0) {
			const nodeId = queue.shift()!;
			result.push(nodeId);

			for (const edge of this._graph.edges) {
				if (edge.source === nodeId) {
					const newDegree = (inDegree.get(edge.target) || 0) - 1;
					inDegree.set(edge.target, newDegree);
					if (newDegree === 0) {
						queue.push(edge.target);
					}
				}
			}
		}

		return result;
	}

	// ========================================================================
	// 关键路径
	// ========================================================================

	computeCriticalPath(): string[] {
		if (!this._graph) {
			return [];
		}

		const sorted = this.topologicalSort();
		if (sorted.length === 0) {
			return [];
		}

		// 每个节点的最早开始时间
		const earliest = new Map<string, number>();
		for (const id of sorted) {
			earliest.set(id, 0);
		}

		for (const id of sorted) {
			const currentEarliest = earliest.get(id) || 0;
			for (const edge of this._graph.edges) {
				if (edge.source === id) {
					const targetEarliest = earliest.get(edge.target) || 0;
					earliest.set(edge.target, Math.max(targetEarliest, currentEarliest + 1));
				}
			}
		}

		// 找到最长路径的终点
		let maxTime = 0;
		let endNode = sorted[0];
		for (const [id, time] of earliest) {
			if (time > maxTime) {
				maxTime = time;
				endNode = id;
			}
		}

		// 回溯关键路径
		const path: string[] = [endNode];
		let currentId = endNode;

		while (true) {
			const inEdges = this._graph.edges.filter(e => e.target === currentId);
			if (inEdges.length === 0) {
				break;
			}

			let bestSource = '';
			let bestTime = -1;
			for (const edge of inEdges) {
				const sourceTime = earliest.get(edge.source) || 0;
				if (sourceTime > bestTime) {
					bestTime = sourceTime;
					bestSource = edge.source;
				}
			}

			if (bestSource) {
				path.unshift(bestSource);
				currentId = bestSource;
			} else {
				break;
			}
		}

		this._graph.criticalPath = path;

		// 标记关键路径边
		for (const edge of this._graph.edges) {
			const sourceIdx = path.indexOf(edge.source);
			const targetIdx = path.indexOf(edge.target);
			edge.isCritical = sourceIdx >= 0 && targetIdx >= 0 && targetIdx === sourceIdx + 1;
		}

		return path;
	}

	// ========================================================================
	// 就绪任务 & 状态管理
	// ========================================================================

	getReadyTasks(): TaskNode[] {
		if (!this._graph) {
			return [];
		}

		const ready: TaskNode[] = [];

		for (const [, node] of this._graph.nodes) {
			if (node.status !== TaskNodeStatus.Pending && node.status !== TaskNodeStatus.Ready) {
				continue;
			}

			const allDepsCompleted = node.dependencies.every(depId => {
				const depNode = this._graph!.nodes.get(depId);
				return depNode && depNode.status === TaskNodeStatus.Completed;
			});

			if (allDepsCompleted) {
				node.status = TaskNodeStatus.Ready;
				ready.push(node);
			}
		}

		return ready;
	}

	updateNodeStatus(nodeId: string, status: TaskNodeStatus, result?: string): void {
		if (!this._graph) {
			return;
		}

		const node = this._graph.nodes.get(nodeId);
		if (!node) {
			return;
		}

		node.status = status;
		if (result !== undefined) {
			node.result = result;
		}
		if (status === TaskNodeStatus.Completed) {
			node.completedAt = Date.now();
		}

		this._graph.updatedAt = Date.now();

		// 同步到 SpecModeService
		switch (status) {
			case TaskNodeStatus.InProgress:
				this.specModeService.startTask(nodeId);
				break;
			case TaskNodeStatus.Completed:
				this.specModeService.completeTask(nodeId);
				break;
			case TaskNodeStatus.Failed:
				this.specModeService.failTask(nodeId, result);
				break;
		}

		// 刷新就绪状态
		this.getReadyTasks();

		// 更新执行计划进度
		this.updatePlanProgress();

		this._onDidChangeNodeStatus.fire({ nodeId, status });
		this._onDidUpdateGraph.fire(this._graph);
	}

	// ========================================================================
	// 执行控制
	// ========================================================================

	pause(): void {
		if (this._plan) {
			this._plan.isPaused = true;
			this.logService.info('[TaskGraphService] Execution paused');
			this._onDidUpdatePlan.fire(this._plan);
		}
	}

	resume(): void {
		if (this._plan) {
			this._plan.isPaused = false;
			this.logService.info('[TaskGraphService] Execution resumed');
			this._onDidUpdatePlan.fire(this._plan);
		}
	}

	reorderExecution(newOrder: string[]): void {
		if (!this._plan || !this._graph) {
			return;
		}

		// 验证新顺序不违反依赖约束
		const positionMap = new Map<string, number>();
		newOrder.forEach((id, idx) => positionMap.set(id, idx));

		for (const edge of this._graph.edges) {
			const sourcePos = positionMap.get(edge.source);
			const targetPos = positionMap.get(edge.target);
			if (sourcePos !== undefined && targetPos !== undefined && sourcePos >= targetPos) {
				this.logService.warn('[TaskGraphService] Invalid reorder: violates dependency constraint');
				return;
			}
		}

		this._plan.executionOrder = newOrder;
		this._onDidUpdatePlan.fire(this._plan);
	}

	// ========================================================================
	// 环检测 (DFS)
	// ========================================================================

	hasCycle(): boolean {
		if (!this._graph) {
			return false;
		}

		const WHITE = 0, GRAY = 1, BLACK = 2;
		const color = new Map<string, number>();
		for (const [id] of this._graph.nodes) {
			color.set(id, WHITE);
		}

		const dfs = (nodeId: string): boolean => {
			color.set(nodeId, GRAY);
			for (const edge of this._graph!.edges) {
				if (edge.source === nodeId) {
					const c = color.get(edge.target);
					if (c === GRAY) {
						return true;
					}
					if (c === WHITE && dfs(edge.target)) {
						return true;
					}
				}
			}
			color.set(nodeId, BLACK);
			return false;
		};

		for (const [id] of this._graph.nodes) {
			if (color.get(id) === WHITE) {
				if (dfs(id)) {
					return true;
				}
			}
		}

		return false;
	}

	// ========================================================================
	// 自动布局 (按拓扑层级分层)
	// ========================================================================

	autoLayout(): void {
		if (!this._graph) {
			return;
		}

		const sorted = this.topologicalSort();
		const layerMap = new Map<string, number>();

		// 计算每个节点的层级（最长路径到根）
		for (const id of sorted) {
			let maxParentLayer = -1;
			for (const edge of this._graph.edges) {
				if (edge.target === id) {
					const parentLayer = layerMap.get(edge.source) ?? 0;
					maxParentLayer = Math.max(maxParentLayer, parentLayer);
				}
			}
			layerMap.set(id, maxParentLayer + 1);
		}

		// 按层分组
		const layers: string[][] = [];
		for (const [id, layer] of layerMap) {
			while (layers.length <= layer) {
				layers.push([]);
			}
			layers[layer].push(id);
		}

		this._graph.layers = layers;

		// 设置节点坐标
		for (let col = 0; col < layers.length; col++) {
			for (let row = 0; row < layers[col].length; row++) {
				const nodeId = layers[col][row];
				const node = this._graph.nodes.get(nodeId);
				if (node) {
					node.column = col;
					node.row = row;
				}
			}
		}
	}

	// ========================================================================
	// 进度
	// ========================================================================

	getProgress(): { completed: number; total: number; percent: number } {
		if (!this._graph) {
			return { completed: 0, total: 0, percent: 0 };
		}

		let completed = 0;
		let total = 0;

		for (const [, node] of this._graph.nodes) {
			total++;
			if (node.status === TaskNodeStatus.Completed || node.status === TaskNodeStatus.Skipped) {
				completed++;
			}
		}

		return {
			completed,
			total,
			percent: total > 0 ? Math.round((completed / total) * 100) : 0,
		};
	}

	// ========================================================================
	// 私有方法
	// ========================================================================

	private createExecutionPlan(): void {
		if (!this._graph) {
			return;
		}

		const sorted = this.topologicalSort();

		this._plan = {
			graphId: this._graph.id,
			executionOrder: sorted,
			currentIndex: 0,
			isPaused: false,
			progress: 0,
		};

		this._onDidUpdatePlan.fire(this._plan);
	}

	private updatePlanProgress(): void {
		if (!this._plan) {
			return;
		}

		const { percent } = this.getProgress();
		this._plan.progress = percent;

		// 找到第一个未完成的任务作为当前索引
		for (let i = 0; i < this._plan.executionOrder.length; i++) {
			const nodeId = this._plan.executionOrder[i];
			const node = this._graph?.nodes.get(nodeId);
			if (node && node.status !== TaskNodeStatus.Completed && node.status !== TaskNodeStatus.Skipped) {
				this._plan.currentIndex = i;
				break;
			}
		}

		this._onDidUpdatePlan.fire(this._plan);
	}
}

registerSingleton(ITaskGraphService, TaskGraphService, InstantiationType.Delayed);
