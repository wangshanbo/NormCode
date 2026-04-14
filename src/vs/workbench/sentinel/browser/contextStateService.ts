/*---------------------------------------------------------------------------------------------
 *  Sentinel Context State Service
 *  TreeSitter AST + LSP 诊断 + CodeIndex 驱动的上下文构建
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILSPFeedbackService } from '../../services/aiCore/browser/lspFeedbackService.js';
import { ICodeIndexService } from '../../services/aiCore/browser/codeIndexService.js';
import { ITreeSitterService } from '../../services/aiCore/browser/treeSitterService.js';
import { ContextStateObject, ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { pickWorkspaceFolderByProbes } from '../common/sentinelWorkspaceRootPick.js';

/** 当 IntentCard 未限定 allowedFiles 时，仍尝试读取这些路径以构建 CSO（避免实现器「看不见」已有工程） */
const DEFAULT_BOOTSTRAP_RELATIVE_PATHS = [
	'package.json',
	'index.html',
	'public/index.html',
	'tsconfig.json',
	'tsconfig.node.json',
	'vite.config.ts',
	// CRA / 常见入口（与 Vite 的 main.tsx 二选一存在即可）
	'src/index.js',
	'src/index.jsx',
	'src/index.tsx',
	'src/main.tsx',
	'src/main.jsx',
	'src/App.js',
	'src/App.jsx',
	'src/App.tsx',
	'src/index.css',
];

export const IContextStateService = createDecorator<IContextStateService>('IContextStateService');

export type BuildContextStateOptions = Partial<ContextStateObject> & {
	stateless?: boolean;
	/** taskIsolation:worktree 且目录就绪时，文件读取与异步 AST 以此根为准 */
	workspaceRootOverride?: URI;
};

export interface IContextStateService {
	readonly _serviceBrand: undefined;
	buildContextState(intent: Intent, node: ExecutionNode, options?: BuildContextStateOptions): Promise<ContextStateObject>;
	getContextState(intentId: string, nodeId: string): ContextStateObject | undefined;
	listContextStates(): ContextStateObject[];
}

export class ContextStateService extends Disposable implements IContextStateService {
	readonly _serviceBrand: undefined;

	private readonly states = new Map<string, ContextStateObject>();
	private readonly astSummaryCache = new Map<string, string>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILSPFeedbackService private readonly lspFeedbackService: ILSPFeedbackService,
		@ICodeIndexService private readonly codeIndexService: ICodeIndexService,
		@ITreeSitterService private readonly treeSitterService: ITreeSitterService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	async buildContextState(intent: Intent, node: ExecutionNode, options: BuildContextStateOptions = {}): Promise<ContextStateObject> {
		const now = Date.now();
		const stateless = !!options.stateless;

		const contextPaths = this.resolveContextFilePaths(intent);
		const diagnostics = this.collectDiagnostics(intent.intentCard.allowedFiles);
		const astSummaries = stateless ? [] : this.collectTreeSitterSummaries(contextPaths);
		const effectiveReadRoot = stateless
			? undefined
			: await this.resolveEffectiveReadRoot(options.workspaceRootOverride, contextPaths);
		const fileContents = stateless ? [] : await this.readFileContentsAsync(contextPaths, effectiveReadRoot);

		const state: ContextStateObject = {
			id: `cso_${intent.id}_${node.id}_${now}`,
			intentId: intent.id,
			nodeId: node.id,
			summary: options.summary || `${intent.title} / ${node.title}`,
			affectedFiles: options.affectedFiles || (intent.intentCard.allowedFiles.length > 0 ? [...intent.intentCard.allowedFiles] : [...contextPaths]),
			fileContents,
			astSummaries: astSummaries.length > 0 ? astSummaries : (options.astSummaries || []),
			diagnostics: diagnostics.length > 0 ? diagnostics : (options.diagnostics || []),
			pendingTests: options.pendingTests || [],
			recentFailures: stateless ? [] : this.collectRecentFailures(intent.intentCard.allowedFiles),
			recentDecisions: options.recentDecisions || [],
			checkpointRef: options.checkpointRef,
			iteration: options.iteration || 1,
			createdAt: now,
			updatedAt: now,
		};

		this.states.set(`${intent.id}:${node.id}`, state);
		this.logService.info(`[Sentinel CSO] Built context for ${intent.id}/${node.id}: ${diagnostics.length} diagnostics, ${astSummaries.length} AST summaries, ${fileContents.length} file contents`);

		if (!stateless) {
			this.collectTreeSitterSummariesAsync(contextPaths, effectiveReadRoot).then(asyncSummaries => {
				if (asyncSummaries.length > 0) {
					state.astSummaries = asyncSummaries;
					state.updatedAt = Date.now();
					this.logService.trace(`[Sentinel CSO] Async AST summaries updated: ${asyncSummaries.length} entries`);
				}
			});
		}

		return state;
	}

