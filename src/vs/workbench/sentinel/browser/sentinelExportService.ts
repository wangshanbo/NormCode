/*---------------------------------------------------------------------------------------------
 *  Sentinel 导出复盘包（M6）
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { IIntentGraphService } from './intentGraphService.js';
import { IExecutionGraphService } from './executionGraphService.js';
import { IReasoningTraceService } from './reasoningTraceService.js';
import { IVerificationGateService } from './verificationGateService.js';

export const ISentinelExportService = createDecorator<ISentinelExportService>('ISentinelExportService');

export interface ISentinelExportService {
	readonly _serviceBrand: undefined;
	exportLatestBundle(intentId?: string): Promise<URI | undefined>;
}

export class SentinelExportService extends Disposable implements ISentinelExportService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IIntentGraphService private readonly intentGraphService: IIntentGraphService,
		@IExecutionGraphService private readonly executionGraphService: IExecutionGraphService,
		@IReasoningTraceService private readonly reasoningTraceService: IReasoningTraceService,
		@IVerificationGateService private readonly verificationGateService: IVerificationGateService,
	) {
		super();
	}

	async exportLatestBundle(intentId?: string): Promise<URI | undefined> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return undefined;
		}
		const intents = this.intentGraphService.listIntents().filter(i => !intentId || i.id === intentId);
		const graphs = this.executionGraphService.listGraphs().filter(g => !intentId || g.intentId === intentId);
		const bundles = this.verificationGateService.listBundles().filter(b => !intentId || b.intentId === intentId);
		const traces: Record<string, unknown[]> = {};
		for (const i of intents) {
			traces[i.id] = this.reasoningTraceService.getTraces(i.id) as unknown[];
		}
		const payload = {
			version: 1,
			exportedAt: Date.now(),
			intents,
			executionGraphs: graphs,
			verificationBundles: bundles,
			reasoningTraces: traces,
		};
		const dir = URI.joinPath(root, '.sentinel', 'export');
		await this.fileService.createFolder(dir);
		const uri = URI.joinPath(dir, `bundle_${Date.now()}.json`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, undefined, '\t')));
		return uri;
	}
}

registerSingleton(ISentinelExportService, SentinelExportService, InstantiationType.Delayed);
