/*---------------------------------------------------------------------------------------------
 *  Sentinel 极简工作台：左侧仅资源管理器、底部仅 Sentinel + 终端、中间编辑器。
 *  通过 Profile 钉选 + 隐藏活动栏 + Restored/Eventually 双次收敛（对抗工作区恢复覆盖）。
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts } from '../../../services/layout/browser/layoutService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';

/** 与 ActivitybarPart / PanelPart 中键名保持一致 */
const ACTIVITY_PINNED_KEY = 'workbench.activity.pinnedViewlets2';
const PANEL_PINNED_KEY = 'workbench.panel.pinnedPanels';

const EXPLORER_CONTAINER_ID = 'workbench.view.explorer';
const SENTINEL_PANEL_CONTAINER_ID = 'workbench.panel.sentinel';
/** 与 terminal.contribution 中 TERMINAL_VIEW_ID 一致 */
const TERMINAL_PANEL_CONTAINER_ID = 'terminal';

/**
 * 将活动栏与底部面板钉选收敛为「仅 Explorer / Sentinel + 终端」，隐藏辅助栏与状态栏等。
 */
class SentinelMinimalLayoutContribution extends Disposable {
	static readonly ID = 'workbench.contrib.sentinelMinimalLayout';

	private readonly reassertScheduler: RunOnceScheduler;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();
		this.reassertScheduler = this._register(new RunOnceScheduler(() => {
			void this.applyMinimalLayout();
		}, 800));
		void this.run();
	}

	private async run(): Promise<void> {
		await this.lifecycleService.when(LifecyclePhase.Restored);
		await this.applyMinimalLayout();

		await this.lifecycleService.when(LifecyclePhase.Eventually);
		await this.applyMinimalLayout();

		this.reassertScheduler.schedule();
	}

	private async applyMinimalLayout(): Promise<void> {
		const activityPinned = [{ id: EXPLORER_CONTAINER_ID, pinned: true, visible: true, order: 0 }];
		this.storageService.store(ACTIVITY_PINNED_KEY, JSON.stringify(activityPinned), StorageScope.PROFILE, StorageTarget.USER);

		const panelPinned = [
			{ id: SENTINEL_PANEL_CONTAINER_ID, pinned: true, visible: true, order: 0 },
			{ id: TERMINAL_PANEL_CONTAINER_ID, pinned: true, visible: true, order: 1 },
		];
		this.storageService.store(PANEL_PINNED_KEY, JSON.stringify(panelPinned), StorageScope.PROFILE, StorageTarget.USER);

		await this.configurationService.updateValue('workbench.statusBar.visible', false, ConfigurationTarget.USER);
		await this.configurationService.updateValue('workbench.layoutControl.enabled', false, ConfigurationTarget.USER);
		await this.configurationService.updateValue('workbench.tips.enabled', false, ConfigurationTarget.USER);
		await this.configurationService.updateValue('workbench.startupEditor', 'none', ConfigurationTarget.USER);
		await this.configurationService.updateValue('window.commandCenter', false, ConfigurationTarget.USER);
		await this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, ActivityBarPosition.HIDDEN, ConfigurationTarget.USER);

		this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.EDITOR_PART);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SentinelMinimalLayoutContribution, LifecyclePhase.Restored);
