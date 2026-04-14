/*---------------------------------------------------------------------------------------------
 *  Sentinel Product Service Contract
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IntentCard } from './intentTypes.js';
import { PromptIngestionRequest, SentinelProductSnapshot } from './sentinelTypes.js';

export const ISentinelProductService = createDecorator<ISentinelProductService>('ISentinelProductService');

export interface ISentinelProductService {
	readonly _serviceBrand: undefined;

	readonly onDidUpdateSnapshot: Event<SentinelProductSnapshot>;

	getSnapshot(): SentinelProductSnapshot;
	ingestPrompt(request: PromptIngestionRequest): Promise<SentinelProductSnapshot>;
	confirmAndExecute(userAnswers?: string[]): Promise<SentinelProductSnapshot>;
	advanceActiveIntent(): Promise<SentinelProductSnapshot>;
	runFullPipeline(): Promise<SentinelProductSnapshot>;
	pauseExecution(): void;
	resumeExecution(): Promise<SentinelProductSnapshot>;
	retryNode(nodeId: string): Promise<SentinelProductSnapshot>;
	rollbackNode(nodeId: string): Promise<SentinelProductSnapshot>;
	isExecutionPaused(): boolean;
	selectIntent(intentId: string): void;
	deleteIntent(intentId: string): SentinelProductSnapshot;
	reanalyze(intentId: string): Promise<SentinelProductSnapshot>;
	updateIntentCard(intentId: string, card: Partial<IntentCard>): SentinelProductSnapshot;
	addNode(title: string, description: string, type: string, afterNodeId?: string): SentinelProductSnapshot;
	removeNode(nodeId: string): SentinelProductSnapshot;
	moveNode(nodeId: string, direction: 'up' | 'down'): SentinelProductSnapshot;
	seedDemoState(): Promise<SentinelProductSnapshot>;
	/** 工作区恢复后与内核快照对齐当前选中意图 */
	applyRestoredSession(snapshot: SentinelProductSnapshot): void;
}
