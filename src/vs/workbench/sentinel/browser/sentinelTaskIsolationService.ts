/*---------------------------------------------------------------------------------------------
 *  HGT-005：任务级隔离 — 解析 worktree 路径是否已就绪（创建由 scripts/sentinel-worktree.mjs 完成）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { ResolvedHarnessConfig } from './harnessConfigService.js';

export const ISentinelTaskIsolationService = createDecorator<ISentinelTaskIsolationService>('sentinelTaskIsolationService');

export interface ISentinelTaskIsolationService {
	readonly _serviceBrand: undefined;
	/** 若 harness 为 worktree 且目录已存在，返回该 URI；否则 undefined */
	getIsolationRootIfReady(cfg: ResolvedHarnessConfig, intentId: string): Promise<URI | undefined>;
}

export class SentinelTaskIsolationService extends Disposable implements ISentinelTaskIsolationService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async getIsolationRootIfReady(cfg: ResolvedHarnessConfig, intentId: string): Promise<URI | undefined> {
		if (cfg.taskIsolation !== 'worktree') {
			return undefined;
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return undefined;
		}
		const safeId = intentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
		const root = URI.joinPath(folder, '.sentinel', 'worktrees', safeId);
		try {
			const stat = await this.fileService.stat(root);
			if (stat.isDirectory) {
				return root;
			}
		} catch {
			// not created yet
		}
		return undefined;
	}
}

registerSingleton(ISentinelTaskIsolationService, SentinelTaskIsolationService, InstantiationType.Delayed);
