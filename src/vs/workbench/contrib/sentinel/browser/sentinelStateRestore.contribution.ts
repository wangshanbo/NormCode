/*---------------------------------------------------------------------------------------------
 *  Sentinel：从工作区 `.sentinel` 恢复 Intent / 执行图 / 验证包 / 成本等，避免关窗后进度丢失。
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISentinelPersistenceService } from '../../../sentinel/browser/persistenceService.js';
import { ISentinelKernelService } from '../../../sentinel/common/sentinelKernelService.js';
import { ISentinelProductService } from '../../../sentinel/common/sentinelProductService.js';
import { SentinelPersistedWorkspaceState } from '../../../sentinel/common/sentinelTypes.js';

class SentinelStateRestoreContribution extends Disposable {
	static readonly ID = 'workbench.contrib.sentinelStateRestore';

	private hadWorkspaceFolder: boolean;
	private sessionRestored = false;

	constructor(
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISentinelPersistenceService private readonly persistenceService: ISentinelPersistenceService,
		@ISentinelKernelService private readonly sentinelKernelService: ISentinelKernelService,
		@ISentinelProductService private readonly sentinelProductService: ISentinelProductService,
	) {
		super();
		this.hadWorkspaceFolder = this.workspaceContextService.getWorkspace().folders.length > 0;
		void this.runInitialRestore();
		this._register(Event.any(
			this.workspaceContextService.onDidChangeWorkspaceFolders,
			this.workspaceContextService.onDidChangeWorkbenchState,
		)(() => {
			const hasFolder = this.workspaceContextService.getWorkspace().folders.length > 0;
			if (!this.hadWorkspaceFolder && hasFolder) {
				this.sessionRestored = false;
				void this.tryRestoreFromDisk();
			}
			this.hadWorkspaceFolder = hasFolder;
		}));
		this._register(this.lifecycleService.onWillShutdown(e => {
			e.join(
				(async () => {
					this.sentinelKernelService.forcePersistState();
					await this.persistenceService.flushPendingWrites();
				})(),
				{ id: 'join.sentinelPersist', label: 'Saving Sentinel state (.sentinel)' },
			);
		}));
	}

	private async runInitialRestore(): Promise<void> {
		await this.lifecycleService.when(LifecyclePhase.Restored);
		await this.tryRestoreFromDisk();
		// 文件系统 / 多根目录偶发晚就绪：Eventually 再试一次（已成功则跳过）
		await this.lifecycleService.when(LifecyclePhase.Eventually);
		await new Promise<void>(r => setTimeout(r, 100));
		await this.tryRestoreFromDisk();
	}

	/** 从磁盘加载并灌入内核；无 `state.json` 时静默跳过 */
	private async tryRestoreFromDisk(): Promise<void> {
		if (this.sessionRestored) {
			return;
		}
		if (this.workspaceContextService.getWorkspace().folders.length === 0) {
			return;
		}
		let data: SentinelPersistedWorkspaceState | undefined;
		try {
			data = await this.persistenceService.loadState();
		} catch {
			return;
		}
		if (!data?.snapshot) {
			return;
		}
		await this.sentinelKernelService.restorePersistedState(data);
		this.sentinelProductService.applyRestoredSession(data.snapshot);
		this.sessionRestored = true;
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SentinelStateRestoreContribution, LifecyclePhase.Restored);
