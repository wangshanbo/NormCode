/*---------------------------------------------------------------------------------------------
 *  Sentinel Checkpoint Ledger Service
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ICheckpointService, CheckpointType } from '../../services/aiCore/browser/checkpointService.js';
import { CheckpointRecord, ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';

export const ICheckpointLedgerService = createDecorator<ICheckpointLedgerService>('ICheckpointLedgerService');

export interface ICheckpointLedgerService {
	readonly _serviceBrand: undefined;
	createCheckpointForNode(intent: Intent, node: ExecutionNode): Promise<CheckpointRecord>;
	getRecords(intentId: string): CheckpointRecord[];
	rollback(recordId: string): Promise<boolean>;
}

export class CheckpointLedgerService extends Disposable implements ICheckpointLedgerService {
	readonly _serviceBrand: undefined;

	private readonly records = new Map<string, CheckpointRecord[]>();

	constructor(
		@ICheckpointService private readonly checkpointService: ICheckpointService,
	) {
		super();
	}

	async createCheckpointForNode(intent: Intent, node: ExecutionNode): Promise<CheckpointRecord> {
		const adapterCheckpoint = await this.checkpointService.createCheckpoint(
			`Sentinel: ${intent.title} / ${node.title}`,
			node.id,
			CheckpointType.PreTask,
		);

		const record: CheckpointRecord = {
			id: `sentinel_checkpoint_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			label: adapterCheckpoint.label,
			adapterCheckpointId: adapterCheckpoint.id,
			createdAt: Date.now(),
		};

		const list = this.records.get(intent.id) || [];
		list.push(record);
		this.records.set(intent.id, list);
		return record;
	}

	getRecords(intentId: string): CheckpointRecord[] {
		return [...(this.records.get(intentId) || [])];
	}

	async rollback(recordId: string): Promise<boolean> {
		for (const records of this.records.values()) {
			const record = records.find(item => item.id === recordId);
			if (record?.adapterCheckpointId) {
				return this.checkpointService.rollbackTo(record.adapterCheckpointId);
			}
		}

		return false;
	}
}

registerSingleton(ICheckpointLedgerService, CheckpointLedgerService, InstantiationType.Delayed);
