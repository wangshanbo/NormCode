/*---------------------------------------------------------------------------------------------
 *  Code Semantic Graph Service (Code-GraphRAG)
 *  代码语义图谱服务 —— 基于代码索引构建实体-关系图谱
 *---------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeIndexService } from './codeIndexService.js';
import { CodeChunk, CodeChunkType } from '../common/codeIndexTypes.js';
import {
	CodeGraph,
	GraphNode,
	GraphEdge,
	GraphNodeKind,
	GraphEdgeKind,
	GraphQuery,
	GraphQueryResult,
	SemanticAlignmentResult,
	chunkTypeToNodeKind,
	createEmptyGraph,
} from '../common/codeGraphTypes.js';
import { IEmbeddingService } from '../common/embeddingService.js';

export const ICodeGraphService = createDecorator<ICodeGraphService>('ICodeGraphService');

// ============================================================================
// 接口定义
// ============================================================================

export interface ICodeGraphService {
	readonly _serviceBrand: undefined;

	readonly onDidUpdateGraph: Event<CodeGraph>;

	/** 从代码索引构建图谱 */
	buildGraph(): Promise<void>;

	/** 增量更新：文件变更时更新图谱 */
	updateFileInGraph(uri: URI): Promise<void>;

	/** 移除文件节点及其关联边 */
	removeFileFromGraph(uri: URI): void;

	/** 获取当前图谱 */
	getGraph(): CodeGraph;

	/** 图谱查询：BFS/DFS 遍历 */
	query(q: GraphQuery): GraphQueryResult;

	/** 查找节点的所有关联节点（N 跳邻居） */
	findRelated(nodeId: string, maxDepth?: number): GraphNode[];

	/** 语义对齐：从自然语言提取实体并关联图谱 */
	semanticAlign(naturalLanguage: string): Promise<SemanticAlignmentResult>;

	/** 获取图谱统计信息 */
	getStats(): GraphStats;
}

export interface GraphStats {
	totalNodes: number;
	totalEdges: number;
	nodesByKind: Record<string, number>;
	edgesByKind: Record<string, number>;
	lastUpdated: number;
}

// ============================================================================
// 服务实现
// ============================================================================

export class CodeGraphService extends Disposable implements ICodeGraphService {
	readonly _serviceBrand: undefined;

	private graph: CodeGraph = createEmptyGraph();
	private edgeIdCounter = 0;

