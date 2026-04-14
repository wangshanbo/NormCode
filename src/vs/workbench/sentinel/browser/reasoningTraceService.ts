/*---------------------------------------------------------------------------------------------
 *  Sentinel Reasoning Trace Service
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { SentinelTaskStateFile } from '../common/harnessTypes.js';
import { ReasoningTrace, SentinelPhase } from '../common/sentinelTypes.js';

export const IReasoningTraceService = createDecorator<IReasoningTraceService>('IReasoningTraceService');

export interface IReasoningTraceService {
	readonly _serviceBrand: undefined;
	recordTrace(intentId: string, phase: SentinelPhase, summary: string, options?: {
		nodeId?: string;
		evidence?: string[];
		optionsConsidered?: string[];
		decision?: string;
		expectedImpact?: string;
		validatorHints?: string[];
	}): ReasoningTrace;
	getTraces(intentId: string): ReasoningTrace[];
	hydrateTraces(map: Record<string, ReasoningTrace[]>): void;
	/** 将任务状态外部化到 .sentinel/task_state.json */
	persistTaskState(state: SentinelTaskStateFile): Promise<void>;
}

export class ReasoningTraceService extends Disposable implements IReasoningTraceService {
	readonly _serviceBrand: undefined;

	private readonly traces = new Map<string, ReasoningTrace[]>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	recordTrace(intentId: string, phase: SentinelPhase, summary: string, options: {
		nodeId?: string;
		evidence?: string[];
		optionsConsidered?: string[];
		decision?: string;
		expectedImpact?: string;
		validatorHints?: string[];
	} = {}): ReasoningTrace {
		const trace: ReasoningTrace = {
			id: `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			intentId,
			nodeId: options.nodeId,
			phase,
			summary,
			evidence: options.evidence || [],
			optionsConsidered: options.optionsConsidered || [],
			decision: options.decision || summary,
			expectedImpact: options.expectedImpact,
			validatorHints: options.validatorHints,
			createdAt: Date.now(),
		};

		const list = this.traces.get(intentId) || [];
		list.push(trace);
		this.traces.set(intentId, list);
		return trace;
	}

	getTraces(intentId: string): ReasoningTrace[] {
		return [...(this.traces.get(intentId) || [])];
	}

	hydrateTraces(map: Record<string, ReasoningTrace[]>): void {
		this.traces.clear();
		for (const [intentId, list] of Object.entries(map)) {
			this.traces.set(intentId, list.map(t => ({ ...t })));
		}
	}

	async persistTaskState(state: SentinelTaskStateFile): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		try {
			const dir = URI.joinPath(root, '.sentinel');
			await this.fileService.createFolder(dir);
			const uri = URI.joinPath(dir, 'task_state.json');
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(state, undefined, '\t')));
		} catch (e) {
			this.logService.warn('[Sentinel] persistTaskState failed', e);
		}
	}
}

registerSingleton(IReasoningTraceService, ReasoningTraceService, InstantiationType.Delayed);
