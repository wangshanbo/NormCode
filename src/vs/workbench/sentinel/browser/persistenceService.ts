/*---------------------------------------------------------------------------------------------
 *  Sentinel Persistence Service
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ExecutionGraph } from '../common/executionTypes.js';
import { IntentGraph, intentSummariesToGraph } from '../common/intentTypes.js';
import { ReasoningTrace, SentinelPersistedWorkspaceState, SentinelProductSnapshot } from '../common/sentinelTypes.js';
import { CostLedger, WorkerRun } from '../common/workerTypes.js';

const SENTINEL_DIR = '.sentinel';
const STATE_FILE = 'state.json';
const INTENT_GRAPH_FILE = 'intent-graph.json';
const EXECUTION_GRAPHS_FILE = 'execution-graphs.json';
const WORKER_RUNS_FILE = 'worker-runs.json';
const COST_LEDGER_FILE = 'cost-ledger.json';
const TRACES_DIR = 'traces';

const DEBOUNCE_MS = 1500;

export const ISentinelPersistenceService = createDecorator<ISentinelPersistenceService>('ISentinelPersistenceService');

export interface ISentinelPersistenceService {
	readonly _serviceBrand: undefined;

	saveState(snapshot: SentinelProductSnapshot): Promise<void>;
	loadState(): Promise<SentinelPersistedWorkspaceState | undefined>;
	saveIntentGraph(graph: IntentGraph): Promise<void>;
	loadIntentGraph(): Promise<IntentGraph | undefined>;
	saveExecutionGraph(graph: ExecutionGraph): Promise<void>;
	saveExecutionGraphs(graphs: ExecutionGraph[]): Promise<void>;
	loadExecutionGraphs(): Promise<ExecutionGraph[]>;
	saveWorkerRuns(runs: WorkerRun[]): Promise<void>;
	saveCostLedger(ledger: CostLedger): Promise<void>;
	saveReasoningTraces(intentId: string, traces: ReasoningTrace[]): Promise<void>;
	loadReasoningTraces(intentId: string): Promise<ReasoningTrace[]>;
	/** 立即写出所有尚未过 debounce 的待写入内容（关机前调用） */
	flushPendingWrites(): Promise<void>;
	clearAll(): Promise<void>;
}

export class SentinelPersistenceService extends Disposable implements ISentinelPersistenceService {
	readonly _serviceBrand: undefined;

	private readonly _pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _pendingData = new Map<string, unknown>();

