/*---------------------------------------------------------------------------------------------
 *  Sentinel Kernel Service Contract
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ContextStateObject, ExecutionGraph } from './executionTypes.js';
import { Intent } from './intentTypes.js';
import { ProjectionArtifact } from './projectionTypes.js';
import { ReasoningTrace, RequirementAnalysis, SentinelPhase, SentinelPersistedWorkspaceState, SentinelProductSnapshot } from './sentinelTypes.js';
import { VerificationBundle } from './verificationTypes.js';
import { WorkerRun } from './workerTypes.js';

export const ISentinelKernelService = createDecorator<ISentinelKernelService>('ISentinelKernelService');

export interface ISentinelKernelService {
	readonly _serviceBrand: undefined;

	readonly onDidUpdatePhase: Event<SentinelPhase>;
	readonly onDidUpdateSnapshot: Event<SentinelProductSnapshot>;

	getSnapshot(): SentinelProductSnapshot;
	createIntentFromGoal(goal: string, source?: string): Promise<Intent>;
	planIntent(intentId: string): Promise<ExecutionGraph | undefined>;
	executeNextNode(intentId: string): Promise<WorkerRun | undefined>;
	runAllNodes(intentId: string): Promise<WorkerRun[]>;
	pauseExecution(intentId: string): void;
	resumeExecution(intentId: string): Promise<WorkerRun[]>;
	retryNode(intentId: string, nodeId: string): Promise<WorkerRun | undefined>;
	rollbackNode(intentId: string, nodeId: string): Promise<boolean>;
	isExecutionPaused(intentId: string): boolean;
	getIntent(intentId: string): Intent | undefined;
	getExecutionGraph(intentId: string): ExecutionGraph | undefined;
	getContextState(intentId: string, nodeId: string): ContextStateObject | undefined;
	getVerificationBundle(intentId: string, nodeId?: string): VerificationBundle | undefined;
	getReasoningTraces(intentId: string): ReasoningTrace[];
	getArtifacts(intentId: string): ProjectionArtifact[];
	analyzeRequirement(intentId: string): Promise<RequirementAnalysis | undefined>;
	confirmAndExecute(intentId: string, userAnswers?: string[]): Promise<WorkerRun[]>;
	deleteIntent(intentId: string): boolean;
	addExecutionNode(intentId: string, title: string, description: string, type: string, afterNodeId?: string): boolean;
	removeExecutionNode(intentId: string, nodeId: string): boolean;
	moveExecutionNode(intentId: string, nodeId: string, direction: 'up' | 'down'): boolean;
	seedDemoState(): Promise<void>;
	/** 从 `.sentinel` 恢复会话（工作区打开后由 contribution 调用） */
	restorePersistedState(state: SentinelPersistedWorkspaceState): Promise<void>;
	/** 关机前将当前内存态排队写入磁盘（与 persistState 相同，随后应 flushPendingWrites） */
	forcePersistState(): void;
}
