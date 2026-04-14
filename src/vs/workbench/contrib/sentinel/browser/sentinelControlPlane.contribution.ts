/*---------------------------------------------------------------------------------------------
 *  Sentinel Control Plane Contribution
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { IViewsRegistry, Extensions as ViewExtensions, IViewContainersRegistry, ViewContainerLocation } from '../../../common/views.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SentinelControlPlanePane, SENTINEL_CONTROL_PLANE_VIEW_ID } from './sentinelControlPlane.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISentinelProductService } from '../../../sentinel/common/sentinelProductService.js';
import { ISentinelExportService } from '../../../sentinel/browser/sentinelExportService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

const sentinelIcon = registerIcon('sentinel-control-plane-icon', Codicon.hubot, localize('sentinelControlPlaneIcon', 'View icon of the Sentinel control plane.'));

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const SENTINEL_CONTAINER = viewContainersRegistry.get('workbench.panel.sentinel')
	?? viewContainersRegistry.registerViewContainer({
		id: 'workbench.panel.sentinel',
		title: localize2('sentinelPanel', 'Sentinel'),
		icon: sentinelIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['workbench.panel.sentinel', { mergeViewWithContainerWhenSingleView: true }]),
		order: 90,
	}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: SENTINEL_CONTROL_PLANE_VIEW_ID,
	name: localize2('sentinelControlPlane', 'Sentinel Control Plane'),
	containerIcon: sentinelIcon,
	ctorDescriptor: new SyncDescriptor(SentinelControlPlanePane),
	canToggleVisibility: true,
	canMoveView: false,
	hideByDefault: false,
	collapsed: false,
	order: 10,
	weight: 100,
	focusCommand: { id: 'sentinel.openControlPlane' },
}], SENTINEL_CONTAINER);

CommandsRegistry.registerCommand('sentinel.createIntent', async accessor => {
	const quickInputService = accessor.get(IQuickInputService);
	const sentinelProductService = accessor.get(ISentinelProductService);
	const notificationService = accessor.get(INotificationService);
	const goal = await quickInputService.input({
		prompt: localize(
			'sentinel.createIntent.prompt',
			'用日常语言描述你想做什么（越具体越好：范围、是否要后端、怎样算做完）',
		),
		placeHolder: localize(
			'sentinel.createIntent.placeholder',
			'例：做一个订单列表页，表格展示订单号与状态，能筛选；先做前端 mock，不接真实支付',
		),
	});

	if (!goal) {
		return;
	}

	await sentinelProductService.ingestPrompt({ message: goal, source: 'command' });
	notificationService.info(localize('sentinel.createIntent.done', '已创建需求，可在 Sentinel 面板查看分析进度'));
});

CommandsRegistry.registerCommand('sentinel.advanceActiveIntent', async accessor => {
	const sentinelProductService = accessor.get(ISentinelProductService);
	await sentinelProductService.advanceActiveIntent();
});

CommandsRegistry.registerCommand('sentinel.runFullPipeline', async accessor => {
	const sentinelProductService = accessor.get(ISentinelProductService);
	const notificationService = accessor.get(INotificationService);
	notificationService.info(localize('sentinel.runPipeline.started', 'Sentinel: 开始自动执行全部节点'));
	await sentinelProductService.runFullPipeline();
	notificationService.info(localize('sentinel.runPipeline.done', 'Sentinel: 全流程执行完毕'));
});

CommandsRegistry.registerCommand('sentinel.pauseExecution', async accessor => {
	const sentinelProductService = accessor.get(ISentinelProductService);
	sentinelProductService.pauseExecution();
});

CommandsRegistry.registerCommand('sentinel.resumeExecution', async accessor => {
	const sentinelProductService = accessor.get(ISentinelProductService);
	await sentinelProductService.resumeExecution();
});

CommandsRegistry.registerCommand('sentinel.seedDemoState', async accessor => {
	const sentinelProductService = accessor.get(ISentinelProductService);
	await sentinelProductService.seedDemoState();
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.openControlPlane', title: localize('sentinel.open', 'Sentinel: Open Control Plane') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.createIntent', title: localize('sentinel.intent', 'Sentinel: 创建需求（Intent）') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.advanceActiveIntent', title: localize('sentinel.advance', 'Sentinel: Advance Active Intent') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.runFullPipeline', title: localize('sentinel.run', 'Sentinel: Run Full Pipeline') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.pauseExecution', title: localize('sentinel.pause', 'Sentinel: Pause Execution') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.resumeExecution', title: localize('sentinel.resume', 'Sentinel: Resume Execution') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.seedDemoState', title: localize('sentinel.demo', 'Sentinel: Seed Demo State') },
});

CommandsRegistry.registerCommand('sentinel.rollbackNode', async accessor => {
	const quickInputService = accessor.get(IQuickInputService);
	const sentinelProductService = accessor.get(ISentinelProductService);
	const nodeId = await quickInputService.input({
		prompt: localize('sentinel.rollback.prompt', '输入要回滚的节点 ID'),
		placeHolder: 'node_implement',
	});
	if (nodeId) {
		await sentinelProductService.rollbackNode(nodeId);
	}
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.rollbackNode', title: localize('sentinel.rollback', 'Sentinel: Rollback Node') },
});

CommandsRegistry.registerCommand('sentinel.exportHarnessBundle', async accessor => {
	const exportService = accessor.get(ISentinelExportService);
	const notificationService = accessor.get(INotificationService);
	const uri = await exportService.exportLatestBundle();
	if (uri) {
		notificationService.info(localize('sentinel.export.done', '已导出复盘包: {0}', uri.toString()));
	} else {
		notificationService.warn(localize('sentinel.export.skip', '未打开工作区，跳过导出'));
	}
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'sentinel.exportHarnessBundle', title: localize('sentinel.export', 'Sentinel: Export Harness Bundle') },
});

// --- Startup: auto-open Sentinel panel ---
class SentinelAutoOpenContribution {
	static readonly ID = 'sentinel.autoOpen';
	constructor(@IViewsService private readonly viewsService: IViewsService) {
		this.viewsService.openView(SENTINEL_CONTROL_PLANE_VIEW_ID, false);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SentinelAutoOpenContribution, LifecyclePhase.Restored);