	private resolveContextFilePaths(intent: Intent): string[] {
		const user = intent.intentCard.allowedFiles.map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''));
		if (user.length === 0) {
			return [...DEFAULT_BOOTSTRAP_RELATIVE_PATHS];
		}
		/** 用户限定路径后仍追加 bootstrap，避免仅有物化出的深路径时读不到 package.json / 入口 */
		const seen = new Set(user);
		const tail = DEFAULT_BOOTSTRAP_RELATIVE_PATHS.filter(p => !seen.has(p));
		return [...user, ...tail];
	}

	/**
	 * 多根工作区：在未显式 override 时，按「探测路径可读数」选最可能的目标仓库根。
	 * 单根或已传 workspaceRootOverride 时直接返回对应 URI。
	 */
	private async resolveEffectiveReadRoot(workspaceRootOverride: URI | undefined, probeRelativePaths: string[]): Promise<URI | undefined> {
		if (workspaceRootOverride) {
			return workspaceRootOverride;
		}
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		if (folders.length === 1) {
			return folders[0]!.uri;
		}
		const probes = Array.from(
			new Set(
				probeRelativePaths
					.filter(p => p && !p.startsWith('/'))
					.slice(0, 8),
			),
		);
		const picked = await pickWorkspaceFolderByProbes(
			folders,
			this.fileService,
			probes.length > 0 ? probes : ['package.json'],
			8,
			{ info: m => this.logService.info(m), warn: m => this.logService.warn(m) },
			'[Sentinel CSO]',
		);
		return picked?.uri ?? folders[0]!.uri;
	}

	getContextState(intentId: string, nodeId: string): ContextStateObject | undefined {
		return this.states.get(`${intentId}:${nodeId}`);
	}

	listContextStates(): ContextStateObject[] {
		return Array.from(this.states.values());
	}

	private collectDiagnostics(allowedFiles: string[]): string[] {
		try {
			const snapshots = this.lspFeedbackService.getWorkspaceDiagnostics();
			const relevant = allowedFiles.length > 0
				? snapshots.filter(s => allowedFiles.some(f => s.path.includes(f)))
				: snapshots;

			const results: string[] = [];
			for (const snapshot of relevant) {
				for (const entry of snapshot.errors) {
					results.push(`[ERROR] ${snapshot.path}:${entry.startLine}:${entry.startColumn} - ${entry.message}`);
				}
				for (const entry of snapshot.warnings.slice(0, 5)) {
					results.push(`[WARN] ${snapshot.path}:${entry.startLine}:${entry.startColumn} - ${entry.message}`);
				}
			}
			return results.slice(0, 30);
		} catch (error) {
			this.logService.warn(`[Sentinel CSO] Failed to collect diagnostics: ${error}`);
			return [];
		}
	}

	private collectTreeSitterSummaries(allowedFiles: string[]): string[] {
		const summaries: string[] = [];
		try {
			const indexStats = this.treeSitterService.getIndexStats();
			summaries.push(`Symbol Index: ${indexStats.totalSymbols} symbols across ${indexStats.totalFiles} files`);

			for (const filePath of allowedFiles.slice(0, 5)) {
				const symbols = this.treeSitterService.findSymbol(filePath);
				if (symbols.length > 0) {
					summaries.push(`[${filePath}] ${symbols.length} symbols: ${symbols.slice(0, 8).map(s => `${s.kind}:${s.name}`).join(', ')}`);
				}

				const cached = this.astSummaryCache.get(filePath);
				if (cached) {
					summaries.push(cached);
				}
			}
		} catch (error) {
			this.logService.trace(`[Sentinel CSO] TreeSitter sync lookup: ${error}`);
			const status = this.codeIndexService.getStatus();
			summaries.push(`Index fallback: ${status.totalFiles} files, ${status.indexedChunks} chunks`);
		}
		return summaries;
	}

	private async collectTreeSitterSummariesAsync(allowedFiles: string[], workspaceRootOverride?: URI): Promise<string[]> {
		const summaries: string[] = [];
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0 && !workspaceRootOverride) {
			return summaries;
		}

		const root = workspaceRootOverride ?? folders[0]?.uri;
		if (!root) {
			return summaries;
		}

		for (const filePath of allowedFiles.slice(0, 5)) {
			try {
				const uri = URI.joinPath(root, filePath);
				const summary = await this.treeSitterService.getASTSummary(uri);
				if (summary && summary !== '(unable to parse)') {
					const truncated = summary.length > 500 ? summary.slice(0, 497) + '...' : summary;
					summaries.push(truncated);
					this.astSummaryCache.set(filePath, truncated);
				}
			} catch {
				// skip files that can't be parsed
			}
		}

		return summaries;
	}

	async readFileContentsAsync(allowedFiles: string[], workspaceRootOverride?: URI): Promise<Array<{ path: string; content: string; truncated: boolean }>> {
		const MAX_FILE_SIZE = 8000;
		const MAX_FILES = 14;
		const results: Array<{ path: string; content: string; truncated: boolean }> = [];
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (allowedFiles.length === 0) {
			return results;
		}
		if (folders.length === 0 && !workspaceRootOverride) {
			return results;
		}

		const root = workspaceRootOverride ?? folders[0]?.uri;
		if (!root) {
			return results;
		}
		for (const filePath of allowedFiles.slice(0, MAX_FILES)) {
			try {
				const uri = filePath.startsWith('/') ? URI.file(filePath) : URI.joinPath(root, filePath);
				const stat = await this.fileService.readFile(uri);
				const rawContent = stat.value.toString();
				const truncated = rawContent.length > MAX_FILE_SIZE;
				const content = truncated ? rawContent.slice(0, MAX_FILE_SIZE) + '\n... (truncated)' : rawContent;
				results.push({ path: filePath, content, truncated });
			} catch {
				// skip unreadable files
			}
		}

		if (results.length === 0 && allowedFiles.length > 0) {
			this.logService.warn(
				`[Sentinel CSO] readFileContentsAsync: 0/${Math.min(allowedFiles.length, MAX_FILES)} 个路径可读（检查工作区根是否为目标仓库、多根工作区顺序、或 taskIsolation worktree 是否尚未同步）。`,
			);
		}

		return results;
	}

	private collectRecentFailures(allowedFiles: string[]): string[] {
		try {
			const snapshots = this.lspFeedbackService.getWorkspaceDiagnostics();
			const relevant = allowedFiles.length > 0
				? snapshots.filter(s => allowedFiles.some(f => s.path.includes(f)))
				: snapshots;

			return relevant
				.filter(s => s.errors.length > 0)
				.flatMap(s => s.errors.map(e => `${s.path}: ${e.message}`))
				.slice(0, 10);
		} catch {
			return [];
		}
	}
}

registerSingleton(IContextStateService, ContextStateService, InstantiationType.Delayed);
