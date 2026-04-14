/*---------------------------------------------------------------------------------------------
 *  Code Semantic Graph Types (Code-GraphRAG)
 *  代码语义图谱数据结构 —— 将代码从平面索引升级为图谱结构
 *---------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { CodeChunkType } from './codeIndexTypes.js';

// ============================================================================
// 图谱节点 (Graph Node)
// ============================================================================

export enum GraphNodeKind {
	File = 'file',
	Class = 'class',
	Interface = 'interface',
	Function = 'function',
	Method = 'method',
	Variable = 'variable',
	Type = 'type',
	Module = 'module',
	Package = 'package',
	Enum = 'enum',
}

export interface GraphNode {
	id: string;
	kind: GraphNodeKind;
	name: string;
	qualifiedName: string;
	uri: URI;
	startLine: number;
	endLine: number;
	language: string;
	signature?: string;
	docComment?: string;
	/** 源 CodeChunk ID，用于与向量索引关联 */
	chunkId?: string;
	/** 节点属性（可扩展） */
	attributes: Record<string, string>;
}

// ============================================================================
// 图谱边 (Graph Edge) —— 实体之间的关系
// ============================================================================

export enum GraphEdgeKind {
	/** 文件包含符号 */
	Contains = 'contains',
	/** 类继承 */
	Extends = 'extends',
	/** 接口实现 */
	Implements = 'implements',
	/** 函数/方法调用 */
	Calls = 'calls',
	/** 类型引用 */
	References = 'references',
	/** 导入依赖 */
	Imports = 'imports',
	/** 方法属于类 */
	MemberOf = 'memberOf',
	/** 返回类型 */
	Returns = 'returns',
	/** 参数类型 */
	ParameterType = 'parameterType',
	/** 文件间依赖 */
	DependsOn = 'dependsOn',
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	kind: GraphEdgeKind;
	/** 权重（用于排序和优先级） */
	weight: number;
	/** 附加属性 */
	attributes?: Record<string, string>;
}

// ============================================================================
// 图谱整体
// ============================================================================

export interface CodeGraph {
	nodes: Map<string, GraphNode>;
	edges: GraphEdge[];
	/** 倒排索引：节点名 → 节点 ID 列表 */
	nameIndex: Map<string, string[]>;
	/** 文件索引：文件 URI → 节点 ID 列表 */
	fileIndex: Map<string, string[]>;
	/** 邻接表：节点 ID → 出边列表 */
	adjacency: Map<string, GraphEdge[]>;
	/** 反向邻接表：节点 ID → 入边列表 */
	reverseAdjacency: Map<string, GraphEdge[]>;
	lastUpdated: number;
}

// ============================================================================
// 图谱查询
// ============================================================================

export interface GraphQuery {
	/** 起始节点 ID 或名称 */
	startNode?: string;
	/** 关系类型过滤 */
	edgeKinds?: GraphEdgeKind[];
	/** 节点类型过滤 */
	nodeKinds?: GraphNodeKind[];
	/** 最大深度 */
	maxDepth?: number;
	/** 最大返回节点数 */
	maxNodes?: number;
}

export interface GraphQueryResult {
	nodes: GraphNode[];
	edges: GraphEdge[];
	paths: GraphPath[];
}

export interface GraphPath {
	nodes: string[];
	edges: string[];
	totalWeight: number;
}

// ============================================================================
// 语义对齐结果
// ============================================================================

export interface SemanticAlignmentResult {
	/** 从自然语言中识别的实体 */
	mentionedEntities: GraphNode[];
	/** 图谱中关联的实体 */
	relatedEntities: GraphNode[];
	/** 补全的上下文（缺失的依赖、接口等） */
	inferredContext: string[];
	/** 推荐查看的文件 */
	relevantFiles: URI[];
}

// ============================================================================
// 工具函数
// ============================================================================

export function chunkTypeToNodeKind(chunkType: CodeChunkType): GraphNodeKind {
	switch (chunkType) {
		case CodeChunkType.Class: return GraphNodeKind.Class;
		case CodeChunkType.Interface: return GraphNodeKind.Interface;
		case CodeChunkType.Function: return GraphNodeKind.Function;
		case CodeChunkType.Type: return GraphNodeKind.Type;
		case CodeChunkType.Variable: return GraphNodeKind.Variable;
		case CodeChunkType.File: return GraphNodeKind.File;
		default: return GraphNodeKind.Function;
	}
}

export function createEmptyGraph(): CodeGraph {
	return {
		nodes: new Map(),
		edges: [],
		nameIndex: new Map(),
		fileIndex: new Map(),
		adjacency: new Map(),
		reverseAdjacency: new Map(),
		lastUpdated: 0,
	};
}