	private readonly _onDidUpdateGraph = this._register(new Emitter<CodeGraph>());
	readonly onDidUpdateGraph = this._onDidUpdateGraph.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICodeIndexService private readonly codeIndexService: ICodeIndexService,
		@IEmbeddingService _embeddingService: IEmbeddingService,
	) {
		super();
		void _embeddingService;

		this._register(this.codeIndexService.onDidChangeStatus(status => {
			if (!status.isIndexing && status.indexedChunks > 0) {
				this.buildGraph().catch(err =>
					this.logService.error(`[CodeGraphService] Auto-build failed: ${String(err)}`)
				);
			}
		}));
	}

	// ========================================================================
	// 图谱构建
	// ========================================================================

	async buildGraph(): Promise<void> {
		this.logService.info('[CodeGraphService] Building code semantic graph...');
		const startTime = Date.now();

		this.graph = createEmptyGraph();
		this.edgeIdCounter = 0;

		const status = this.codeIndexService.getStatus();
		if (status.indexedChunks === 0) {
			this.logService.warn('[CodeGraphService] No indexed chunks, skipping graph build');
			return;
		}

		// Phase 1: 从代码块提取节点
		this.extractNodesFromIndex();

		// Phase 2: 分析代码内容提取关系（边）
		this.extractEdgesFromContent();

		this.graph.lastUpdated = Date.now();
		const elapsed = Date.now() - startTime;

		this.logService.info(
			`[CodeGraphService] Graph built in ${elapsed}ms: ` +
			`${this.graph.nodes.size} nodes, ${this.graph.edges.length} edges`
		);

		this._onDidUpdateGraph.fire(this.graph);
	}

	/**
	 * 从 CodeIndexService 的代码块中提取图节点
	 */
	private extractNodesFromIndex(): void {
		const status = this.codeIndexService.getStatus();
		if (status.indexedChunks === 0) {
			return;
		}

		// 遍历索引中的所有块，利用 getChunks 通过已知文件
		// 由于 CodeIndexService 没有暴露所有 chunk 的方法，我们通过 search 获取
		// 但更高效的方式是直接遍历，这里我们通过已有的 fileChunks 索引间接获取
		// 使用一个广搜索来获取所有代码块
		this.buildNodesFromAllChunks();
	}

	private buildNodesFromAllChunks(): void {
		// 通过 codeIndexService 的 getStatus 获知有索引数据
		// 然后通过 search 以空查询的方式获取所有块 (利用低 minScore)
		// 更好的方式是直接暴露 getAllChunks，但当前架构下我们使用类型化搜索
		const status = this.codeIndexService.getStatus();
		this.logService.trace(`[CodeGraphService] Processing ${status.indexedChunks} indexed chunks`);

		// 我们无法直接遍历 CodeIndexService 的内部 Map，
		// 但可以通过 getChunks(uri) 逐文件获取。
		// 这需要知道哪些文件被索引了 —— 通过 search 模拟获取。
		// 实际上，更合理的做法是在 CodeIndexService 上添加 getAllChunks 方法，
		// 但为不修改现有接口，我们通过 search 获取足够多的结果。

		// 使用搜索获取所有类/接口/函数节点
		const chunkTypesToIndex: CodeChunkType[] = [
			CodeChunkType.Class,
			CodeChunkType.Interface,
			CodeChunkType.Function,
			CodeChunkType.Type,
			CodeChunkType.Variable,
			CodeChunkType.File,
		];

		for (const chunkType of chunkTypesToIndex) {
			this.codeIndexService.search({
				query: '*',
				topK: 10000,
				minScore: 0,
				chunkTypes: [chunkType],
			}).then(response => {
				for (const result of response.results) {
					this.addChunkAsNode(result.chunk);
				}
			}).catch(() => {
				// 静默处理
			});
		}
	}

	private addChunkAsNode(chunk: CodeChunk): void {
		if (!chunk.name && chunk.type === CodeChunkType.File) {
			// 文件节点使用路径最后一段作为名称
			chunk.name = chunk.path.split('/').pop() || chunk.path;
		}

		if (!chunk.name) {
			return;
		}

		const nodeId = `node_${chunk.id}`;
		const node: GraphNode = {
			id: nodeId,
			kind: chunkTypeToNodeKind(chunk.type),
			name: chunk.name,
			qualifiedName: `${chunk.path}::${chunk.name}`,
			uri: chunk.uri,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			language: chunk.language,
			signature: chunk.signature,
			docComment: chunk.docComment,
			chunkId: chunk.id,
			attributes: {},
		};

		this.graph.nodes.set(nodeId, node);

		// 更新名称索引
		const nameList = this.graph.nameIndex.get(chunk.name) || [];
		nameList.push(nodeId);
		this.graph.nameIndex.set(chunk.name, nameList);

		// 更新文件索引
		const fileKey = chunk.uri.toString();
		const fileList = this.graph.fileIndex.get(fileKey) || [];
		fileList.push(nodeId);
		this.graph.fileIndex.set(fileKey, fileList);

		// 如果有 parentId，创建 Contains/MemberOf 边
		if (chunk.parentId) {
			const parentNodeId = `node_${chunk.parentId}`;
			this.addEdge(parentNodeId, nodeId, GraphEdgeKind.Contains);
			this.addEdge(nodeId, parentNodeId, GraphEdgeKind.MemberOf);
		}
	}

	/**
	 * 通过分析代码内容提取实体间的关系
	 */
	private extractEdgesFromContent(): void {
		for (const [, node] of this.graph.nodes) {
			if (node.kind === GraphNodeKind.File) {
				continue;
			}

			// 获取节点对应的代码块
			const chunks = this.codeIndexService.getChunks(node.uri);
			const chunk = chunks.find(c => c.id === node.chunkId);
			if (!chunk) {
				continue;
			}

			this.extractRelationsFromCode(node, chunk);
		}
	}

	private extractRelationsFromCode(node: GraphNode, chunk: CodeChunk): void {
		const content = chunk.content;
		const lang = chunk.language;

		if (lang === 'typescript' || lang === 'typescriptreact' || lang === 'javascript' || lang === 'javascriptreact') {
			this.extractTSRelations(node, content);
		} else if (lang === 'python') {
			this.extractPythonRelations(node, content);
		} else if (lang === 'java' || lang === 'csharp') {
			this.extractJavaLikeRelations(node, content);
		} else if (lang === 'go') {
			this.extractGoRelations(node, content);
		} else if (lang === 'rust') {
			this.extractRustRelations(node, content);
		}
	}

	private extractTSRelations(node: GraphNode, content: string): void {
		// extends
		const extendsMatch = content.match(/(?:class|interface)\s+\w+(?:<[^>]*>)?\s+extends\s+([\w.]+)/);
		if (extendsMatch) {
			this.addEdgeByName(node.id, extendsMatch[1], GraphEdgeKind.Extends);
		}

		// implements
		const implMatch = content.match(/class\s+\w+(?:<[^>]*>)?(?:\s+extends\s+[\w.]+)?\s+implements\s+([\w.,\s]+)/);
		if (implMatch) {
			const interfaces = implMatch[1].split(',').map(s => s.trim());
			for (const iface of interfaces) {
				if (iface) {
					this.addEdgeByName(node.id, iface, GraphEdgeKind.Implements);
				}
			}
		}

		// import 依赖
		const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
		let importMatch;
		while ((importMatch = importRegex.exec(content)) !== null) {
			const imported = importMatch[1] || importMatch[2];
			if (imported) {
				const symbols = imported.split(',').map(s => s.trim().split(' as ')[0].trim());
				for (const sym of symbols) {
					if (sym) {
						this.addEdgeByName(node.id, sym, GraphEdgeKind.Imports);
					}
				}
			}
		}

		// 函数调用（简单匹配 identifier( )
		const callRegex = /(?<!\w)([A-Z]\w+)\s*\(/g;
		let callMatch;
		while ((callMatch = callRegex.exec(content)) !== null) {
			const callee = callMatch[1];
			if (callee !== node.name && callee.length > 1) {
				this.addEdgeByName(node.id, callee, GraphEdgeKind.Calls, 0.5);
			}
		}

		// 类型引用
		const typeRefRegex = /:\s*([A-Z]\w+)(?:<|[\s,;\)])/g;
		let typeMatch;
		while ((typeMatch = typeRefRegex.exec(content)) !== null) {
			const typeName = typeMatch[1];
			if (typeName !== node.name && typeName.length > 1) {
				this.addEdgeByName(node.id, typeName, GraphEdgeKind.References, 0.3);
			}
		}
	}

	private extractPythonRelations(node: GraphNode, content: string): void {
		const classMatch = content.match(/class\s+\w+\(([^)]+)\)/);
		if (classMatch) {
			const bases = classMatch[1].split(',').map(s => s.trim());
			for (const base of bases) {
				if (base && base !== 'object') {
					this.addEdgeByName(node.id, base, GraphEdgeKind.Extends);
				}
			}
		}

		const importRegex = /(?:from\s+\S+\s+)?import\s+(.+)/g;
		let match;
		while ((match = importRegex.exec(content)) !== null) {
			const symbols = match[1].split(',').map(s => s.trim().split(' as ')[0].trim());
			for (const sym of symbols) {
				if (sym) {
					this.addEdgeByName(node.id, sym, GraphEdgeKind.Imports);
				}
			}
		}
	}

	private extractJavaLikeRelations(node: GraphNode, content: string): void {
		const extendsMatch = content.match(/class\s+\w+\s+extends\s+(\w+)/);
		if (extendsMatch) {
			this.addEdgeByName(node.id, extendsMatch[1], GraphEdgeKind.Extends);
		}

		const implMatch = content.match(/class\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+)/);
		if (implMatch) {
			const interfaces = implMatch[1].split(',').map(s => s.trim());
			for (const iface of interfaces) {
				if (iface) {
					this.addEdgeByName(node.id, iface, GraphEdgeKind.Implements);
				}
			}
		}
	}

	private extractGoRelations(node: GraphNode, content: string): void {
		const embedRegex = /^\s*(\w+)\s*$/gm;
		let match;
		while ((match = embedRegex.exec(content)) !== null) {
			this.addEdgeByName(node.id, match[1], GraphEdgeKind.Extends, 0.3);
		}
	}

	private extractRustRelations(node: GraphNode, content: string): void {
		const implMatch = content.match(/impl(?:<[^>]*>)?\s+(\w+)\s+for\s+(\w+)/);
		if (implMatch) {
			this.addEdgeByName(node.id, implMatch[1], GraphEdgeKind.Implements);
		}

		const useRegex = /use\s+[\w:]+::(\w+)/g;
		let match;
		while ((match = useRegex.exec(content)) !== null) {
			this.addEdgeByName(node.id, match[1], GraphEdgeKind.Imports);
		}
	}

	// ========================================================================
	// 边操作
	// ========================================================================

	private addEdge(sourceId: string, targetId: string, kind: GraphEdgeKind, weight: number = 1.0): void {
		if (!this.graph.nodes.has(sourceId) || !this.graph.nodes.has(targetId)) {
			return;
		}
		if (sourceId === targetId) {
			return;
		}

		const existing = this.graph.edges.find(
			e => e.source === sourceId && e.target === targetId && e.kind === kind
		);
		if (existing) {
			existing.weight = Math.max(existing.weight, weight);
			return;
		}

		const edge: GraphEdge = {
			id: `edge_${this.edgeIdCounter++}`,
			source: sourceId,
			target: targetId,
			kind,
			weight,
		};

		this.graph.edges.push(edge);

		const adjList = this.graph.adjacency.get(sourceId) || [];
		adjList.push(edge);
		this.graph.adjacency.set(sourceId, adjList);

		const revList = this.graph.reverseAdjacency.get(targetId) || [];
		revList.push(edge);
		this.graph.reverseAdjacency.set(targetId, revList);
	}

	private addEdgeByName(sourceId: string, targetName: string, kind: GraphEdgeKind, weight: number = 1.0): void {
		const targetIds = this.graph.nameIndex.get(targetName);
		if (targetIds) {
			for (const targetId of targetIds) {
				this.addEdge(sourceId, targetId, kind, weight);
			}
		}
	}

	// ========================================================================
	// 增量更新
	// ========================================================================

	async updateFileInGraph(uri: URI): Promise<void> {
		this.removeFileFromGraph(uri);

		const chunks = this.codeIndexService.getChunks(uri);
		for (const chunk of chunks) {
			this.addChunkAsNode(chunk);
		}

		// 重新提取该文件节点的关系
		const fileKey = uri.toString();
		const nodeIds = this.graph.fileIndex.get(fileKey) || [];
		for (const nodeId of nodeIds) {
			const node = this.graph.nodes.get(nodeId);
			if (!node || node.kind === GraphNodeKind.File) {
				continue;
			}
			const chunks2 = this.codeIndexService.getChunks(uri);
			const chunk = chunks2.find(c => c.id === node.chunkId);
			if (chunk) {
				this.extractRelationsFromCode(node, chunk);
			}
		}

		this.graph.lastUpdated = Date.now();
		this._onDidUpdateGraph.fire(this.graph);
	}

	removeFileFromGraph(uri: URI): void {
		const fileKey = uri.toString();
		const nodeIds = this.graph.fileIndex.get(fileKey) || [];

		for (const nodeId of nodeIds) {
			this.graph.nodes.delete(nodeId);

			// 移除名称索引
			for (const [name, ids] of this.graph.nameIndex) {
				const filtered = ids.filter(id => id !== nodeId);
				if (filtered.length === 0) {
					this.graph.nameIndex.delete(name);
				} else {
					this.graph.nameIndex.set(name, filtered);
				}
			}

			// 移除邻接表
			this.graph.adjacency.delete(nodeId);
			this.graph.reverseAdjacency.delete(nodeId);
		}

		// 移除相关边
		this.graph.edges = this.graph.edges.filter(
			e => !nodeIds.includes(e.source) && !nodeIds.includes(e.target)
		);

		// 清理其他节点的邻接表中引用被删节点的边
		for (const [key, edges] of this.graph.adjacency) {
			this.graph.adjacency.set(key, edges.filter(e => !nodeIds.includes(e.target)));
		}
		for (const [key, edges] of this.graph.reverseAdjacency) {
			this.graph.reverseAdjacency.set(key, edges.filter(e => !nodeIds.includes(e.source)));
		}

		this.graph.fileIndex.delete(fileKey);
	}

	// ========================================================================
	// 图谱查询
	// ========================================================================

	getGraph(): CodeGraph {
		return this.graph;
	}

	query(q: GraphQuery): GraphQueryResult {
		const result: GraphQueryResult = { nodes: [], edges: [], paths: [] };
		const maxDepth = q.maxDepth ?? 3;
		const maxNodes = q.maxNodes ?? 50;

		if (!q.startNode) {
			// 返回所有匹配过滤条件的节点
			for (const [, node] of this.graph.nodes) {
				if (q.nodeKinds && !q.nodeKinds.includes(node.kind)) {
					continue;
				}
				result.nodes.push(node);
				if (result.nodes.length >= maxNodes) {
					break;
				}
			}
			return result;
		}

		// BFS 遍历
		let startNodeId = q.startNode;
		if (!this.graph.nodes.has(startNodeId)) {
			const ids = this.graph.nameIndex.get(q.startNode);
			if (ids && ids.length > 0) {
				startNodeId = ids[0];
			} else {
				return result;
			}
		}

		const visited = new Set<string>();
		const queue: Array<{ nodeId: string; depth: number; path: string[] }> = [
			{ nodeId: startNodeId, depth: 0, path: [startNodeId] },
		];

		while (queue.length > 0 && result.nodes.length < maxNodes) {
			const item = queue.shift()!;
			if (visited.has(item.nodeId)) {
				continue;
			}
			visited.add(item.nodeId);

			const node = this.graph.nodes.get(item.nodeId);
			if (!node) {
				continue;
			}

			if (q.nodeKinds && !q.nodeKinds.includes(node.kind)) {
				continue;
			}

			result.nodes.push(node);

			if (item.depth < maxDepth) {
				const outEdges = this.graph.adjacency.get(item.nodeId) || [];
				for (const edge of outEdges) {
					if (q.edgeKinds && !q.edgeKinds.includes(edge.kind)) {
						continue;
					}
					if (!visited.has(edge.target)) {
						result.edges.push(edge);
						queue.push({
							nodeId: edge.target,
							depth: item.depth + 1,
							path: [...item.path, edge.target],
						});
					}
				}
			}

			if (item.path.length > 1) {
				const pathEdgeIds = [];
				for (let i = 0; i < item.path.length - 1; i++) {
					const e = this.graph.edges.find(
						e2 => e2.source === item.path[i] && e2.target === item.path[i + 1]
					);
					if (e) {
						pathEdgeIds.push(e.id);
					}
				}
				result.paths.push({
					nodes: item.path,
					edges: pathEdgeIds,
					totalWeight: pathEdgeIds.length,
				});
			}
		}

		return result;
	}

	findRelated(nodeId: string, maxDepth: number = 2): GraphNode[] {
		const result = this.query({
			startNode: nodeId,
			maxDepth,
			maxNodes: 30,
		});
		return result.nodes.filter(n => n.id !== nodeId);
	}

	// ========================================================================
	// 语义对齐
	// ========================================================================

	async semanticAlign(naturalLanguage: string): Promise<SemanticAlignmentResult> {
		const result: SemanticAlignmentResult = {
			mentionedEntities: [],
			relatedEntities: [],
			inferredContext: [],
			relevantFiles: [],
		};

		// Step 1: 从自然语言中提取可能的实体名（大写开头的词、驼峰命名等）
		const entityPattern = /\b([A-Z][a-zA-Z0-9]+(?:Service|Controller|Model|View|Component|Manager|Handler|Factory|Builder|Provider|Repository|Store|API|Config|Utils?)?)\b/g;
		const candidates = new Set<string>();
		let match;
		while ((match = entityPattern.exec(naturalLanguage)) !== null) {
			candidates.add(match[1]);
		}

		// 也提取中文关键词后可能对应的英文实体
		const keywords = naturalLanguage.match(/[\u4e00-\u9fa5]+/g) || [];

		// Step 2: 在图谱中查找匹配的实体
		for (const candidate of candidates) {
			const nodeIds = this.graph.nameIndex.get(candidate);
			if (nodeIds) {
				for (const id of nodeIds) {
					const node = this.graph.nodes.get(id);
					if (node) {
						result.mentionedEntities.push(node);
					}
				}
			}
		}

		// Step 3: 通过向量搜索补充（利用 embedding 检索相关代码块）
		if (keywords.length > 0 || candidates.size > 0) {
			try {
				const searchResults = await this.codeIndexService.search({
					query: naturalLanguage,
					topK: 10,
					minScore: 0.4,
				});

				for (const sr of searchResults.results) {
					if (sr.chunk.name) {
						const nodeIds = this.graph.nameIndex.get(sr.chunk.name);
						if (nodeIds) {
							for (const id of nodeIds) {
								const node = this.graph.nodes.get(id);
								if (node && !result.mentionedEntities.find(n => n.id === id)) {
									result.relatedEntities.push(node);
								}
							}
						}
					}
				}
			} catch {
				// 搜索失败不影响主流程
			}
		}

		// Step 4: 沿图谱扩展关联实体
		const allMentioned = [...result.mentionedEntities, ...result.relatedEntities];
		const relatedSet = new Set<string>(allMentioned.map(n => n.id));

		for (const entity of allMentioned) {
			const neighbors = this.findRelated(entity.id, 1);
			for (const neighbor of neighbors) {
				if (!relatedSet.has(neighbor.id)) {
					relatedSet.add(neighbor.id);
					result.relatedEntities.push(neighbor);
				}
			}
		}

		// Step 5: 推断补全的上下文
		for (const entity of result.mentionedEntities) {
			const inEdges = this.graph.reverseAdjacency.get(entity.id) || [];
			for (const edge of inEdges) {
				if (edge.kind === GraphEdgeKind.Implements || edge.kind === GraphEdgeKind.Extends) {
					const parent = this.graph.nodes.get(edge.source);
					if (parent) {
						result.inferredContext.push(
							`${entity.name} ${edge.kind === GraphEdgeKind.Extends ? '继承自' : '实现了'} ${parent.name}`
						);
					}
				}
			}
		}

		// Step 6: 收集相关文件
		const fileSet = new Set<string>();
		for (const entity of [...result.mentionedEntities, ...result.relatedEntities]) {
			const key = entity.uri.toString();
			if (!fileSet.has(key)) {
				fileSet.add(key);
				result.relevantFiles.push(entity.uri);
			}
		}

		return result;
	}

	// ========================================================================
	// 统计信息
	// ========================================================================

	getStats(): GraphStats {
		const nodesByKind: Record<string, number> = {};
		for (const [, node] of this.graph.nodes) {
			nodesByKind[node.kind] = (nodesByKind[node.kind] || 0) + 1;
		}

		const edgesByKind: Record<string, number> = {};
		for (const edge of this.graph.edges) {
			edgesByKind[edge.kind] = (edgesByKind[edge.kind] || 0) + 1;
		}

		return {
			totalNodes: this.graph.nodes.size,
			totalEdges: this.graph.edges.length,
			nodesByKind,
			edgesByKind,
			lastUpdated: this.graph.lastUpdated,
		};
	}
}

registerSingleton(ICodeGraphService, CodeGraphService, InstantiationType.Delayed);