	/** 实际读到 `state.json` 的 `<workspace>/.sentinel`；多根目录时可能不是 folders[0] */
	private _activeSentinelRoot: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(Event.any(
			this.workspaceContextService.onDidChangeWorkspaceFolders,
			this.workspaceContextService.onDidChangeWorkbenchState,
		)(() => {
			this._activeSentinelRoot = undefined;
		}));
	}

	async saveState(snapshot: SentinelProductSnapshot): Promise<void> {
		await this._debouncedWrite(STATE_FILE, snapshot);
	}

	async loadState(): Promise<SentinelPersistedWorkspaceState | undefined> {
		this._activeSentinelRoot = undefined;
		const folders = this.workspaceContextService.getWorkspace().folders;
		let stateJson: SentinelProductSnapshot | undefined;
		for (const folder of folders) {
			const stateUri = URI.joinPath(folder.uri, SENTINEL_DIR, STATE_FILE);
			try {
				const content = await this.fileService.readFile(stateUri);
				stateJson = JSON.parse(content.value.toString()) as SentinelProductSnapshot;
				this._activeSentinelRoot = URI.joinPath(folder.uri, SENTINEL_DIR);
				this.logService.info(`[Sentinel] Using state from ${stateUri.toString()}`);
				break;
			} catch {
				continue;
			}
		}
		if (!stateJson) {
			return undefined;
		}

		let intentGraph = await this.loadIntentGraph();
		// 磁盘上 intent-graph.json 可能是空数组；必须以 state.json 中的摘要为准
		if ((!intentGraph || !intentGraph.intents?.length) && stateJson.intents?.length) {
			intentGraph = intentSummariesToGraph(stateJson.intents);
		}

		let executionGraphs = await this.loadExecutionGraphs();
		if ((!executionGraphs || executionGraphs.length === 0) && stateJson.executionGraphs?.length) {
			executionGraphs = stateJson.executionGraphs;
		}

		let workerRuns = await this._readJson<WorkerRun[]>(WORKER_RUNS_FILE) ?? [];
		if (workerRuns.length === 0 && stateJson.workerRuns?.length) {
			workerRuns = stateJson.workerRuns;
		}

		let costLedger = await this._readJson<CostLedger>(COST_LEDGER_FILE) ?? { totalCost: 0, totalTokens: 0, records: [] };
		if ((!costLedger.records?.length && costLedger.totalCost === 0 && costLedger.totalTokens === 0) && stateJson.costLedger) {
			costLedger = stateJson.costLedger;
		}

		const traceMap: Record<string, ReasoningTrace[]> = {};
		const intentIds = new Set<string>();
		if (intentGraph) {
			for (const intent of intentGraph.intents) {
				intentIds.add(intent.id);
			}
		}
		for (const id of intentIds) {
			const traces = await this.loadReasoningTraces(id);
			if (traces.length > 0) {
				traceMap[id] = traces;
			}
		}

		return {
			intentGraph,
			executionGraphs,
			reasoningTraces: traceMap,
			workerRuns,
			costLedger,
			snapshot: stateJson,
			persistedAt: Date.now(),
		};
	}

	async saveIntentGraph(graph: IntentGraph): Promise<void> {
		await this._debouncedWrite(INTENT_GRAPH_FILE, graph);
	}

	async loadIntentGraph(): Promise<IntentGraph | undefined> {
		return this._readJson<IntentGraph>(INTENT_GRAPH_FILE);
	}

	async saveExecutionGraph(graph: ExecutionGraph): Promise<void> {
		const existing = await this.loadExecutionGraphs();
		const index = existing.findIndex(g => g.id === graph.id);
		if (index >= 0) {
			existing[index] = graph;
		} else {
			existing.push(graph);
		}
		await this._debouncedWrite(EXECUTION_GRAPHS_FILE, existing);
	}

	async saveExecutionGraphs(graphs: ExecutionGraph[]): Promise<void> {
		await this._debouncedWrite(EXECUTION_GRAPHS_FILE, graphs);
	}

	async saveWorkerRuns(runs: WorkerRun[]): Promise<void> {
		await this._debouncedWrite(WORKER_RUNS_FILE, runs);
	}

	async saveCostLedger(ledger: CostLedger): Promise<void> {
		await this._debouncedWrite(COST_LEDGER_FILE, ledger);
	}

	async loadExecutionGraphs(): Promise<ExecutionGraph[]> {
		return await this._readJson<ExecutionGraph[]>(EXECUTION_GRAPHS_FILE) ?? [];
	}

	async saveReasoningTraces(intentId: string, traces: ReasoningTrace[]): Promise<void> {
		const tracePath = `${TRACES_DIR}/${intentId}.json`;
		await this._debouncedWrite(tracePath, traces);
	}

	async loadReasoningTraces(intentId: string): Promise<ReasoningTrace[]> {
		const tracePath = `${TRACES_DIR}/${intentId}.json`;
		return await this._readJson<ReasoningTrace[]>(tracePath) ?? [];
	}

	async flushPendingWrites(): Promise<void> {
		for (const timer of this._pendingSaves.values()) {
			clearTimeout(timer);
		}
		this._pendingSaves.clear();
		for (const [relativePath, data] of this._pendingData.entries()) {
			await this._writeJson(relativePath, data);
		}
		this._pendingData.clear();
		this.logService.info('[Sentinel] Flushed pending persistence writes');
	}

	async clearAll(): Promise<void> {
		const root = this._resolveSentinelRoot();
		if (!root) {
			return;
		}

		try {
			await this.fileService.del(root, { recursive: true });
			this.logService.info('[Sentinel] Persistence cleared');
		} catch {
			this.logService.trace('[Sentinel] Nothing to clear');
		}
	}

	// --- private helpers ---

	private _resolveSentinelRoot(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		if (this._activeSentinelRoot) {
			return this._activeSentinelRoot;
		}
		return URI.joinPath(folders[0].uri, SENTINEL_DIR);
	}

	private _resolveFile(relativePath: string): URI | undefined {
		const root = this._resolveSentinelRoot();
		if (!root) {
			return undefined;
		}
		return URI.joinPath(root, relativePath);
	}

	private async _writeJson(relativePath: string, data: unknown): Promise<void> {
		const uri = this._resolveFile(relativePath);
		if (!uri) {
			this.logService.warn('[Sentinel] No workspace folder, skipping persistence');
			return;
		}

		try {
			const json = JSON.stringify(data, undefined, '\t');
			await this.fileService.writeFile(uri, VSBuffer.fromString(json));
			this.logService.trace(`[Sentinel] Persisted ${relativePath}`);
		} catch (err) {
			this.logService.error(`[Sentinel] Failed to persist ${relativePath}`, err);
		}
	}

	private async _readJson<T>(relativePath: string): Promise<T | undefined> {
		const uri = this._resolveFile(relativePath);
		if (!uri) {
			return undefined;
		}

		try {
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as T;
		} catch {
			return undefined;
		}
	}

	private async _debouncedWrite(relativePath: string, data: unknown): Promise<void> {
		this._pendingData.set(relativePath, data);
		const existing = this._pendingSaves.get(relativePath);
		if (existing) {
			clearTimeout(existing);
		}

		return new Promise<void>((resolve) => {
			const timer = setTimeout(async () => {
				this._pendingSaves.delete(relativePath);
				const payload = this._pendingData.get(relativePath);
				this._pendingData.delete(relativePath);
				if (payload !== undefined) {
					await this._writeJson(relativePath, payload);
				}
				resolve();
			}, DEBOUNCE_MS);
			this._pendingSaves.set(relativePath, timer);
		});
	}

	override dispose(): void {
		for (const timer of this._pendingSaves.values()) {
			clearTimeout(timer);
		}
		this._pendingSaves.clear();
		this._pendingData.clear();
		super.dispose();
	}
}

registerSingleton(ISentinelPersistenceService, SentinelPersistenceService, InstantiationType.Delayed);
