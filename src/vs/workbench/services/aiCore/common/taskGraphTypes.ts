/*---------------------------------------------------------------------------------------------
 *  Task Graph Types (DAG)
 *  可视化任务图的数据结构 —— 有向无环图 (DAG)
 *---------------------------------------------------------------------------------------------*/

// ============================================================================
// DAG 节点 (任务节点)
// ============================================================================

export enum TaskNodeStatus {
	Pending = 'pending',
	Ready = 'ready',
	InProgress = 'in_progress',
	Completed = 'completed',
	Failed = 'failed',
	Blocked = 'blocked',
	Skipped = 'skipped',
}

export enum TaskNodeType {
	Implementation = 'implementation',
	Test = 'test',
	Documentation = 'documentation',
	Review = 'review',
	Design = 'design',
	Checkpoint = 'checkpoint',
}

export interface TaskNode {
	id: string;
	title: string;
	description: string;
	type: TaskNodeType;
	status: TaskNodeStatus;
	/** DAG 中的 x 位置（列，拓扑层级） */
	column: number;
	/** DAG 中的 y 位置（行，同层内排序） */
	row: number;
	/** 依赖的前置任务 ID 列表 */
	dependencies: string[];
	/** 关联的用户故事 ID */
	storyId?: string;
	/** 关联的文件路径 */
	files?: string[];
	/** 预估工作量 */
	estimatedEffort?: string;
	/** 任务执行结果 */
	result?: string;
	/** 关联的 Git 检查点 ID */
	checkpointId?: string;
	/** 创建时间 */
	createdAt: number;
	/** 完成时间 */
	completedAt?: number;
}

// ============================================================================
// DAG 边 (依赖关系)
// ============================================================================

export interface TaskEdge {
	id: string;
	/** 前置任务（被依赖方） */
	source: string;
	/** 后续任务（依赖方） */
	target: string;
	/** 是否为关键路径上的边 */
	isCritical?: boolean;
}

// ============================================================================
// 任务图整体
// ============================================================================

export interface TaskGraph {
	id: string;
	name: string;
	nodes: Map<string, TaskNode>;
	edges: TaskEdge[];
	/** 拓扑层级（每层包含哪些节点） */
	layers: string[][];
	/** 关键路径上的节点 ID */
	criticalPath: string[];
	createdAt: number;
	updatedAt: number;
}

// ============================================================================
// 执行计划（可由用户编辑）
// ============================================================================

export interface ExecutionPlan {
	graphId: string;
	/** 按执行顺序排列的任务 ID */
	executionOrder: string[];
	/** 当前正在执行的任务索引 */
	currentIndex: number;
	/** 是否暂停 */
	isPaused: boolean;
	/** 全局进度 (0-100) */
	progress: number;
}

// ============================================================================
// Webview 通信协议
// ============================================================================

export type TaskGraphToWebviewMessage =
	| { type: 'init'; payload: { graph: SerializedTaskGraph; plan: ExecutionPlan } }
	| { type: 'graphUpdated'; payload: { graph: SerializedTaskGraph } }
	| { type: 'nodeStatusChanged'; payload: { nodeId: string; status: TaskNodeStatus; result?: string } }
	| { type: 'planUpdated'; payload: { plan: ExecutionPlan } }
	| { type: 'themeChanged'; payload: { theme: string } };

export type TaskGraphFromWebviewMessage =
	| { type: 'ready' }
	| { type: 'startTask'; payload: { nodeId: string } }
	| { type: 'retryTask'; payload: { nodeId: string } }
	| { type: 'skipTask'; payload: { nodeId: string } }
	| { type: 'pauseExecution' }
	| { type: 'resumeExecution' }
	| { type: 'editPlan'; payload: { executionOrder: string[] } }
	| { type: 'rollbackToCheckpoint'; payload: { checkpointId: string } }
	| { type: 'approveAndContinue' };

// ============================================================================
// 序列化（Webview 传输用，Map → 对象）
// ============================================================================

export interface SerializedTaskGraph {
	id: string;
	name: string;
	nodes: Record<string, TaskNode>;
	edges: TaskEdge[];
	layers: string[][];
	criticalPath: string[];
	createdAt: number;
	updatedAt: number;
}

export function serializeTaskGraph(graph: TaskGraph): SerializedTaskGraph {
	const nodes: Record<string, TaskNode> = {};
	for (const [id, node] of graph.nodes) {
		nodes[id] = node;
	}
	return {
		id: graph.id,
		name: graph.name,
		nodes,
		edges: graph.edges,
		layers: graph.layers,
		criticalPath: graph.criticalPath,
		createdAt: graph.createdAt,
		updatedAt: graph.updatedAt,
	};
}

export function deserializeTaskGraph(data: SerializedTaskGraph): TaskGraph {
	const nodes = new Map<string, TaskNode>();
	for (const [id, node] of Object.entries(data.nodes)) {
		nodes.set(id, node);
	}
	return {
		id: data.id,
		name: data.name,
		nodes,
		edges: data.edges,
		layers: data.layers,
		criticalPath: data.criticalPath,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
	};
}
