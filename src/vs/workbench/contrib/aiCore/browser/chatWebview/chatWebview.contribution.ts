/*---------------------------------------------------------------------------------------------
 *  Chat Webview Contribution
 *  注册 Kiro 风格的 AI 聊天 Webview 面板
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { IViewsRegistry, Extensions as ViewExtensions, IViewContainersRegistry } from '../../../../common/views.js';
import { ChatWebviewPane, CHAT_WEBVIEW_ID } from './chatWebviewPane.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { ViewContainerLocation } from '../../../../common/views.js';

// --- Icons
const chatWebviewIcon = registerIcon('chat-webview-icon', Codicon.comment, localize('chatWebviewIcon', 'View icon of the AI chat panel.'));

// --- Reuse built-in Chat container (对齐 Kiro：单入口，不拆分多个顶部容器)
// 如果启动时 Chat 容器尚未注册，回退到 AI Core 自有容器，避免启动崩溃
const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const CHAT_CONTAINER = viewContainersRegistry.get('workbench.panel.chat')
	?? viewContainersRegistry.get('workbench.panel.aicore.fallback')
	?? viewContainersRegistry.registerViewContainer({
		id: 'workbench.panel.aicore.fallback',
		title: localize2('aiCoreFallbackPanel', 'AI Core'),
		icon: chatWebviewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['workbench.panel.aicore.fallback', { mergeViewWithContainerWhenSingleView: true }]),
		order: 100
	}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

// --- Register View
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: CHAT_WEBVIEW_ID,
	name: localize2('aiChatPane', 'AI Chat'),
	containerIcon: chatWebviewIcon,
	ctorDescriptor: new SyncDescriptor(ChatWebviewPane),
	canToggleVisibility: true,
	canMoveView: false,
	hideByDefault: false,
	collapsed: false,
	order: 20,
	weight: 100,
	focusCommand: { id: 'chatWebview.focus' },
	when: ContextKeyExpr.equals('config.aiCore.enableLegacySideViews', true)
}], CHAT_CONTAINER);

// --- Commands

// 打开 Chat Webview 面板
CommandsRegistry.registerCommand('aicore.openChatWebview', async (accessor) => {
	const viewsService = accessor.get(IViewsService);
	await viewsService.openView(CHAT_WEBVIEW_ID, true);
});

// 注意: chatWebview.focus 命令由 ViewsService 自动注册（基于 focusCommand 配置）

// --- Keybindings

// Ctrl+Shift+L 打开 AI Chat 面板
KeybindingsRegistry.registerKeybindingRule({
	id: 'aicore.openChatWebview',
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL,
	when: undefined,
});
