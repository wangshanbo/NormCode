/*---------------------------------------------------------------------------------------------
 *  Sentinel Product Service
 *  产品层 API — 支持自动运行、暂停/恢复、节点重试
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { ISentinelKernelService } from '../common/sentinelKernelService.js';
import { ISentinelProductService } from '../common/sentinelProductService.js';
import { IntentCard } from '../common/intentTypes.js';
import { PromptIngestionRequest, SentinelProductSnapshot } from '../common/sentinelTypes.js';
import { IIntentGraphService } from './intentGraphService.js';

export class SentinelProductService extends Disposable implements ISentinelProductService {
	readonly _serviceBrand: undefined;

	private selectedIntentId: string | undefined;
	private readonly _onDidUpdateSnapshot = this._register(new Emitter<SentinelProductSnapshot>());
	readonly onDidUpdateSnapshot: Event<SentinelProductSnapshot> = this._onDidUpdateSnapshot.event;

	constructor(
		@ISentinelKernelService private readonly sentinelKernelService: ISentinelKernelService,
		@IIntentGraphService private readonly intentGraphService: IIntentGraphService,
	) {
		super();

		this._register(this.sentinelKernelService.onDidUpdateSnapshot(snapshot => {
			this._onDidUpdateSnapshot.fire(this.withSelection(snapshot));
		}));
	}

	getSnapshot(): SentinelProductSnapshot {
		return this.withSelection(this.sentinelKernelService.getSnapshot());
	}

	async ingestPrompt(request: PromptIngestionRequest): Promise<SentinelProductSnapshot> {
		const intent = await this.sentinelKernelService.createIntentFromGoal(request.message, request.source);
		this.selectedIntentId = intent.id;

		await this.sentinelKernelService.analyzeRequirement(intent.id);
		// autoRun 时 confirm→plan→runAll 已在 analyzeRequirement 内核内完成，避免双跑

		return this.getSnapshot();
	}

	async confirmAndExecute(userAnswers?: string[]): Promise<SentinelProductSnapshot> {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			await this.sentinelKernelService.confirmAndExecute(activeId, userAnswers);
		}
		return this.getSnapshot();
	}

	async advanceActiveIntent(): Promise<SentinelProductSnapshot> {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			await this.sentinelKernelService.executeNextNode(activeId);
		}
		return this.getSnapshot();
	}

	async runFullPipeline(): Promise<SentinelProductSnapshot> {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			await this.sentinelKernelService.runAllNodes(activeId);
		}
		return this.getSnapshot();
	}

	pauseExecution(): void {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			this.sentinelKernelService.pauseExecution(activeId);
			this._onDidUpdateSnapshot.fire(this.getSnapshot());
		}
	}

	async resumeExecution(): Promise<SentinelProductSnapshot> {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			await this.sentinelKernelService.resumeExecution(activeId);
		}
		return this.getSnapshot();
	}

	async retryNode(nodeId: string): Promise<SentinelProductSnapshot> {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			await this.sentinelKernelService.retryNode(activeId, nodeId);
		}
		return this.getSnapshot();
	}

	async rollbackNode(nodeId: string): Promise<SentinelProductSnapshot> {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			await this.sentinelKernelService.rollbackNode(activeId, nodeId);
		}
		return this.getSnapshot();
	}

	addNode(title: string, description: string, type: string, afterNodeId?: string): SentinelProductSnapshot {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			this.sentinelKernelService.addExecutionNode(activeId, title, description, type, afterNodeId);
		}
		return this.getSnapshot();
	}

	removeNode(nodeId: string): SentinelProductSnapshot {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			this.sentinelKernelService.removeExecutionNode(activeId, nodeId);
		}
		return this.getSnapshot();
	}

	moveNode(nodeId: string, direction: 'up' | 'down'): SentinelProductSnapshot {
		const activeId = this.getActiveIntentId();
		if (activeId) {
			this.sentinelKernelService.moveExecutionNode(activeId, nodeId, direction);
		}
		return this.getSnapshot();
	}

	isExecutionPaused(): boolean {
		const activeId = this.getActiveIntentId();
		return activeId ? this.sentinelKernelService.isExecutionPaused(activeId) : false;
	}

	selectIntent(intentId: string): void {
		this.selectedIntentId = intentId;
		this._onDidUpdateSnapshot.fire(this.getSnapshot());
	}

	deleteIntent(intentId: string): SentinelProductSnapshot {
		this.sentinelKernelService.deleteIntent(intentId);
		if (this.selectedIntentId === intentId) {
			this.selectedIntentId = undefined;
		}
		return this.getSnapshot();
	}

	async reanalyze(intentId: string): Promise<SentinelProductSnapshot> {
		await this.sentinelKernelService.analyzeRequirement(intentId);
		return this.getSnapshot();
	}

	updateIntentCard(intentId: string, card: Partial<IntentCard>): SentinelProductSnapshot {
		const intent = this.intentGraphService.getIntent(intentId);
		if (intent) {
			this.intentGraphService.updateIntent(intentId, {
				intentCard: { ...intent.intentCard, ...card },
			});
			this._onDidUpdateSnapshot.fire(this.getSnapshot());
		}
		return this.getSnapshot();
	}

	async seedDemoState(): Promise<SentinelProductSnapshot> {
		await this.sentinelKernelService.seedDemoState();
		this.selectedIntentId = this.getSnapshot().activeIntentId;
		return this.getSnapshot();
	}

	applyRestoredSession(snapshot: SentinelProductSnapshot): void {
		this.selectedIntentId = snapshot.activeIntentId;
		this._onDidUpdateSnapshot.fire(this.getSnapshot());
	}

	private getActiveIntentId(): string | undefined {
		return this.selectedIntentId || this.getSnapshot().activeIntentId;
	}

	private withSelection(snapshot: SentinelProductSnapshot): SentinelProductSnapshot {
		return {
			...snapshot,
			activeIntentId: this.selectedIntentId || snapshot.activeIntentId,
		};
	}
}

registerSingleton(ISentinelProductService, SentinelProductService, InstantiationType.Delayed);
