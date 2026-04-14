/*---------------------------------------------------------------------------------------------
 *  Task Graph Pane Contribution
 *  注册 DAG 可视化面板和相关命令
 *---------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { IViewsRegistry, Extensions as ViewExtensions, IViewContainersRegistry, ViewContainerLocation } from '../../../common/views.js';
import { TaskGraphPane, TASK_GRAPH_VIEW_ID } from './taskGraphPane.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ITaskGraphService } from '../../../services/aiCore/browser/taskGraphService.js';
import { ICheckpointService, CheckpointType } from '../../../services/aiCore/browser/checkpointService.js';
import { ITDDService } from '../../../services/aiCore/browser/tddService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeGraphService } from '../../../services/aiCore/browser/codeGraphService.js';
import { IModelRouterService } from '../../../services/aiCore/browser/modelRouterService.js';
import { IRedTeamService } from '../../../services/aiCore/browser/redTeamService.js';
import { ILSPFeedbackService } from '../../../services/aiCore/browser/lspFeedbackService.js';
import { IIntentRefinementService } from '../../../services/aiCore/browser/intentRefinementService.js';
import { CostDashboardPane, COST_DASHBOARD_VIEW_ID } from './costDashboardPane.js';
import { ITreeSitterService } from '../../../services/aiCore/browser/treeSitterService.js';
import { ISymbolicVerificationService } from '../../../services/aiCore/browser/symbolicVerificationService.js';
import { IDomainOntologyService } from '../../../services/aiCore/browser/domainOntologyService.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { URI } from '../../../../base/common/uri.js';

// --- Icons
const taskGraphIcon = registerIcon('task-graph-view-icon', Codicon.graphLine, localize('taskGraphViewIcon', 'View icon of the task graph panel.'));

// --- Container: reuse Chat container or create fallback
const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const CHAT_CONTAINER = viewContainersRegistry.get('workbench.panel.chat')
	?? viewContainersRegistry.get('workbench.panel.aicore.fallback')
	?? viewContainersRegistry.registerViewContainer({
		id: 'workbench.panel.aicore.fallback',
		title: localize2('aiCoreFallbackPanel', 'AI Core'),
		icon: taskGraphIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['workbench.panel.aicore.fallback', { mergeViewWithContainerWhenSingleView: true }]),
		order: 100,
	}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

// --- Register View
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: TASK_GRAPH_VIEW_ID,
	name: localize2('taskGraphPane', 'Task Graph'),
	containerIcon: taskGraphIcon,
	ctorDescriptor: new SyncDescriptor(TaskGraphPane),
	canToggleVisibility: true,
	canMoveView: false,
	hideByDefault: false,
	collapsed: true,
	order: 40,
	weight: 100,
	focusCommand: { id: 'taskGraph.focus' },
	when: ContextKeyExpr.equals('config.aiCore.enableLegacySideViews', true),
}], CHAT_CONTAINER);

// --- Register Cost Dashboard View
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: COST_DASHBOARD_VIEW_ID,
	name: localize2('costDashboardPane', 'Cost Dashboard'),
	containerIcon: taskGraphIcon,
	ctorDescriptor: new SyncDescriptor(CostDashboardPane),
	canToggleVisibility: true,
	canMoveView: false,
	hideByDefault: false,
	collapsed: true,
	order: 50,
	weight: 80,
	focusCommand: { id: 'costDashboard.focus' },
	when: ContextKeyExpr.equals('config.aiCore.enableLegacySideViews', true),
}], CHAT_CONTAINER);

// ============================================================================
// Commands
// ============================================================================

// 打开 Task Graph 面板
CommandsRegistry.registerCommand('aicore.openTaskGraph', async (accessor) => {
	const viewsService = accessor.get(IViewsService);
	await viewsService.openView(TASK_GRAPH_VIEW_ID, true);
});

// 从当前 Spec 构建 DAG
CommandsRegistry.registerCommand('aicore.buildTaskGraph', async (accessor) => {
	const taskGraphService = accessor.get(ITaskGraphService);
	const notificationService = accessor.get(INotificationService);

	const graph = taskGraphService.buildFromSpec();
	if (graph) {
		notificationService.info(localize('taskGraph.built', 'Task graph built: {0} nodes', graph.nodes.size));
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(TASK_GRAPH_VIEW_ID, true);
	} else {
		notificationService.warn(localize('taskGraph.noTasks', 'No active spec session with tasks'));
	}
});

// 创建检查点
CommandsRegistry.registerCommand('aicore.createCheckpoint', async (accessor, args?: { label?: string; taskId?: string }) => {
	const checkpointService = accessor.get(ICheckpointService);
	const notificationService = accessor.get(INotificationService);

	const label = args?.label || `Manual checkpoint at ${new Date().toLocaleTimeString()}`;
	const checkpoint = await checkpointService.createCheckpoint(
		label,
		args?.taskId,
		CheckpointType.Manual,
	);
	notificationService.info(localize('checkpoint.created', 'Checkpoint created: {0}', checkpoint.label));
});

// 回滚到检查点
CommandsRegistry.registerCommand('aicore.rollbackCheckpoint', async (accessor, args?: { checkpointId?: string }) => {
	const checkpointService = accessor.get(ICheckpointService);
	const notificationService = accessor.get(INotificationService);

	if (!args?.checkpointId) {
		notificationService.warn(localize('checkpoint.noId', 'No checkpoint ID provided'));
		return;
	}

	const ok = await checkpointService.rollbackTo(args.checkpointId);
	if (ok) {
		notificationService.info(localize('checkpoint.rollbackOk', 'Rolled back successfully'));
	} else {
		notificationService.error(localize('checkpoint.rollbackFail', 'Rollback failed'));
	}
});

// 暂停/恢复执行
CommandsRegistry.registerCommand('aicore.pauseTaskGraph', async (accessor) => {
	accessor.get(ITaskGraphService).pause();
});

CommandsRegistry.registerCommand('aicore.resumeTaskGraph', async (accessor) => {
	accessor.get(ITaskGraphService).resume();
});

// 运行 TDD 闭环
CommandsRegistry.registerCommand('aicore.runTDD', async (accessor, args?: { filePath?: string; code?: string; description?: string; language?: string; taskId?: string }) => {
	const tddService = accessor.get(ITDDService);
	const notificationService = accessor.get(INotificationService);

	if (!args?.filePath || !args?.code || !args?.description || !args?.language) {
		notificationService.warn(localize('tdd.missingArgs', 'Missing required arguments for TDD'));
		return;
	}

	notificationService.info(localize('tdd.starting', 'Starting TDD cycle for {0}...', args.filePath));

	const result = await tddService.executeTDDCycle(
		args.filePath, args.code, args.description, args.language, args.taskId
	);

	if (result.isGreen) {
		notificationService.info(localize('tdd.green', 'All {0} tests passed!', result.testsPassed));
	} else {
		notificationService.warn(localize(
			'tdd.red',
			'TDD cycle: {0}/{1} tests passed after {2} iterations',
			result.testsPassed, result.testsGenerated, result.iteration
		));
	}
});

// 构建代码语义图谱
CommandsRegistry.registerCommand('aicore.buildCodeGraph', async (accessor) => {
	const codeGraphService = accessor.get(ICodeGraphService);
	const notificationService = accessor.get(INotificationService);

	notificationService.info(localize('codeGraph.building', 'Building code semantic graph...'));
	await codeGraphService.buildGraph();

	const stats = codeGraphService.getStats();
	notificationService.info(localize(
		'codeGraph.built',
		'Code graph built: {0} nodes, {1} edges',
		stats.totalNodes, stats.totalEdges
	));
});

// ============================================================================
// Menu Items
// ============================================================================

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.openTaskGraph', title: localize('taskGraph.open', 'AI Core: Open Task Graph') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.buildTaskGraph', title: localize('taskGraph.build', 'AI Core: Build Task Graph from Spec') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.createCheckpoint', title: localize('checkpoint.create', 'AI Core: Create Checkpoint') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.buildCodeGraph', title: localize('codeGraph.build', 'AI Core: Build Code Semantic Graph') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.runTDD', title: localize('tdd.run', 'AI Core: Run TDD Cycle') },
});

// ============================================================================
// Stage 1: LSP 诊断自修复
// ============================================================================

CommandsRegistry.registerCommand('aicore.runAutoFix', async (accessor, args?: { filePaths?: string[] }) => {
	const lspFeedback = accessor.get(ILSPFeedbackService);
	const notificationService = accessor.get(INotificationService);

	const filePaths = args?.filePaths;
	if (!filePaths || filePaths.length === 0) {
		notificationService.warn(localize('autoFix.noFiles', 'No files specified for auto-fix'));
		return;
	}

	const uris = filePaths.map(p => URI.file(p));
	notificationService.info(localize('autoFix.starting', 'Starting auto-fix for {0} files...', uris.length));

	const result = await lspFeedback.runAutoFixLoop(uris);
	if (result.success) {
		notificationService.info(localize('autoFix.success', 'Auto-fix complete: {0} errors fixed', result.fixed));
	} else {
		notificationService.warn(localize('autoFix.partial', 'Auto-fix: {0} fixed, {1} remaining after {2} iterations', result.fixed, result.remaining, result.iterations));
	}
});

// Stage 2: 意图对齐
CommandsRegistry.registerCommand('aicore.refineIntent', async (accessor, args?: { input?: string }) => {
	const intentService = accessor.get(IIntentRefinementService);
	const notificationService = accessor.get(INotificationService);

	if (!args?.input) {
		notificationService.warn(localize('intent.noInput', 'No input provided for intent refinement'));
		return;
	}

	const refined = await intentService.refine(args.input);
	notificationService.info(localize(
		'intent.refined',
		'Intent refined: {0} constraints, {1} files, confidence={2}',
		refined.inferredConstraints.length,
		refined.suggestedFiles.length,
		refined.confidence.toFixed(2)
	));
});

// Stage 3: 成本仪表盘
CommandsRegistry.registerCommand('aicore.openCostDashboard', async (accessor) => {
	const viewsService = accessor.get(IViewsService);
	await viewsService.openView(COST_DASHBOARD_VIEW_ID, true);
});

CommandsRegistry.registerCommand('aicore.routeTask', async (accessor, args?: { description?: string; files?: string[] }) => {
	const modelRouter = accessor.get(IModelRouterService);
	const notificationService = accessor.get(INotificationService);

	const desc = args?.description || 'unknown task';
	const files = args?.files || [];

	const decision = modelRouter.routeTask(desc, files);
	notificationService.info(localize(
		'router.decision',
		'Task routed to {0} (TCI={1}, est. cost=${2})',
		decision.model.name,
		decision.tci.score,
		decision.estimatedCost.toFixed(4)
	));
});

// Stage 4: 对抗性审查
CommandsRegistry.registerCommand('aicore.redTeamReview', async (accessor, args?: { code?: string; filePath?: string; description?: string }) => {
	const redTeam = accessor.get(IRedTeamService);
	const notificationService = accessor.get(INotificationService);

	if (!args?.code || !args?.filePath || !args?.description) {
		notificationService.warn(localize('redTeam.missingArgs', 'Missing required arguments for Red Team review'));
		return;
	}

	notificationService.info(localize('redTeam.starting', 'Starting adversarial review for {0}...', args.filePath));

	const result = await redTeam.executeRedTeamRound(args.description, args.code, args.filePath);
	if (result.finalApproval) {
		notificationService.info(localize('redTeam.approved', 'Red Team review: APPROVED'));
	} else {
		notificationService.warn(localize(
			'redTeam.rejected',
			'Red Team review: REJECTED ({0} vulnerabilities found)',
			result.review.vulnerabilities.length
		));
	}
});

// ============================================================================
// Additional Menu Items
// ============================================================================

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.runAutoFix', title: localize('autoFix.command', 'AI Core: Run LSP Auto-Fix') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.refineIntent', title: localize('intent.command', 'AI Core: Refine Intent') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.openCostDashboard', title: localize('costDashboard.command', 'AI Core: Open Cost Dashboard') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.routeTask', title: localize('router.command', 'AI Core: Route Task to Model') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.redTeamReview', title: localize('redTeam.command', 'AI Core: Red Team Review') },
});

// ============================================================================
// Stage 1 扩展: Tree-sitter AST 解析
// ============================================================================

CommandsRegistry.registerCommand('aicore.buildASTIndex', async (accessor) => {
	const treeSitter = accessor.get(ITreeSitterService);
	const notificationService = accessor.get(INotificationService);

	notificationService.info(localize('ast.building', 'Building AST symbol index...'));
	const stats = await treeSitter.buildSymbolIndex();
	notificationService.info(localize(
		'ast.built',
		'AST index built: {0} files, {1} symbols',
		stats.totalFiles,
		stats.totalSymbols
	));
});

CommandsRegistry.registerCommand('aicore.parseCurrentFile', async (accessor, args?: { filePath?: string }) => {
	const treeSitter = accessor.get(ITreeSitterService);
	const notificationService = accessor.get(INotificationService);

	if (!args?.filePath) {
		notificationService.warn(localize('ast.noFile', 'No file path specified'));
		return;
	}

	const snapshot = await treeSitter.parse(URI.file(args.filePath));
	if (snapshot) {
		notificationService.info(localize(
			'ast.parsed',
			'Parsed {0}: {1} symbols in {2}ms',
			args.filePath,
			snapshot.symbols.length,
			snapshot.parseTimeMs.toFixed(1)
		));
	}
});

// Stage 4 扩展: 符号验证
CommandsRegistry.registerCommand('aicore.verifyCode', async (accessor, args?: { code?: string; spec?: string }) => {
	const verifier = accessor.get(ISymbolicVerificationService);
	const notificationService = accessor.get(INotificationService);

	if (!args?.code) {
		notificationService.warn(localize('verify.noCode', 'No code provided for verification'));
		return;
	}

	notificationService.info(localize('verify.starting', 'Running symbolic verification...'));

	const assertions = args.spec
		? await verifier.extractAssertions(args.spec, args.code)
		: verifier.inferAssertions(args.code, 'typescript');

	const cert = await verifier.verifyAll(assertions, args.code);

	if (cert.allVerified) {
		notificationService.info(localize('verify.pass', 'Symbolic verification PASSED: {0} assertions verified', cert.assertions.length));
	} else {
		notificationService.warn(localize('verify.fail', 'Symbolic verification: {0}', cert.summary));
	}
});

// Stage 2 扩展: 领域图谱
CommandsRegistry.registerCommand('aicore.buildDomainOntology', async (accessor) => {
	const ontologyService = accessor.get(IDomainOntologyService);
	const notificationService = accessor.get(INotificationService);

	notificationService.info(localize('ontology.building', 'Building domain ontology...'));
	const ontology = await ontologyService.buildOntology();
	notificationService.info(localize(
		'ontology.built',
		'Domain ontology built: {0} concepts, {1} relations',
		ontology.concepts.size,
		ontology.relations.length
	));
});

// ============================================================================
// Additional Menu Items
// ============================================================================

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.buildASTIndex', title: localize('ast.command', 'AI Core: Build AST Symbol Index') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.verifyCode', title: localize('verify.command', 'AI Core: Verify Code (Symbolic)') },
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: { id: 'aicore.buildDomainOntology', title: localize('ontology.command', 'AI Core: Build Domain Ontology') },
});
