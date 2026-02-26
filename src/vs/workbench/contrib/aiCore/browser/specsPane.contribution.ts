/*---------------------------------------------------------------------------------------------
 *  AI Core Specs Pane Contribution
 *  注册 Specs 侧边栏面板
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { IViewsRegistry, Extensions as ViewExtensions, IViewContainersRegistry } from '../../../common/views.js';
import { SpecsPane, SPECS_VIEW_ID } from './specsPane.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ISpecModeService } from '../../../services/aiCore/browser/specModeService.js';
import { IChatModeService } from '../../../services/aiCore/browser/chatModeService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { CodeLens, CodeLensList, CodeLensProvider } from '../../../../editor/common/languages.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewContainerLocation } from '../../../common/views.js';

// --- Icons
const specsViewIcon = registerIcon('specs-view-icon', Codicon.notebook, localize('specsViewIcon', 'View icon of the specs panel.'));

// --- Reuse built-in Chat container (对齐 Kiro：单入口，不拆分多个顶部容器)
// 如果启动时 Chat 容器尚未注册，回退到 AI Core 自有容器，避免启动崩溃
const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const CHAT_CONTAINER = viewContainersRegistry.get('workbench.panel.chat')
	?? viewContainersRegistry.get('workbench.panel.aicore.fallback')
	?? viewContainersRegistry.registerViewContainer({
		id: 'workbench.panel.aicore.fallback',
		title: localize2('aiCoreFallbackPanel', 'AI Core'),
		icon: specsViewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['workbench.panel.aicore.fallback', { mergeViewWithContainerWhenSingleView: true }]),
		order: 100
	}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

// --- Register View
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: SPECS_VIEW_ID,
	name: localize2('specsPane', 'Specs'),
	containerIcon: specsViewIcon,
	ctorDescriptor: new SyncDescriptor(SpecsPane),
	canToggleVisibility: true,
	canMoveView: false,
	hideByDefault: false,
	collapsed: false,
	order: 30,
	weight: 100,
	focusCommand: { id: 'specs.focus' },
	when: ContextKeyExpr.equals('config.aiCore.enableLegacySideViews', true)
}], CHAT_CONTAINER);

// --- Commands

// 打开 Specs 面板
CommandsRegistry.registerCommand('aicore.openSpecsPane', async (accessor) => {
	const viewsService = accessor.get(IViewsService);
	await viewsService.openView(SPECS_VIEW_ID, true);
});

// 新建 Spec
CommandsRegistry.registerCommand('aicore.newSpec', async (accessor) => {
	const chatModeService = accessor.get(IChatModeService);

	// 切换到 Spec 模式
	chatModeService.setMode('spec');

	// 打开聊天面板
	// commandService.executeCommand('workbench.action.chat.open');
});

// Vibe → Spec 转换命令
CommandsRegistry.registerCommand('aicore.vibeToSpec', async (accessor) => {
	const chatModeService = accessor.get(IChatModeService);

	// 如果当前在 Vibe 模式，切换到 Spec 模式
	if (chatModeService.getCurrentMode() === 'vibe') {
		chatModeService.setMode('spec');

		// 如果有聊天历史，可以基于它创建 Spec 会话
		// 这里简化处理，直接切换模式
	}
});

// 检查已完成任务
CommandsRegistry.registerCommand('aicore.checkCompletedTasks', async (accessor) => {
	const specService = accessor.get(ISpecModeService);
	await specService.scanCompletedTasks?.();
});

// 执行所有任务
CommandsRegistry.registerCommand('aicore.executeAllTasks', async (accessor) => {
	const specService = accessor.get(ISpecModeService);
	const session = specService.getCurrentSession();

	if (!session) {
		return;
	}

	// 逐个执行待处理任务
	let nextTask = specService.getNextTask();
	while (nextTask) {
		await specService.executeTaskWithLLM(nextTask);
		nextTask = specService.getNextTask();
	}
});

// 执行指定任务（供 tasks.md 内 CodeLens 调用）
CommandsRegistry.registerCommand('aicore.executeTask', async (accessor, args?: { taskId?: string }) => {
	const specService = accessor.get(ISpecModeService);
	const notificationService = accessor.get(INotificationService);
	const taskId = args?.taskId;
	const session = specService.getCurrentSession();

	if (!session || !taskId) {
		return;
	}

	const task = session.tasks.find(t => t.id === taskId);
	if (!task) {
		notificationService.warn(localize('spec.taskNotFound', 'Task not found'));
		return;
	}

	specService.startTask(task.id);
	const runResult = await specService.executeTaskWithLLM(task);
	if (!runResult.success) {
		specService.failTask(task.id, runResult.result || 'Task execution failed');
		notificationService.error(localize('spec.taskExecFailed', 'Task execution failed: {0}', task.title));
		return;
	}
	notificationService.info(localize('spec.taskExecDone', 'Task completed: {0}', task.title));
});

function extractTaskFilePaths(result?: string): string[] {
	if (!result) {
		return [];
	}

	const normalized = result.replace(/\r/g, '');
	const candidates = new Set<string>();
	const backtickRegex = /`([^`\n]+\.[a-zA-Z0-9]+)`/g;
	const pathRegex = /(?:^|\s)([./~]?[a-zA-Z0-9_\-\u4e00-\u9fa5/\\.]+\.[a-zA-Z0-9]+)(?=\s|$)/gm;

	let match: RegExpExecArray | null = null;
	while ((match = backtickRegex.exec(normalized))) {
		const p = match[1].trim();
		if (p.includes('/')) {
			candidates.add(p);
		}
	}
	while ((match = pathRegex.exec(normalized))) {
		const p = (match[1] || '').trim();
		if (p.includes('/') || p.startsWith('.')) {
			candidates.add(p);
		}
	}

	return [...candidates];
}

function toResourceUri(rawPath: string, workspaceRoot: URI): URI {
	if (/^[a-zA-Z]+:\/\//.test(rawPath)) {
		return URI.parse(rawPath);
	}
	const normalized = rawPath.replace(/^`|`$/g, '').replace(/^\.\//, '');
	return URI.joinPath(workspaceRoot, normalized);
}

async function openTaskExecutionDetails(accessor: ServicesAccessor, taskId: string): Promise<void> {
	const specService = accessor.get(ISpecModeService);
	const editorService = accessor.get(IEditorService);
	const fileService = accessor.get(IFileService);
	const session = specService.getCurrentSession();
	const specsFolder = specService.getSpecsFolder();
	if (!session || !specsFolder) {
		return;
	}

	const task = session.tasks.find(t => t.id === taskId);
	if (!task) {
		return;
	}

	const runsFolder = URI.joinPath(specsFolder, session.id, '.runs');
	await fileService.createFolder(runsFolder);
	const fileUri = URI.joinPath(runsFolder, `${task.id}.md`);
	const content = [
		`# Task Execution: ${task.title}`,
		'',
		`- Task ID: ${task.id}`,
		`- Status: ${task.status}`,
		`- Type: ${task.type}`,
		`- Updated: ${new Date().toISOString()}`,
		'',
		'---',
		'',
		task.result || 'No execution details yet.'
	].join('\n');

	await fileService.writeFile(fileUri, VSBuffer.fromString(content));
	await editorService.openEditor({ resource: fileUri });
}

// 重试指定任务（供 tasks.md 内 CodeLens 调用）
CommandsRegistry.registerCommand('aicore.retryTask', async (accessor, args?: { taskId?: string }) => {
	const specService = accessor.get(ISpecModeService);
	const notificationService = accessor.get(INotificationService);
	const taskId = args?.taskId;
	const session = specService.getCurrentSession();
	if (!taskId) {
		return;
	}

	if (!session) {
		return;
	}

	const task = session.tasks.find(t => t.id === taskId);
	if (!task) {
		notificationService.warn(localize('spec.taskNotFound', 'Task not found'));
		return;
	}

	specService.retryTask(taskId);
	specService.startTask(task.id);
	const runResult = await specService.executeTaskWithLLM(task);
	if (!runResult.success) {
		specService.failTask(task.id, runResult.result || 'Task retry failed');
		notificationService.error(localize('spec.taskRetryFailed', 'Task retry failed: {0}', task.title));
		return;
	}
	notificationService.info(localize('spec.taskRetryDone', 'Task completed after retry: {0}', task.title));
});

// 查看任务执行结果（供 tasks.md 内 CodeLens 调用）
CommandsRegistry.registerCommand('aicore.viewTaskExecution', async (accessor, args?: { taskId?: string }) => {
	const specService = accessor.get(ISpecModeService);
	const notificationService = accessor.get(INotificationService);
	const taskId = args?.taskId;
	const session = specService.getCurrentSession();
	if (!session || !taskId) {
		return;
	}
	const task = session.tasks.find(t => t.id === taskId);
	if (!task) {
		return;
	}

	if (!task.result) {
		notificationService.info(localize('spec.noTaskExecution', 'No execution details yet'));
		return;
	}
	await openTaskExecutionDetails(accessor, taskId);
});

// 查看任务改动（供 tasks.md 内 CodeLens 调用）
CommandsRegistry.registerCommand('aicore.viewTaskChanges', async (accessor, args?: { taskId?: string }) => {
	const specService = accessor.get(ISpecModeService);
	const notificationService = accessor.get(INotificationService);
	const workspaceService = accessor.get(IWorkspaceContextService);
	const editorService = accessor.get(IEditorService);
	const quickInputService = accessor.get(IQuickInputService);
	const fileService = accessor.get(IFileService);
	const taskId = args?.taskId;
	const session = specService.getCurrentSession();
	if (!session || !taskId) {
		return;
	}
	const task = session.tasks.find(t => t.id === taskId);
	if (!task) {
		return;
	}

	const folders = workspaceService.getWorkspace().folders;
	if (folders.length === 0) {
		notificationService.warn(localize('spec.noWorkspace', 'No workspace folder available'));
		return;
	}
	const workspaceRoot = folders[0].uri;
	const parsedPaths = extractTaskFilePaths(task.result);
	if (parsedPaths.length === 0) {
		notificationService.info(localize('spec.noTaskChanges', 'No change summary yet'));
		if (task.result) {
			await openTaskExecutionDetails(accessor, taskId);
		}
		return;
	}

	const existing: Array<{ label: string; uri: URI }> = [];
	for (const rawPath of parsedPaths) {
		const uri = toResourceUri(rawPath, workspaceRoot);
		if (await fileService.exists(uri)) {
			existing.push({ label: rawPath, uri });
		}
	}

	if (existing.length === 0) {
		notificationService.info(localize('spec.noResolvedChanges', 'Detected changed paths but files are not found locally'));
		await openTaskExecutionDetails(accessor, taskId);
		return;
	}
	if (existing.length === 1) {
		await editorService.openEditor({ resource: existing[0].uri });
		return;
	}

	const picked = await quickInputService.pick(
		existing.map(item => ({ label: item.label, description: item.uri.fsPath, item })),
		{ placeHolder: localize('spec.pickChangedFile', 'Select a changed file to open') }
	);
	if (!picked) {
		return;
	}
	await editorService.openEditor({ resource: picked.item.uri });
});

// 在编辑器中打开当前 Spec 会话的 requirements.md / design.md / tasks.md
CommandsRegistry.registerCommand('aicore.openSpecRequirements', async (accessor) => {
	const specService = accessor.get(ISpecModeService);
	const editorService = accessor.get(IEditorService);
	const session = specService.getCurrentSession();
	const specsFolder = specService.getSpecsFolder();
	if (!session || !specsFolder) {
		return;
	}
	const uri = URI.joinPath(specsFolder, session.id, 'requirements.md');
	await editorService.openEditor({ resource: uri });
});

CommandsRegistry.registerCommand('aicore.openSpecDesign', async (accessor) => {
	const specService = accessor.get(ISpecModeService);
	const editorService = accessor.get(IEditorService);
	const session = specService.getCurrentSession();
	const specsFolder = specService.getSpecsFolder();
	if (!session || !specsFolder) {
		return;
	}
	const uri = URI.joinPath(specsFolder, session.id, 'design.md');
	await editorService.openEditor({ resource: uri });
});

CommandsRegistry.registerCommand('aicore.openSpecTasks', async (accessor) => {
	const specService = accessor.get(ISpecModeService);
	const editorService = accessor.get(IEditorService);
	const session = specService.getCurrentSession();
	const specsFolder = specService.getSpecsFolder();
	if (!session || !specsFolder) {
		return;
	}
	const uri = URI.joinPath(specsFolder, session.id, 'tasks.md');
	await editorService.openEditor({ resource: uri });
});

// Kiro 风格 Update：基于现有 stories + design 重新生成任务列表
CommandsRegistry.registerCommand('aicore.updateSpecTasks', async (accessor) => {
	const specService = accessor.get(ISpecModeService);
	const session = specService.getCurrentSession();
	if (!session || !session.technicalDesign || session.userStories.length === 0) {
		return;
	}
	await specService.generateTasks(session.userStories, session.technicalDesign);
});

// --- Keybindings

// Ctrl+Shift+S 打开 Specs 面板
KeybindingsRegistry.registerKeybindingRule({
	id: 'aicore.openSpecsPane',
	weight: KeybindingWeight.WorkbenchContrib,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS,
	when: undefined,
});

// --- Menu Items

// 在 View 菜单中添加 Specs 面板
MenuRegistry.appendMenuItem(MenuId.ViewContainerTitle, {
	command: {
		id: 'aicore.newSpec',
		title: localize('newSpec', 'New Spec'),
		icon: Codicon.add
	},
	when: undefined,
	group: 'navigation',
	order: 1
});

// 在聊天面板添加 "生成规格说明" 选项
MenuRegistry.appendMenuItem(MenuId.ChatInput, {
	command: {
		id: 'aicore.vibeToSpec',
		title: localize('generateSpec', 'Generate Spec from Chat'),
		icon: Codicon.notebook
	},
	when: undefined,
	group: 'navigation',
	order: 100
});

// --- Editor Title Actions (Kiro 风格编辑器内工作流)
const isSpecEditorResource = ContextKeyExpr.regex(
	ResourceContextKey.Path.key,
	/[\\\/]\.specs[\\\/].*[\\\/](requirements|design|tasks)\.md$/i
);

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'aicore.openSpecRequirements', title: localize('spec.openRequirements', 'Requirements') },
	when: isSpecEditorResource,
	group: 'navigation',
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'aicore.openSpecDesign', title: localize('spec.openDesign', 'Design') },
	when: isSpecEditorResource,
	group: 'navigation',
	order: 2
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'aicore.openSpecTasks', title: localize('spec.openTasks', 'Task list') },
	when: isSpecEditorResource,
	group: 'navigation',
	order: 3
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'aicore.updateSpecTasks', title: localize('spec.updateTasks', 'Update'), icon: Codicon.refresh },
	when: isSpecEditorResource,
	group: '2_main',
	order: 1
});

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: { id: 'aicore.executeAllTasks', title: localize('spec.runAllTasks', 'Run all tasks'), icon: Codicon.play },
	when: isSpecEditorResource,
	group: '2_main',
	order: 2
});

class SpecsTasksCodeLensContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.aiCore.specTasksCodeLens';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ISpecModeService private readonly specService: ISpecModeService
	) {
		super();

		const patterns = [{ pattern: '**/.specs/**/tasks.md' }];
		const provider: CodeLensProvider = {
			provideCodeLenses: (model) => this.provideTaskCodeLenses(model)
		};
		this._register(languageFeaturesService.codeLensProvider.register(patterns, provider));
	}

	private provideTaskCodeLenses(model: ITextModel): CodeLensList {
		const session = this.specService.getCurrentSession();
		if (!session) {
			return { lenses: [], dispose: () => { } };
		}

		const lenses: CodeLens[] = [];
		const lines = model.getLinesContent();
		for (let i = 0; i < lines.length; i++) {
			let taskId: string | undefined;
			let anchorLine = i + 1;
			const idMatch = lines[i].match(/^<!--\s*task-id:([a-zA-Z0-9_-]+)\s*-->$/);
			if (idMatch) {
				taskId = idMatch[1];
				anchorLine = i + 2;
			} else {
				// 兼容老 tasks.md（无 task-id 注释时，按标题匹配）
				const titleMatch = lines[i].match(/^###\s+\[[ xX]\]\s+(.+?)(?:\s+[✅🔄🚫⏳])?\s*$/);
				if (!titleMatch) {
					continue;
				}
				const title = titleMatch[1].trim();
				const found = session.tasks.find(t => t.title.trim() === title);
				taskId = found?.id;
				anchorLine = i + 1;
			}

			if (!taskId) {
				continue;
			}

			const task = session.tasks.find(t => t.id === taskId);
			if (!task) {
				continue;
			}

			const lineNumber = anchorLine;
			const range = new Range(lineNumber, 1, lineNumber, 1);
			if (task.status === 'completed') {
				lenses.push({
					range,
					command: { id: 'aicore.viewTaskExecution', title: localize('spec.taskCompleted', '✓ Task completed'), arguments: [{ taskId }] }
				});
			} else if (task.status === 'blocked') {
				lenses.push({
					range,
					command: { id: 'aicore.retryTask', title: localize('spec.retryTask', '↻ Retry'), arguments: [{ taskId }] }
				});
			} else {
				lenses.push({
					range,
					command: { id: 'aicore.executeTask', title: localize('spec.startTask', '⚡ Start task'), arguments: [{ taskId }] }
				});
			}

			lenses.push(
				{
					range,
					command: { id: 'aicore.viewTaskChanges', title: localize('spec.viewTaskChanges', 'View changes'), arguments: [{ taskId }] }
				},
				{
					range,
					command: { id: 'aicore.viewTaskExecution', title: localize('spec.viewTaskExecution', 'View execution'), arguments: [{ taskId }] }
				}
			);
		}

		return { lenses, dispose: () => { } };
	}
}

registerWorkbenchContribution2(
	SpecsTasksCodeLensContribution.ID,
	SpecsTasksCodeLensContribution,
	WorkbenchPhase.AfterRestored
);
