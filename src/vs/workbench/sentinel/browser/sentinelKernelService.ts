/*---------------------------------------------------------------------------------------------
 *  Sentinel Kernel Service
 *  中央编排引擎 — 真实执行闭环、Worker 上下文链、自动回滚、动态 DAG、持久化
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IContextStateService } from './contextStateService.js';
import { IExecutionGraphService } from './executionGraphService.js';
import { IIntentGraphService } from './intentGraphService.js';
import { IMaterializerService } from './materializerService.js';
import { IProjectionService } from './projectionService.js';
import { ICheckpointLedgerService } from './checkpointLedgerService.js';
import { IReasoningTraceService } from './reasoningTraceService.js';
import { IRoutingService } from './routingService.js';
import { IVerificationGateService } from './verificationGateService.js';
import { IWorkerRuntimeService } from './workerRuntimeService.js';
import { ISentinelPersistenceService } from './persistenceService.js';
import { ISentinelKernelService } from '../common/sentinelKernelService.js';
import { ExecutionGraph, ExecutionNode, ExecutionNodeType, GoalDriftCheck } from '../common/executionTypes.js';
import { Intent, intentSummariesToGraph } from '../common/intentTypes.js';
import { ProjectionArtifact } from '../common/projectionTypes.js';
import { ActivitySeverity, ReasoningTrace, RequirementAnalysis, SentinelPhase, SentinelPersistedWorkspaceState, SentinelProductSnapshot } from '../common/sentinelTypes.js';
import { VerificationBundle } from '../common/verificationTypes.js';
import { WorkerRole, WorkerRun } from '../common/workerTypes.js';
import { ICodeGraphService } from '../../services/aiCore/browser/codeGraphService.js';
import { ITDDService } from '../../services/aiCore/browser/tddService.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { INativeEnvironmentService } from '../../../platform/environment/common/environment.js';
import * as resources from '../../../base/common/resources.js';
import { SecurityHarnessException } from '../common/harnessErrors.js';
import { resolveSentinelStagingFileUri, getSentinelStagingRootUri } from '../common/sentinelStagingScheme.js';
import { IContractNegotiatorService } from './contractNegotiatorService.js';
import { IHarnessConfigService, ResolvedHarnessConfig } from './harnessConfigService.js';
import { IHarnessGateService } from './harnessGateService.js';
import { ISentinelStagingFsService } from './sentinelStagingFsService.js';
import { IExecutionDocService } from './executionDocService.js';
import { ISentinelPromoteService, PromoteResult } from './promoteStagingService.js';
import { IImplementationPlanService } from './implementationPlanService.js';
import { ISentinelExportService } from './sentinelExportService.js';
import { IMcpToolRegistryService } from './mcpToolRegistryService.js';
import { ISentinelMcpBridgeService } from './sentinelMcpBridgeService.js';
import { IBehavioralHarnessService } from './behavioralHarnessService.js';
import { SentinelHarnessRuntimeSnapshot } from '../common/sentinelTypes.js';
import { appendAnthropicProgressLog, ensureAnthropicHarnessArtifacts, expandFeatureRegistryFromAnalystOutput, shouldApplyAnthropicParity, updateFeatureRegistryPassesAfterVerify } from './anthropicHarnessParity.js';
import { ensureDefaultMcpAllowlistIfNeeded } from './sentinelMcpBootstrap.js';
import { IGLMChatService } from '../../services/aiCore/browser/glmChatService.js';
import { ISentinelAgentHarnessService } from './sentinelAgentHarnessService.js';
import { ISentinelEvaluatorPipelineService } from './sentinelEvaluatorPipelineService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { mergePackageJsonStrings } from '../common/packageJsonMerge.js';
import { IHarnessTraceService } from '../../services/aiCore/browser/harnessTraceService.js';
import { IHarnessAuditLogService } from '../../services/aiCore/browser/harnessAuditLogService.js';
import { ISentinelTaskIsolationService } from './sentinelTaskIsolationService.js';
import { INotificationService, Severity } from '../../../platform/notification/common/notification.js';

/** 多节点流水线中避免后序实现覆盖已有应用入口 */
const MATERIALIZE_ENTRY_FILE_NORMALIZED = new Set([
	'src/app.tsx',
	'src/main.tsx',
	'index.html',
]);

function normalizeMaterializeRelativePath(filePath: string): string {
	return filePath.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
}

/** Harness 启用且 Analyst 首跑缺少 CAP_PRIMARY / TECH_STACK_CONTRACT 时追加到 goal，触发一次自动重试 */
const ANALYST_STRUCT_RETRY_SUFFIX =
	'\n\n【系统补述】上次输出结构不完整；请严格按 Analyst 全链路输出：≥10 行 BRAINSTORM_DIRECTOR:、## 头脑风暴整合纪要、## 项目总监统筹结论、## 详尽需求说明文档（PRD 草案）含各 ### 子标题、CAP_*、TECH_STACK_CONTRACT:、## 需求对齐与验收锚点（USER_STATED_CORE、SYSTEM_INTERPRETATION、至少 3 条 ACCEPTANCE_CRITERION:）、## 专家组联合研判、## 联网检索与对标。';

function isAnalystStructurallyWeak(analysis: RequirementAnalysis): boolean {
	return !analysis.userCapabilityPrimary?.trim() || !analysis.techStackContract?.trim();
}

export class SentinelKernelService extends Disposable implements ISentinelKernelService {
	readonly _serviceBrand: undefined;

	private phase: SentinelPhase = 'idle';
	private readonly activities = new Array<SentinelProductSnapshot['activities'][number]>();
	private readonly pausedIntents = new Set<string>();
	private readonly workerOutputChain = new Map<string, Map<string, string>>();
	private readonly negotiatedIntents = new Set<string>();
	private readonly implementationPlanOk = new Set<string>();
	private harnessRuntimeSnapshot: SentinelHarnessRuntimeSnapshot = {};
	private pendingAnalysis: RequirementAnalysis | undefined;
	private readonly isolationWarnedIntentIds = new Set<string>();
	/** 供 harnessRuntime / P3 洞察展示物化根 */
	private lastMaterializeRootKind: 'workspace' | 'worktree' | 'staging' | undefined;
	/** 持久化恢复的当前意图；新建意图时更新，删除意图时回退 */
	private activeIntentIdOverride: string | undefined;

	private readonly _onDidUpdatePhase = this._register(new Emitter<SentinelPhase>());
	readonly onDidUpdatePhase = this._onDidUpdatePhase.event;

	private readonly _onDidUpdateSnapshot = this._register(new Emitter<SentinelProductSnapshot>());
	readonly onDidUpdateSnapshot = this._onDidUpdateSnapshot.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IIntentGraphService private readonly intentGraphService: IIntentGraphService,
		@IExecutionGraphService private readonly executionGraphService: IExecutionGraphService,
		@IContextStateService private readonly contextStateService: IContextStateService,
		@IReasoningTraceService private readonly reasoningTraceService: IReasoningTraceService,
		@ICheckpointLedgerService private readonly checkpointLedgerService: ICheckpointLedgerService,
		@IVerificationGateService private readonly verificationGateService: IVerificationGateService,
		@IRoutingService private readonly routingService: IRoutingService,
		@IWorkerRuntimeService private readonly workerRuntimeService: IWorkerRuntimeService,
		@IProjectionService private readonly projectionService: IProjectionService,
		@IMaterializerService _materializerService: IMaterializerService,
		@ISentinelPersistenceService private readonly persistenceService: ISentinelPersistenceService,
		@ICodeGraphService private readonly codeGraphService: ICodeGraphService,
		@ITDDService private readonly tddService: ITDDService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@INativeEnvironmentService private readonly nativeEnvironmentService: INativeEnvironmentService,
		@IHarnessConfigService private readonly harnessConfigService: IHarnessConfigService,
		@ISentinelStagingFsService private readonly sentinelStagingFsService: ISentinelStagingFsService,
		@IContractNegotiatorService private readonly contractNegotiatorService: IContractNegotiatorService,
		@IHarnessGateService private readonly harnessGateService: IHarnessGateService,
		@IExecutionDocService private readonly executionDocService: IExecutionDocService,
		@ISentinelPromoteService private readonly promoteStagingService: ISentinelPromoteService,
		@IImplementationPlanService private readonly implementationPlanService: IImplementationPlanService,
		@ISentinelExportService private readonly sentinelExportService: ISentinelExportService,
		@IMcpToolRegistryService private readonly mcpToolRegistryService: IMcpToolRegistryService,
		@ISentinelMcpBridgeService private readonly sentinelMcpBridgeService: ISentinelMcpBridgeService,
		@IBehavioralHarnessService private readonly behavioralHarnessService: IBehavioralHarnessService,
		@IGLMChatService private readonly glmChatService: IGLMChatService,
		@ISentinelAgentHarnessService private readonly sentinelAgentHarnessService: ISentinelAgentHarnessService,
		@ISentinelEvaluatorPipelineService private readonly sentinelEvaluatorPipelineService: ISentinelEvaluatorPipelineService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHarnessTraceService private readonly harnessTraceService: IHarnessTraceService,
		@IHarnessAuditLogService private readonly harnessAuditLogService: IHarnessAuditLogService,
		@ISentinelTaskIsolationService private readonly taskIsolationService: ISentinelTaskIsolationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	// ════════════════════════════════════════════════════════════════════════
	// Snapshot
	// ════════════════════════════════════════════════════════════════════════

	getSnapshot(): SentinelProductSnapshot {
		const list = this.intentGraphService.listIntents();
		const resolvedId =
			this.activeIntentIdOverride && this.intentGraphService.getIntent(this.activeIntentIdOverride)
				? this.activeIntentIdOverride
				: list.at(-1)?.id;
		const activeIntent = resolvedId ? this.intentGraphService.getIntent(resolvedId) : undefined;
		return {
			phase: this.phase,
			activeIntentId: resolvedId ?? activeIntent?.id,
			pendingAnalysis: this.pendingAnalysis,
			harnessRuntime: { ...this.harnessRuntimeSnapshot },
			intents: this.intentGraphService.listIntents().map(intent => ({
				id: intent.id,
				title: intent.title,
				goal: intent.goal,
				status: intent.status,
				priority: intent.priority,
				riskLevel: intent.riskLevel,
				intentCard: intent.intentCard,
				updatedAt: intent.updatedAt,
			})),
			executionGraphs: this.executionGraphService.listGraphs(),
			verificationBundles: this.verificationGateService.listBundles(),
			workerRuns: this.workerRuntimeService.getRuns(),
			artifacts: this.projectionService.listArtifacts(),
			activities: [...this.activities].reverse(),
			costLedger: this.routingService.getCostLedger(),
			lastUpdated: Date.now(),
		};
	}

	// ════════════════════════════════════════════════════════════════════════
	// Intent Creation — CodeGraph 驱动的影响面分析
	// ════════════════════════════════════════════════════════════════════════

	async createIntentFromGoal(goal: string, source: string = 'user'): Promise<Intent> {
		this.setPhase('intent_workspace');

		const analysis = await this.analyzeGoalWithCodeGraph(goal);

		const intent = this.intentGraphService.createIntent(goal, {
			description: `Source: ${source}`,
			allowedFiles: analysis.relevantFiles,
			constraints: analysis.constraints,
		});
		this.activeIntentIdOverride = intent.id;

		if (analysis.relevantFiles.length > 0 || analysis.relatedSymbols.length > 0) {
			this.intentGraphService.updateIntent(intent.id, {
				affectedFiles: analysis.relevantFiles,
				relatedSymbols: analysis.relatedSymbols,
				intentCard: {
					...intent.intentCard,
					allowedFiles: analysis.relevantFiles.length > 0 ? analysis.relevantFiles : intent.intentCard.allowedFiles,
				},
			});
		}

		this.recordActivity('intent', '创建意图', `已接收目标：${goal}` +
			(analysis.relevantFiles.length > 0 ? ` | 关联文件: ${analysis.relevantFiles.join(', ')}` : '') +
			(analysis.relatedSymbols.length > 0 ? ` | 关联符号: ${analysis.relatedSymbols.join(', ')}` : ''),
			intent.id);

		this.reasoningTraceService.recordTrace(intent.id, 'intent_workspace', '从用户目标创建意图对象，并通过 CodeGraph 分析影响面', {
			evidence: [goal, ...analysis.relevantFiles.map(f => `Related: ${f}`), ...analysis.relatedSymbols.map(s => `Symbol: ${s}`)],
			decision: analysis.relevantFiles.length > 0
				? `根据 CodeGraph 分析，影响范围限定在 ${analysis.relevantFiles.join(', ')} 内`
				: '创建新的 Intent 并等待规划',
		});

		this.persistState();
		this.emitSnapshot();
		return intent;
	}

	// ════════════════════════════════════════════════════════════════════════
	// Planning — 动态 DAG 生成
	// ════════════════════════════════════════════════════════════════════════

	async planIntent(intentId: string): Promise<ExecutionGraph | undefined> {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return undefined;
		}

		const harnessCfg = await this.harnessConfigService.getResolved();
		const graphOpts = { appendVerifyAfterImplement: harnessCfg.defaultExecutionGraphIncludeVerify };
		const defaultPhaseLabel = harnessCfg.defaultExecutionGraphIncludeVerify ? '规划→实现→验证' : '规划→实现';

		const wsFolder = this.workspaceContextService.getWorkspace().folders[0];
		if (wsFolder) {
			await ensureAnthropicHarnessArtifacts(this.fileService, wsFolder.uri, intent.goal, harnessCfg, this.logService);
			await ensureDefaultMcpAllowlistIfNeeded(this.fileService, wsFolder.uri, harnessCfg, this.logService);
			if (
				harnessCfg.anthropicHarnessParity ||
				harnessCfg.implementerAgentToolLoop ||
				harnessCfg.verifierAgentToolLoop ||
				harnessCfg.behavioralE2E
			) {
				void this.sentinelMcpBridgeService.syncAllowlistToWorkspace().then(s => {
					this.logService.info(`[Sentinel] MCP allowlist sync: ${s.detail}`);
				});
			}
		}

		this.setPhase('planning');

		const routing = this.routingService.route(intent, {
			id: 'planning_node',
			title: 'Planning',
			description: 'Plan intent execution',
			type: 'plan',
			status: 'running',
			workerRole: 'planner' as any,
			dependencies: [],
			gate: { allowedFiles: [], successCriteria: [], nonGoals: [], stopIf: [] },
			artifactIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const plannerRun = await this.workerRuntimeService.run(intent, {
			id: 'planning_node',
			title: 'Planning',
			description: '将意图拆解为可执行任务节点',
			type: 'plan',
			status: 'running',
			workerRole: 'planner' as any,
			dependencies: [],
			gate: {
				allowedFiles: intent.intentCard.allowedFiles,
				successCriteria: intent.intentCard.successCriteria,
				nonGoals: intent.intentCard.nonGoals,
				stopIf: intent.intentCard.stopIf,
			},
			artifactIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}, routing);

		let graph: ExecutionGraph;
		if (plannerRun.status === 'completed' && plannerRun.outputSummary) {
			graph = this.executionGraphService.createDynamicGraphForIntent(intent, plannerRun.outputSummary, graphOpts);
			this.recordActivity('execution', '动态执行图生成', `Planner 输出已解析为 ${graph.nodes.length} 节点的动态执行图`, intent.id);
			const depWhitelist = this.parsePlannerDependencyWhitelist(plannerRun.outputSummary);
			if (depWhitelist.length > 0) {
				const cur = this.intentGraphService.getIntent(intentId);
				if (cur) {
					const withoutOld = cur.intentCard.constraints.filter(c => !c.startsWith('[Planner] 依赖白名单:'));
					this.intentGraphService.updateIntent(intentId, {
						intentCard: {
							...cur.intentCard,
							constraints: [...withoutOld, `[Planner] 依赖白名单: ${depWhitelist.join(', ')}`],
						},
					});
				}
			}
		} else {
			graph = this.executionGraphService.createGraphForIntent(intent, graphOpts);
			this.recordActivity('execution', '默认执行图生成', `使用默认执行图（${defaultPhaseLabel}，见 executionTypes.createDefaultExecutionGraph）`, intent.id);
		}

		if (shouldApplyAnthropicParity(harnessCfg) && harnessCfg.designCollisionPass !== false) {
			if (this.executionGraphService.appendAnthropicDesignCollisionPass(intent.id)) {
				graph = this.executionGraphService.getGraph(intent.id) ?? graph;
				this.recordActivity('execution', '设计对撞节点', '已在末轮实现后插入审查→收敛两节点', intent.id);
				this.appendHarnessProgressLine(`设计对撞 pass 已挂载 intent=${intent.id} 当前节点数=${graph.nodes.length}`);
			}
		}

		this.intentGraphService.updateIntent(intentId, {
			status: 'planned',
			executionGraphIds: [graph.id],
		});

		this.reasoningTraceService.recordTrace(intent.id, 'planning', '已为意图建立执行图。', {
			optionsConsidered: graph.nodes.map(n => n.title),
			decision: plannerRun.status === 'completed' ? '采用 Planner 驱动的动态执行图' : `回退到默认执行图（${defaultPhaseLabel}）`,
		});

		this.appendHarnessProgressLine(
			`Planner 完成 intent=${intent.id} 节点数=${graph.nodes.length} (${plannerRun.status === 'completed' ? '动态图' : '默认图'})`,
		);

		this.persistState();
		this.emitSnapshot();
		return graph;
	}

	// ════════════════════════════════════════════════════════════════════════
	// Execution — 真实闭环：Worker → 物化 → 测试 → 回滚
	// ════════════════════════════════════════════════════════════════════════

	async executeNextNode(intentId: string): Promise<WorkerRun | undefined> {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return undefined;
		}

		const graph = this.executionGraphService.getGraph(intentId);
		const node = graph?.currentNodeId
			? graph.nodes.find(item => item.id === graph.currentNodeId)
			: undefined;
		if (!graph || !node) {
			return undefined;
		}

		return this.executeNode(intent, graph, node);
	}

	async runAllNodes(intentId: string): Promise<WorkerRun[]> {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return [];
		}

		let graph = this.executionGraphService.getGraph(intentId);
		if (!graph) {
			graph = await this.planIntent(intentId) ?? undefined;
			if (!graph) {
				return [];
			}
		}

		this.pausedIntents.delete(intentId);
		this.recordActivity('system', '自动运行启动', `开始自动执行意图 ${intent.title} 的所有节点`, intentId);
		const runs: WorkerRun[] = [];
		const harnessRunAll = await this.harnessConfigService.getResolved();

		const MAX_RETRIES = 2;
		let runAllExit: 'finished' | 'paused' | 'blocked_abort' = 'finished';

		while (true) {
			if (this.pausedIntents.has(intentId)) {
				this.recordActivity('system', '执行已暂停', `用户暂停了意图 ${intent.title} 的自动执行`, intentId);
				runAllExit = 'paused';
				break;
			}

			graph = this.executionGraphService.getGraph(intentId);
			if (!graph) { break; }

			const nextNode = graph.nodes.find(n =>
				n.status === 'pending' || n.status === 'ready' || n.status === 'blocked'
			);

			if (!nextNode) {
				break;
			}

			if (nextNode.status === 'blocked') {
				const retryCount = (nextNode as any)._retryCount || 0;
				if (retryCount >= MAX_RETRIES) {
					if (harnessRunAll.autoSkipBlockedNodesOnRunAll) {
						this.logService.info(`[Sentinel] Node ${nextNode.title} blocked after ${MAX_RETRIES} retries, forcing completion (autoSkipBlockedNodesOnRunAll)`);
						this.executionGraphService.updateNodeStatus(intentId, nextNode.id, 'completed',
							`[自动跳过] 在 ${MAX_RETRIES} 次重试后仍有关键问题，已跳过`);
						continue;
					}
					this.logService.warn(`[Sentinel] runAll 中止：节点 ${nextNode.title} 仍阻塞，未标为完成。可在 .sentinel/harness.json 设置 autoSkipBlockedNodesOnRunAll: true 恢复自动跳过。`);
					this.recordActivity('system', '自动运行中止',
						`节点「${nextNode.title}」验证仍阻塞，已停止自动执行（节点保持 blocked）。`, intentId, nextNode.id, 'failure');
					runAllExit = 'blocked_abort';
					this.setPhase('blocked');
					break;
				}
				(nextNode as any)._retryCount = retryCount + 1;
				this.recordActivity('system', '自动重试', `节点 ${nextNode.title} 验证阻塞，第 ${retryCount + 1} 次重试`, intentId, nextNode.id);
			}

			if (nextNode.status !== 'ready') {
				this.executionGraphService.updateNodeStatus(intentId, nextNode.id, 'ready');
			}
			graph.currentNodeId = nextNode.id;

			const latestIntent = this.intentGraphService.getIntent(intentId);
			if (!latestIntent) { break; }

			try {
				const updatedGraph = this.executionGraphService.getGraph(intentId)!;
				const freshNode = updatedGraph.nodes.find(n => n.id === nextNode.id)!;
				const run = await this.executeNode(latestIntent, updatedGraph, freshNode);
				if (run) { runs.push(run); }
			} catch (err) {
				this.logService.error(`[Sentinel] Node ${nextNode.title} threw exception, forcing completion`, err);
				this.executionGraphService.updateNodeStatus(intentId, nextNode.id, 'completed',
					`[异常] ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const finalGraph = this.executionGraphService.getGraph(intentId);
		if (finalGraph) {
			const totalNodes = finalGraph.nodes.length;
			const completedNodes = finalGraph.nodes.filter(n => n.status === 'completed').length;
			if (runAllExit === 'blocked_abort') {
				this.logService.info(`[Sentinel] 自动运行已中止: ${completedNodes}/${totalNodes} 节点已完成，存在未解决的阻塞节点`);
				this.appendHarnessProgressLine(
					`runAll 中止 intent=${intentId}（验证阻塞，${completedNodes}/${totalNodes} 已完成）`,
				);
			} else if (runAllExit === 'paused') {
				this.logService.info(`[Sentinel] 自动运行已暂停: ${completedNodes}/${totalNodes} 节点已完成`);
				this.recordActivity('system', '自动运行已暂停',
					`意图 ${intent.title} 的自动执行已暂停（已完成 ${completedNodes}/${totalNodes}）`, intentId);
				this.appendHarnessProgressLine(
					`runAll 暂停 intent=${intentId}（${completedNodes}/${totalNodes}）`,
				);
			} else {
				this.executionGraphService.updateGraphStatus(intentId, 'completed');
				this.setPhase('projection');
				this.logService.info(`[Sentinel] 自动运行完成: ${completedNodes}/${totalNodes} 节点已完成`);
				this.recordActivity('system', '自动运行完成',
					`意图 ${intent.title} 的全部节点已执行完毕 (${completedNodes}/${totalNodes})`, intentId);
				this.intentGraphService.updateIntent(intentId, { status: 'projected' });

				this.appendHarnessProgressLine(
					`runAll 完成 intent=${intentId} 节点 ${completedNodes}/${totalNodes}（Anthropic handoff：请查 feature_registry / 下方节点日志）`,
				);

				this.tryAutoPreview(intent);

				const exportCfg = await this.harnessConfigService.getResolved();
				if (exportCfg.exportBundleOnComplete) {
					const expUri = await this.sentinelExportService.exportLatestBundle(intentId);
					if (expUri) {
						this.harnessRuntimeSnapshot = { ...this.harnessRuntimeSnapshot, lastExportUri: expUri.toString() };
					}
				}
			}
		}

		this.persistState();
		this.emitSnapshot();
		return runs;
	}

	pauseExecution(intentId: string): void {
		this.pausedIntents.add(intentId);
		this.logService.info(`[Sentinel] Execution paused for intent ${intentId}`);
	}

	async resumeExecution(intentId: string): Promise<WorkerRun[]> {
		this.pausedIntents.delete(intentId);
		this.recordActivity('system', '执行已恢复', `用户恢复了意图的自动执行`, intentId);
		return this.runAllNodes(intentId);
	}

	async retryNode(intentId: string, nodeId: string): Promise<WorkerRun | undefined> {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return undefined;
		}

		const graph = this.executionGraphService.getGraph(intentId);
		const node = graph?.nodes.find(n => n.id === nodeId);
		if (!graph || !node) {
			return undefined;
		}

		await this.checkpointLedgerService.rollback(node.checkpointRef || '');

		this.executionGraphService.updateNodeStatus(intentId, nodeId, 'ready');
		this.executionGraphService.updateNodeMetadata(intentId, nodeId, {
			result: undefined,
			driftCheck: undefined,
			verificationRef: undefined,
		} as any);

		this.recordActivity('system', '节点重试', `用户触发节点 ${node.title} 的重试（已回滚检查点）`, intentId, nodeId);

		const updatedGraph = this.executionGraphService.getGraph(intentId);
		const updatedNode = updatedGraph?.nodes.find(n => n.id === nodeId);
		if (!updatedGraph || !updatedNode) {
			return undefined;
		}

		return this.executeNode(intent, updatedGraph, updatedNode);
	}

	isExecutionPaused(intentId: string): boolean {
		return this.pausedIntents.has(intentId);
	}

	// ════════════════════════════════════════════════════════════════════════
	// Query
	// ════════════════════════════════════════════════════════════════════════

	getIntent(intentId: string): Intent | undefined {
		return this.intentGraphService.getIntent(intentId);
	}

	getExecutionGraph(intentId: string): ExecutionGraph | undefined {
		return this.executionGraphService.getGraph(intentId);
	}

	getContextState(intentId: string, nodeId: string) {
		return this.contextStateService.getContextState(intentId, nodeId);
	}

	getVerificationBundle(intentId: string, nodeId?: string): VerificationBundle | undefined {
		return this.verificationGateService.getBundle(intentId, nodeId);
	}

	getReasoningTraces(intentId: string): ReasoningTrace[] {
		return this.reasoningTraceService.getTraces(intentId);
	}

	getArtifacts(intentId: string): ProjectionArtifact[] {
		return this.projectionService.getArtifacts(intentId);
	}

	async rollbackNode(intentId: string, nodeId: string): Promise<boolean> {
		const graph = this.executionGraphService.getGraph(intentId);
		const node = graph?.nodes.find(n => n.id === nodeId);
		if (!node || !node.checkpointRef) {
			return false;
		}

		await this.checkpointLedgerService.rollback(node.checkpointRef);
		this.executionGraphService.updateNodeStatus(intentId, nodeId, 'ready');
		this.executionGraphService.updateNodeMetadata(intentId, nodeId, {
			result: undefined,
			driftCheck: undefined,
			verificationRef: undefined,
			failureAttribution: undefined,
		} as any);

		this.recordActivity('system', '手动回滚', `用户手动回滚节点 ${node.title} 至检查点`, intentId, nodeId);
		this.persistState();
		this.emitSnapshot();
		return true;
	}

	deleteIntent(intentId: string): boolean {
		const deleted = this.intentGraphService.deleteIntent(intentId);
		if (deleted) {
			if (this.activeIntentIdOverride === intentId) {
				this.activeIntentIdOverride = this.intentGraphService.listIntents().at(-1)?.id;
			}
			this.negotiatedIntents.delete(intentId);
			this.implementationPlanOk.delete(intentId);
			if (this.pendingAnalysis?.intentId === intentId) {
				this.pendingAnalysis = undefined;
			}
			this.recordActivity('system', '删除意图', `用户删除了意图 ${intentId}`, intentId);
			this.persistState();
			this.emitSnapshot();
		}
		return deleted;
	}

	async analyzeRequirement(intentId: string): Promise<RequirementAnalysis | undefined> {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return undefined;
		}

		this.setPhase('analyzing');
		this.recordActivity('intent', '需求分析开始', `正在深度分析需求：${intent.goal}`, intentId);
		this.emitSnapshot();

		const analysisNode: ExecutionNode = {
			id: 'analysis_node',
			title: '需求分析',
			description: '深度分析用户需求，识别模糊点，生成完整规格',
			type: 'analyze',
			status: 'running',
			workerRole: WorkerRole.Analyst,
			dependencies: [],
			gate: { allowedFiles: [], successCriteria: [], nonGoals: [], stopIf: [] },
			artifactIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const routing = this.routingService.route(intent, analysisNode);
		let run = await this.workerRuntimeService.run(intent, analysisNode, routing);

		if (run.status !== 'completed' || !run.outputSummary) {
			this.recordActivity('intent', '需求分析失败', `分析执行失败：${run.outputSummary?.slice(0, 200) || '无输出'}`, intentId, undefined, 'failure');
			this.setPhase('intent_workspace');
			this.emitSnapshot();
			return undefined;
		}

		const originalGoal = intent.goal;
		let analysis = this.parseAnalysisOutput(intentId, originalGoal, run.outputSummary);

		const hcfg = await this.harnessConfigService.getResolved();
		if (hcfg.enabled && isAnalystStructurallyWeak(analysis)) {
			this.recordActivity('system', 'Analyst 结构化重试',
				'Harness 已启用且 CAP_PRIMARY/TECH_STACK_CONTRACT 缺失，正在自动重试 Analyst 一次',
				intentId, undefined, 'warning');
			this.intentGraphService.updateIntent(intentId, { goal: `${originalGoal}${ANALYST_STRUCT_RETRY_SUFFIX}` });
			const intentRetry = this.intentGraphService.getIntent(intentId)!;
			const run2 = await this.workerRuntimeService.run(intentRetry, analysisNode, routing);
			this.intentGraphService.updateIntent(intentId, { goal: originalGoal });
			if (run2.status === 'completed' && run2.outputSummary) {
				run = run2;
				analysis = this.parseAnalysisOutput(intentId, originalGoal, run2.outputSummary);
				this.recordActivity('system', 'Analyst 结构化重试', '重试完成，已重新解析输出', intentId);
			} else {
				this.recordActivity('system', 'Analyst 结构化重试', '重试未成功，沿用首次输出', intentId, undefined, 'warning');
			}
		}

		this.addToWorkerOutputChain(intentId, 'analyst', run.outputSummary);

		const wsFolder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (wsFolder) {
			void expandFeatureRegistryFromAnalystOutput(
				this.fileService,
				this.glmChatService,
				wsFolder,
				routing.modelId,
				hcfg,
				run.outputSummary,
				this.logService,
			).catch(e => this.logService.warn(`[SentinelKernel] feature_registry expand: ${String(e)}`));
		}

		this.pendingAnalysis = analysis;

		const mergedSuccessCriteria = [...intent.intentCard.successCriteria];
		for (const c of analysis.proposedAcceptanceCriteria ?? []) {
			const t = c.trim();
			if (t && !mergedSuccessCriteria.includes(t)) {
				mergedSuccessCriteria.push(t);
			}
		}

		this.intentGraphService.updateIntent(intentId, {
			intentCard: {
				...intent.intentCard,
				successCriteria: mergedSuccessCriteria,
				constraints: [
					...intent.intentCard.constraints,
					...(analysis.techStack.length > 0 ? [`技术栈: ${analysis.techStack.join(', ')}`] : []),
				],
			},
		});

		if ((analysis.proposedAcceptanceCriteria?.length ?? 0) < 3) {
			this.recordActivity('system', '验收锚点不足',
				'解析到的 ACCEPTANCE_CRITERION 少于 3 条；建议重新分析或在确认前补充 IntentCard.successCriteria',
				intentId, undefined, 'warning');
		}
		if ((analysis.brainstormDirectors?.length ?? 0) < 10) {
			this.recordActivity('system', '头脑风暴角色不足',
				`解析到 BRAINSTORM_DIRECTOR ${analysis.brainstormDirectors?.length ?? 0} 行（要求≥10）；建议重新分析以强化入口规格`,
				intentId, undefined, 'warning');
		}

		const capHint = analysis.userCapabilityPrimary
			? ` 能力锚点=${analysis.userCapabilityPrimary}`
			: '';
		const panelHint = analysis.expertPanelSummary?.trim()
			? '；已解析专家组联合研判'
			: '';
		const webHint = analysis.webResearchSummary?.trim()
			? '；已解析联网检索与对标摘要'
			: (analysis.featureMatrixItems?.length ? `；功能矩阵 ${analysis.featureMatrixItems.length} 条` : '');
		this.recordActivity('intent', '需求分析完成',
			`识别 ${analysis.ambiguities.length} 个模糊点，${analysis.questions.length} 个待确认问题，复杂度: ${analysis.estimatedComplexity}${capHint}${panelHint}${webHint}`,
			intentId);

		if (!analysis.userCapabilityPrimary?.trim() || !analysis.techStackContract?.trim()) {
			this.recordActivity('system', 'Analyst 结构化字段不完整',
				'未解析到 CAP_PRIMARY 或 TECH_STACK_CONTRACT；已继续流程，若下游异常可重试需求分析',
				intentId, undefined, 'warning');
		}

		if (hcfg.enabled && hcfg.splitLargeGoalsAutoCreate && analysis.suggestedChildGoals && analysis.suggestedChildGoals.length > 0) {
			const goals = analysis.suggestedChildGoals.slice(0, 5);
			for (const g of goals) {
				if (g.trim().length > 0) {
					await this.createIntentFromGoal(g.trim(), `split:${intentId}`);
				}
			}
			this.recordActivity('system', '子意图已创建',
				`Analyst SPLIT_INTENT：已创建 ${goals.length} 条子意图（请在 Intent 列表中择一执行）`, intentId, undefined, 'success');
			const wsSplit = this.workspaceContextService.getWorkspace().folders[0]?.uri;
			if (wsSplit && goals.length > 0) {
				void appendAnthropicProgressLog(
					this.fileService,
					wsSplit,
					hcfg,
					`SPLIT_INTENT：已创建 ${goals.length} 条子意图 — ${goals.map(g => g.replace(/\s+/g, ' ').trim().slice(0, 120)).join(' | ')}`,
					{ warn: m => this.logService.warn(m) },
				);
			}
		}

		const autoChain =
			hcfg.enabled &&
			hcfg.autoRun &&
			!hcfg.humanGateAfterAnalysis &&
			!(hcfg.splitLargeGoalsAutoCreate && analysis.suggestedChildGoals && analysis.suggestedChildGoals.length > 0);

		this.reasoningTraceService.recordTrace(intentId, 'intent_workspace', '需求分析完成', {
			evidence: [
				analysis.userCapabilityPrimary ? `能力锚点: ${analysis.userCapabilityPrimary} (${analysis.userCapabilityCode || '—'})` : '能力锚点: （未解析）',
				`模糊点: ${analysis.ambiguities.join('; ')}`,
				`假设: ${analysis.assumptions.join('; ')}`,
				`技术栈: ${analysis.techStack.join(', ')}`,
			],
			decision: autoChain
				? 'harness 已开启自动执行，将直接规划并跑 DAG（无需用户点击确认）'
				: (hcfg.humanGateAfterAnalysis
					? 'humanGateAfterAnalysis：强制待用户确认后再执行'
					: (analysis.questions.length > 0 ? '等待用户确认' : '可以直接执行')),
		});

		this.appendHarnessProgressLine(
			`需求分析完成 intent=${intentId} 待确认问题=${analysis.questions.length} 复杂度=${analysis.estimatedComplexity}`,
		);

		if (autoChain) {
			this.recordActivity('intent', '自动进入执行',
				'harness autoRun：跳过人工确认，由内核直接 confirm→plan→runAll', intentId);
			this.persistState();
			this.emitSnapshot();
			try {
				await this.confirmAndExecute(intentId, []);
			} catch (e) {
				this.logService.error(`[SentinelKernel] 自动 confirmAndExecute 失败: ${String(e)}`);
				this.setPhase('awaiting_confirmation');
				this.persistState();
				this.emitSnapshot();
			}
			return analysis;
		}

		this.setPhase('awaiting_confirmation');
		this.persistState();
		this.emitSnapshot();
		return analysis;
	}

	async confirmAndExecute(intentId: string, userAnswers?: string[]): Promise<WorkerRun[]> {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return [];
		}

		if (this.pendingAnalysis?.intentId === intentId) {
			const analysis = this.pendingAnalysis;

			const additionalConstraints: string[] = [];
			const additionalCriteria: string[] = [];
			let goalSupplement = '';

			if (userAnswers && userAnswers.length > 0) {
				for (const answer of userAnswers) {
					if (answer.startsWith('[用户补充]')) {
						goalSupplement = answer.replace('[用户补充] ', '');
					} else if (answer.startsWith('[拒绝假设]')) {
						const rejected = answer.replace('[拒绝假设] ', '');
						additionalConstraints.push(`用户拒绝以下假设: ${rejected}`);
					} else if (answer.startsWith('[采纳建议]')) {
						const adopted = answer.replace('[采纳建议] ', '');
						adopted.split('; ').forEach(s => additionalCriteria.push(`实现: ${s}`));
					} else if (answer.includes('→')) {
						additionalConstraints.push(`用户回答: ${answer}`);
					}
				}
			}

			const anchorTail = this.buildCapabilityAnchorTail(analysis);
			const baseSpec = analysis.fullSpec || intent.goal;
			const enrichedGoal = goalSupplement
				? `${baseSpec}${anchorTail}\n\n用户补充：${goalSupplement}`
				: `${baseSpec}${anchorTail}`;

			this.intentGraphService.updateIntent(intentId, {
				description: enrichedGoal,
				intentCard: {
					...intent.intentCard,
					goal: enrichedGoal,
					constraints: [
						...intent.intentCard.constraints,
						...additionalConstraints,
					],
					successCriteria: [
						...intent.intentCard.successCriteria,
						...additionalCriteria,
					],
				},
			});

			const feedbackSummary = userAnswers && userAnswers.length > 0
				? `用户反馈 ${userAnswers.length} 条: ${userAnswers.map(a => a.slice(0, 60)).join(' | ')}`
				: '用户无额外修改';

			this.recordActivity('system', '用户确认需求', feedbackSummary, intentId);
			this.pendingAnalysis = undefined;
		} else {
			this.recordActivity('system', '用户确认需求', '需求已确认，开始规划和执行', intentId);
		}

		this.appendHarnessProgressLine(`confirm→plan→runAll 开始 intent=${intentId}`);
		await this.planIntent(intentId);
		return this.runAllNodes(intentId);
	}

	addExecutionNode(intentId: string, title: string, description: string, type: string, afterNodeId?: string): boolean {
		const intent = this.intentGraphService.getIntent(intentId);
		if (!intent) {
			return false;
		}

		const typeMap: Record<string, { type: ExecutionNodeType; role: WorkerRole }> = {
			'analyze': { type: 'analyze', role: WorkerRole.Analyst },
			'implement': { type: 'implement', role: WorkerRole.Implementer },
			'review': { type: 'review', role: WorkerRole.Reviewer },
			'test': { type: 'test', role: WorkerRole.Tester },
			'verify': { type: 'verify', role: WorkerRole.Verifier },
			'plan': { type: 'plan', role: WorkerRole.Planner },
			'project': { type: 'project', role: WorkerRole.Refiner },
		};
		const mapping = typeMap[type] || typeMap['implement'];

		const now = Date.now();
		const newNode: ExecutionNode = {
			id: `custom_${now}`,
			title,
			description,
			type: mapping.type,
			status: 'pending',
			workerRole: mapping.role,
			dependencies: afterNodeId ? [afterNodeId] : [],
			gate: {
				allowedFiles: intent.intentCard.allowedFiles,
				successCriteria: intent.intentCard.successCriteria,
				nonGoals: intent.intentCard.nonGoals,
				stopIf: intent.intentCard.stopIf,
			},
			artifactIds: [],
			createdAt: now,
			updatedAt: now,
		};

		const result = this.executionGraphService.addNode(intentId, newNode, afterNodeId);
		if (result) {
			this.recordActivity('system', '添加节点', `用户添加了新节点: ${title} (${type})`, intentId);
			this.persistState();
			this.emitSnapshot();
			return true;
		}
		return false;
	}

	removeExecutionNode(intentId: string, nodeId: string): boolean {
		const result = this.executionGraphService.removeNode(intentId, nodeId);
		if (result) {
			this.recordActivity('system', '删除节点', `用户删除了节点 ${nodeId}`, intentId);
			this.persistState();
			this.emitSnapshot();
		}
		return result;
	}

	moveExecutionNode(intentId: string, nodeId: string, direction: 'up' | 'down'): boolean {
		const result = this.executionGraphService.moveNode(intentId, nodeId, direction);
		if (result) {
			this.recordActivity('system', '节点重排', `用户将节点 ${nodeId} ${direction === 'up' ? '上移' : '下移'}`, intentId);
			this.persistState();
			this.emitSnapshot();
		}
		return result;
	}

	async seedDemoState(): Promise<void> {
		const intent = await this.createIntentFromGoal('重建订单结算流程，要求可回滚、可验证、限制在 checkout 模块内。', 'demo');
		this.intentGraphService.updateIntent(intent.id, {
			intentCard: {
				goal: intent.goal,
				nonGoals: ['不要影响支付链路', '不要修改公共登录逻辑'],
				constraints: ['沿用现有 checkout 模块边界', '必须补充验证证据'],
				allowedFiles: ['checkout', 'orders'],
				successCriteria: ['结算流程通过验证门', '影响面保持在 checkout / orders 范围内'],
				stopIf: ['出现未授权跨域修改', '验证门出现阻塞问题'],
			},
		});
		await this.planIntent(intent.id);
		await this.executeNextNode(intent.id);
	}

	private buildRepairUserPayload(
		intent: Intent,
		node: ExecutionNode,
		run: WorkerRun,
		bundle: VerificationBundle,
		drift: GoalDriftCheck,
		round: number,
		maxRounds: number,
	): string {
		const sections: string[] = [
			`# 自动修复 第 ${round}/${maxRounds} 轮`,
			`## 节点: ${node.title}（类型 ${node.type}，角色 ${node.workerRole}）`,
			`## Worker 状态: ${run.status}`,
			`## Worker 输出（节选）\n\`\`\`\n${run.outputSummary.slice(0, 12000)}\n\`\`\``,
			`## 验证门禁: ${bundle.overallStatus}`,
			`## 验证摘要\n${bundle.summary}`,
		];
		if (bundle.blockingIssues.length > 0) {
			sections.push(`## 阻塞项\n${bundle.blockingIssues.slice(0, 40).join('\n')}`);
		}
		if (drift.status !== 'pass') {
			sections.push(`## 目标漂移\n${drift.reasons.join('\n')}`);
		}
		sections.push(`## 当前 Intent Goal\n${intent.goal}`);
		sections.push('请基于上述证据修复；需要时使用联网工具查官方文档、错误码、依赖版本与 breaking changes。');
		return sections.join('\n\n');
	}

	// ════════════════════════════════════════════════════════════════════════
	// Core: executeNode — 真实执行循环
	// ════════════════════════════════════════════════════════════════════════

	private async executeNode(intent: Intent, _graph: ExecutionGraph, node: ExecutionNode): Promise<WorkerRun> {
		this.setPhase('execution');

		const riskLevel = this.executionGraphService.computeNodeRiskLevel(node, intent);
		const complexityScore = this.executionGraphService.computeNodeComplexity(node, intent);
		this.executionGraphService.updateNodeMetadata(intent.id, node.id, {
			riskLevel,
			complexityScore,
		});

		this.executionGraphService.updateNodeStatus(intent.id, node.id, 'running');

		const planEarly = await this.runImplementationPlanPrelude(intent, _graph, node);
		if (planEarly) {
			await this.persistHarnessTaskState(intent, node, planEarly);
			await this.executionDocService.recordNodeCompletion({
				intentId: intent.id,
				intentTitle: intent.title,
				nodeId: node.id,
				nodeTitle: node.title,
				nodeType: node.type,
				runStatus: planEarly.status,
				outcome: 'blocked',
				note: planEarly.outputSummary.slice(0, 200),
			});
			return planEarly;
		}

		const harnessEarly = await this.runHarnessPrelude(intent, _graph, node);
		if (harnessEarly) {
			await this.persistHarnessTaskState(intent, node, harnessEarly);
			await this.executionDocService.recordNodeCompletion({
				intentId: intent.id,
				intentTitle: intent.title,
				nodeId: node.id,
				nodeTitle: node.title,
				nodeType: node.type,
				runStatus: harnessEarly.status,
				outcome: harnessEarly.status === 'failed' ? 'failed' : 'blocked',
				note: harnessEarly.outputSummary.slice(0, 200),
			});
			return harnessEarly;
		}

		const checkpoint = await this.checkpointLedgerService.createCheckpointForNode(intent, node);
		const traceId = this.harnessTraceService.beginTrace(`sentinel:${intent.id}:${node.id}`);
		this.logService.info(`[trace=${traceId}] executeNode start ${node.title} (${node.type})`);
		let materializedFiles: string[] = [];
		try {

		const nodeExecuteStartMs = Date.now();
		const harnessCfgForCso = await this.harnessConfigService.getResolved();
		const useStagingForCso = harnessCfgForCso.enabled && harnessCfgForCso.stagingWrites;
		const csoRoot =
			!useStagingForCso && harnessCfgForCso.enabled && harnessCfgForCso.taskIsolation === 'worktree'
				? await this.taskIsolationService.getIsolationRootIfReady(harnessCfgForCso, intent.id)
				: undefined;
		if (harnessCfgForCso.enabled && harnessCfgForCso.taskIsolation === 'worktree' && !csoRoot && !this.isolationWarnedIntentIds.has(intent.id)) {
			this.isolationWarnedIntentIds.add(intent.id);
			this.recordActivity('system', '任务隔离未就绪',
				'已启用 taskIsolation:worktree 但 .sentinel/worktrees/<intentId> 尚未创建。请在仓库根执行: node scripts/sentinel-worktree.mjs',
				intent.id, node.id, 'warning');
		}
		if (harnessCfgForCso.enabled && harnessCfgForCso.behavioralE2E && node.type === 'verify') {
			await this.behavioralHarnessService.capturePreForVerify(intent);
		}
		const previousOutputs = this.getWorkerOutputChain(intent.id);
		const stateless = harnessCfgForCso.enabled && harnessCfgForCso.statelessExecution;
		const recentDecisions = stateless
			? ['物理重置：请仅依据磁盘上的 .sentinel/task_state.json / IMPLEMENTATION_PLAN.json / ADR，勿依赖长对话。']
			: [
				intent.goal,
				...Array.from(previousOutputs.entries()).map(([role, output]) =>
					`[${role}] ${output.slice(0, 400)}`
				),
			];
		const cso = await this.contextStateService.buildContextState(intent, node, {
			summary: `${intent.title} / ${node.title}`,
			affectedFiles: intent.intentCard.allowedFiles,
			checkpointRef: checkpoint.id,
			recentDecisions,
			stateless,
			workspaceRootOverride: csoRoot,
		});

		this.reasoningTraceService.recordTrace(intent.id, 'execution', `节点 ${node.title} 开始执行`, {
			nodeId: node.id,
			evidence: [
				cso.summary,
				`Risk: ${riskLevel}, Complexity: ${complexityScore}`,
				...cso.diagnostics.slice(0, 5),
			],
			decision: '建立新的 Context State Object 并启动 Worker',
			expectedImpact: `影响文件: ${intent.intentCard.allowedFiles.join(', ') || '未限定'}; 风险: ${riskLevel}`,
			validatorHints: [
				...node.gate.successCriteria.slice(0, 3),
				...(node.gate.stopIf.length > 0 ? [`StopIf: ${node.gate.stopIf[0]}`] : []),
			],
		});

		const ledgerPre = this.routingService.getCostLedger();
		const capPre = harnessCfgForCso.softTokenBudgetTotal;
		const overBudget =
			harnessCfgForCso.enabled && capPre > 0 && ledgerPre.totalTokens > capPre;
		if (overBudget && harnessCfgForCso.softTokenBudgetBlockNewNodes) {
			this.recordActivity(
				'system',
				'Token 软预算硬停',
				`累计 ${ledgerPre.totalTokens} > ${capPre}（HGT-010 softTokenBudgetBlockNewNodes）`,
				intent.id,
				node.id,
				'failure',
			);
			void this.harnessAuditLogService.append('token_budget', {
				action: 'block_node',
				totalTokens: ledgerPre.totalTokens,
				cap: capPre,
				intentId: intent.id,
				nodeId: node.id,
			});
			return await this.failNodeHarness(
				intent,
				_graph,
				node,
				`HGT-010：累计 Token 已超过软预算 ${capPre}，且已启用 softTokenBudgetBlockNewNodes`,
			);
		}
		const budgetDegrade = overBudget && harnessCfgForCso.softTokenBudgetDegradeModels;
		let routing = this.routingService.route(intent, node, { budgetDegrade });

		this.executionGraphService.updateNodeMetadata(intent.id, node.id, {
			costRef: routing.id,
		});

		this.logService.info(`[Sentinel] Node ${node.title} routed to model: ${routing.modelId} (tier=${routing.tier})`);

		let run = await this.workerRuntimeService.run(intent, node, routing, cso);

		if (run.status === 'failed' && routing.tier !== 'power') {
			const escalated = this.routingService.escalateOnFailure(intent, node, run.outputSummary, routing);
			if (escalated) {
				this.logService.info(`[Sentinel] ESCALATION: ${node.title} ${routing.modelId} → ${escalated.modelId}`);
				this.recordActivity('system', '模型升级',
					`节点 ${node.title} 在 ${routing.tier}/${routing.modelId} 失败，升级至 ${escalated.tier}/${escalated.modelId}`,
					intent.id, node.id);
				routing = escalated;
				run = await this.workerRuntimeService.run(intent, node, routing, cso);
			}
		}

		if (run.status === 'completed') {
			this.addToWorkerOutputChain(intent.id, node.workerRole, run.outputSummary);
		}

		if (run.status === 'completed' && (node.type === 'implement' || node.type === 'project')) {
			const w = await this.materializeWorkerOutput(intent, node, run);
			materializedFiles = [...new Set([...materializedFiles, ...w])];
		}

		if (run.status === 'completed' && node.type === 'test') {
			await this.runRealTests(intent, node, run);
		}

		this.setPhase('verification');
		const reviewerOutput = node.type === 'review' && run.status === 'completed'
			? run.outputSummary
			: this.getWorkerOutputChain(intent.id).get('reviewer') || undefined;
		let bundle = await this.verificationGateService.buildBundle(intent, node, reviewerOutput, {
			verifierWorkerSummary: node.workerRole === WorkerRole.Verifier ? run.outputSummary : undefined,
		});
		const harnessForBeh = await this.harnessConfigService.getResolved();
		if (harnessForBeh.enabled && harnessForBeh.behavioralE2E && node.type === 'verify') {
			const beh = await this.behavioralHarnessService.finalizePostAndCompare(intent);
			if (!beh.ok) {
				bundle = {
					...bundle,
					overallStatus: 'blocked',
					matchedSuccessCriteria: [],
					summary: `行为快照 E2E：${beh.failures.join('; ') || '断言范围内文件发生变更'}`,
					blockingIssues: [...bundle.blockingIssues, `behavioral_e2e_${Date.now()}`],
					evidence: [
						...bundle.evidence,
						{
							id: `evidence_behavioral_${Date.now()}`,
							kind: 'trace' as const,
							summary: `pre=${beh.preRef} post=${beh.postRef} 变更: ${beh.changedPaths.slice(0, 12).join(', ') || '—'}`,
							createdAt: Date.now(),
						},
					],
					updatedAt: Date.now(),
				};
				this.verificationGateService.commitBundle(bundle);
			}
		}
		if (
			harnessForBeh.enabled &&
			harnessForBeh.evaluatorPipelineEnabled &&
			node.type === 'verify' &&
			run.status === 'completed'
		) {
			bundle = await this.sentinelEvaluatorPipelineService.enrichVerifyBundle(intent, node, bundle, harnessForBeh);
			this.verificationGateService.commitBundle(bundle);
		}
		const matchedForDrift = bundle.matchedSuccessCriteria ?? [];
		let drift = this.executionGraphService.runGoalDriftCheck(
			node,
			materializedFiles,
			matchedForDrift,
		);

		let workerFailed = run.status === 'failed';
		let isCriticallyBlocked = bundle.overallStatus === 'blocked';

		const hRepair = await this.harnessConfigService.getResolved();
		const maxRepair = hRepair.enabled && hRepair.autoRepairOnFailure
			? Math.max(0, hRepair.autoRepairMaxRounds ?? 0)
			: 0;

		const baseRepairSys = [
			'你是 Sentinel-IDE 内置的自动修复 Agent。',
			'系统已收集本节点 Worker 输出与验证门禁结论；你的任务是修到尽量通过验证，而不是向用户解释概念。',
		].join('\n');

		for (let r = 0; r < maxRepair && (workerFailed || isCriticallyBlocked); r++) {
			const round = r + 1;
			this.recordActivity('execution', '自动修复',
				`节点 ${node.title} 第 ${round}/${maxRepair} 轮：工具 + 联网检索`, intent.id, node.id);
			this.appendHarnessProgressLine(`自动修复 intent=${intent.id} node=${node.title} 第${round}/${maxRepair}轮`);
			const payload = this.buildRepairUserPayload(intent, node, run, bundle, drift, round, maxRepair);
			await this.sentinelAgentHarnessService.runRepairAgentLoop(intent, node, routing, baseRepairSys, payload, hRepair);

			if (workerFailed) {
				run = await this.workerRuntimeService.run(intent, node, routing, cso);
				if (run.status === 'failed' && routing.tier !== 'power') {
					const escalatedRepair = this.routingService.escalateOnFailure(intent, node, run.outputSummary, routing);
					if (escalatedRepair) {
						this.logService.info(`[Sentinel] Repair ESCALATION: ${node.title} → ${escalatedRepair.modelId}`);
						routing = escalatedRepair;
						run = await this.workerRuntimeService.run(intent, node, routing, cso);
					}
				}
				if (run.status === 'completed') {
					this.addToWorkerOutputChain(intent.id, node.workerRole, run.outputSummary);
				}
				if (run.status === 'completed' && (node.type === 'implement' || node.type === 'project')) {
					const wr = await this.materializeWorkerOutput(intent, node, run);
					materializedFiles = [...new Set([...materializedFiles, ...wr])];
				}
				if (run.status === 'completed' && node.type === 'test') {
					await this.runRealTests(intent, node, run);
				}
			}

			bundle = await this.verificationGateService.buildBundle(intent, node, reviewerOutput, {
				verifierWorkerSummary: node.workerRole === WorkerRole.Verifier ? run.outputSummary : undefined,
			});
			if (hRepair.enabled && hRepair.behavioralE2E && node.type === 'verify') {
				const behR = await this.behavioralHarnessService.finalizePostAndCompare(intent);
				if (!behR.ok) {
					bundle = {
						...bundle,
						overallStatus: 'blocked',
						matchedSuccessCriteria: [],
						summary: `行为快照 E2E：${behR.failures.join('; ') || '断言范围内文件发生变更'}`,
						blockingIssues: [...bundle.blockingIssues, `behavioral_e2e_${Date.now()}`],
						evidence: [
							...bundle.evidence,
							{
								id: `evidence_behavioral_${Date.now()}`,
								kind: 'trace' as const,
								summary: `pre=${behR.preRef} post=${behR.postRef} 变更: ${behR.changedPaths.slice(0, 12).join(', ') || '—'}`,
								createdAt: Date.now(),
							},
						],
						updatedAt: Date.now(),
					};
					this.verificationGateService.commitBundle(bundle);
				}
			}
			const matchedRepair = bundle.matchedSuccessCriteria ?? [];
			drift = this.executionGraphService.runGoalDriftCheck(
				node,
				materializedFiles,
				matchedRepair,
			);
			workerFailed = run.status === 'failed';
			isCriticallyBlocked = bundle.overallStatus === 'blocked';
		}
		const hasWarnings = bundle.overallStatus !== 'passed' || drift.status !== 'pass';

		if (hasWarnings) {
			const warningDetails: string[] = [];
			if (workerFailed) { warningDetails.push(`Worker 异常: ${run.outputSummary.slice(0, 200)}`); }
			if (bundle.overallStatus !== 'passed') { warningDetails.push(`验证: ${bundle.summary}`); }
			if (drift.status !== 'pass') { warningDetails.push(`漂移检测: ${drift.reasons.join('; ')}`); }
			this.logService.info(`[Sentinel] Node ${node.title} 验证结果: ${warningDetails.join(' | ')}`);
		}

		const harnessCfgPost = await this.harnessConfigService.getResolved();
		const strictVerifyWarnBlock =
			harnessCfgPost.enabled &&
			harnessCfgPost.verificationWarningBlocksCompletion &&
			bundle.overallStatus === 'warning';
		const strictDriftBlock =
			harnessCfgPost.enabled &&
			harnessCfgPost.driftNonPassBlocksCompletion &&
			drift.status !== 'pass';
		const isNodeCompletionBlocked = isCriticallyBlocked || strictVerifyWarnBlock || strictDriftBlock;
		let blockHeadline = '';
		if (isCriticallyBlocked) {
			blockHeadline = bundle.summary;
		} else if (strictVerifyWarnBlock) {
			blockHeadline = `验证为 warning，已按 verificationWarningBlocksCompletion 视为阻塞: ${bundle.summary}`;
		} else if (strictDriftBlock) {
			blockHeadline = `漂移 ${drift.status}，已按 driftNonPassBlocksCompletion 视为阻塞: ${drift.reasons.slice(0, 5).join('; ')}`;
		}

		const artifacts = this.projectionService.project(intent, node, run, bundle);

		this.executionGraphService.updateNodeMetadata(intent.id, node.id, {
			checkpointRef: checkpoint.id,
			verificationRef: bundle.id,
			driftCheck: drift,
			artifactIds: artifacts.map(item => item.id),
		});

		const nodeResult = run.status === 'completed'
			? run.outputSummary.slice(0, 500)
			: `[Worker ${run.status}] ${run.outputSummary.slice(0, 300)}`;

		const finalStatus = isNodeCompletionBlocked ? 'blocked' as const : 'completed' as const;

		const updatedGraphNode = this.executionGraphService.updateNodeStatus(
			intent.id,
			node.id,
			finalStatus,
			isNodeCompletionBlocked ? `[关键问题] ${blockHeadline}\n${nodeResult}` : nodeResult,
		);

		this.intentGraphService.updateIntent(intent.id, {
			status: updatedGraphNode?.type === 'project' ? 'projected' : 'running',
			verificationBundleIds: [...intent.verificationBundleIds, bundle.id],
			reasoningTraceIds: [
				...intent.reasoningTraceIds,
				...this.getReasoningTraces(intent.id).map(trace => trace.id),
			],
			affectedFiles: [...intent.intentCard.allowedFiles],
		});

		this.reasoningTraceService.recordTrace(intent.id, 'execution',
			`节点 ${node.title} 执行完成`, {
				nodeId: node.id,
				evidence: [
					`Worker: ${run.status} (model: ${routing.modelId})`,
					`Verification: ${bundle.overallStatus}（节点终态 ${finalStatus}）`,
					`Drift: ${drift.status}`,
					`Risk: ${riskLevel}, Complexity: ${complexityScore}`,
				].filter(Boolean),
				decision: '节点完成，推进到下一节点',
				expectedImpact: `节点完成，${artifacts.length} 个工件已生成`,
				validatorHints: hasWarnings
					? [`${bundle.blockingIssues.length} 个验证警告已记录`]
					: ['验证通过'],
			});

		const nodeActSeverity: ActivitySeverity =
			isNodeCompletionBlocked || workerFailed ? 'failure' : (hasWarnings ? 'warning' : 'success');
		this.recordActivity(
			'execution',
			'节点执行完成',
			`${node.title} [${routing.modelId}]: ${run.outputSummary.slice(0, 200)}`,
			intent.id,
			node.id,
			nodeActSeverity,
		);

		if (harnessCfgPost.enabled && harnessCfgPost.autoRollbackOnVerifyFailure && isNodeCompletionBlocked) {
			const rolled = await this.checkpointLedgerService.rollback(checkpoint.id);
			if (rolled) {
				this.recordActivity('system', '自动回滚', '验证失败，已回滚至节点前检查点', intent.id, node.id);
			}
		}
		if (harnessCfgPost.enabled && harnessCfgPost.promoteAfterVerified && harnessCfgPost.stagingWrites
			&& node.type === 'implement' && finalStatus === 'completed' && run.status === 'completed' && !isNodeCompletionBlocked) {
			const pr = await this.promoteStagingService.promoteAll(intent.intentCard.allowedFiles);
			this.harnessRuntimeSnapshot = {
				...this.harnessRuntimeSnapshot,
				lastPromote: { at: Date.now(), fileCount: pr.copied },
			};
			if (pr.errors.length > 0) {
				this.recordActivity('projection', 'Promote 部分失败', pr.errors.slice(0, 3).join('; '), intent.id, node.id);
			} else {
				this.recordActivity('projection', 'Promote', `已合并 ${pr.copied} 个文件到工作区`, intent.id, node.id);
			}
			void this.harnessAuditLogService.append('promote_staging', {
				intentId: intent.id,
				nodeId: node.id,
				copied: pr.copied,
				errors: pr.errors.slice(0, 8),
			});
			if (harnessCfgPost.gitSnapshots) {
				await this.appendGitPromoteLog(intent, pr);
			}
		}

		void Promise.all([
			this.sentinelMcpBridgeService.syncAllowlistToWorkspace(),
			this.mcpToolRegistryService.getAllowedMcpServerIds(),
		]).then(([sync, ids]) => {
			this.harnessRuntimeSnapshot = {
				...this.harnessRuntimeSnapshot,
				mcpAllowlistCount: ids.length,
				mcpBridgeWroteJson: sync.wroteMcpJson,
				mcpBridgeChatAccess: sync.updatedChatAccess,
				mcpBridgeDetail: sync.detail,
			};
		});

		const nodeElapsedMs = Date.now() - nodeExecuteStartMs;
		const prevMat = this.harnessRuntimeSnapshot.materializedFilesByIntent?.[intent.id] ?? [];
		const mergedMat = [...new Set([...prevMat, ...materializedFiles])];
		this.harnessRuntimeSnapshot = {
			...this.harnessRuntimeSnapshot,
			lastNodeExecutionMs: nodeElapsedMs,
			lastExecutedNodeTitle: node.title,
			lastExecutedIntentId: intent.id,
			...(this.lastMaterializeRootKind ? { lastMaterializeRoot: this.lastMaterializeRootKind } : {}),
			materializedFilesByIntent: {
				...this.harnessRuntimeSnapshot.materializedFilesByIntent,
				[intent.id]: mergedMat,
			},
		};
		if (this.configurationService.getValue<boolean>('aiCore.sentinel.desktopNotifyOnNodeComplete')) {
			const sev = workerFailed || isNodeCompletionBlocked ? Severity.Warning : Severity.Info;
			this.notificationService.notify({
				severity: sev,
				message: `Sentinel：${node.title} · ${(nodeElapsedMs / 1000).toFixed(1)}s${workerFailed ? '（Worker 失败）' : isNodeCompletionBlocked ? '（验证阻塞）' : ''}`,
			});
		}

		this.persistState();
		this.emitSnapshot();
		await this.persistHarnessTaskState(intent, node, run);

		const docOutcome: 'completed' | 'blocked' | 'failed' = isNodeCompletionBlocked
			? 'blocked'
			: (workerFailed ? 'failed' : 'completed');
		await this.executionDocService.recordNodeCompletion({
			intentId: intent.id,
			intentTitle: intent.title,
			nodeId: node.id,
			nodeTitle: node.title,
			nodeType: node.type,
			runStatus: run.status,
			outcome: docOutcome,
			note: bundle.summary,
		});

		this.appendHarnessProgressLine(
			`节点「${node.title}」(${node.type}) model=${routing.modelId} worker=${run.status} verify=${bundle.overallStatus}${isNodeCompletionBlocked ? ' BLOCKED' : ''}`,
		);

		const rootPost = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (rootPost) {
			void updateFeatureRegistryPassesAfterVerify(
				this.fileService,
				rootPost,
				harnessCfgPost,
				node,
				bundle,
				{ info: m => this.logService.info(m), warn: m => this.logService.warn(m) },
			).catch(e => this.logService.warn(`[SentinelKernel] feature_registry passes: ${String(e)}`));
		}
		this.checkSoftTokenBudget(harnessCfgPost, intent, node);
		void this.maybeAppendSuggestedGitCommit(harnessCfgPost, intent, node, finalStatus, run.status);
		void this.maybeAppendPendingGitCommand(harnessCfgPost, intent, node, finalStatus, run.status);

		return run;
		} finally {
			this.harnessTraceService.endTrace();
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	// Harness — 协商闸门 + 任务状态外部化
	// ════════════════════════════════════════════════════════════════════════

	private async runImplementationPlanPrelude(intent: Intent, graph: ExecutionGraph, node: ExecutionNode): Promise<WorkerRun | undefined> {
		const cfg = await this.harnessConfigService.getResolved();
		if (!cfg.enabled || !cfg.implementationPlanRequired || (node.type !== 'implement' && node.type !== 'project')) {
			return undefined;
		}
		if (this.implementationPlanOk.has(intent.id)) {
			return undefined;
		}
		const res = await this.implementationPlanService.negotiatePlan(intent);
		if (!res.ok) {
			return await this.failNodeHarness(intent, graph, node,
				`Implementation Plan 未达标 (score=${res.score.toFixed(2)}): ${res.lastErrors.join('; ') || '见日志'}`);
		}
		this.implementationPlanOk.add(intent.id);
		this.reasoningTraceService.recordTrace(intent.id, 'planning', 'Implementation Plan 已通过校验', {
			nodeId: node.id,
			evidence: res.plan ? [`${res.plan.steps.length} steps`] : [],
		});
		return undefined;
	}

	private async runHarnessPrelude(intent: Intent, graph: ExecutionGraph, node: ExecutionNode): Promise<WorkerRun | undefined> {
		const harnessCfg = await this.harnessConfigService.getResolved();
		await this.sentinelStagingFsService.ready;
		if (!harnessCfg.enabled || (node.type !== 'implement' && node.type !== 'project')) {
			return undefined;
		}
		try {
			if (harnessCfg.negotiationRequired && !this.negotiatedIntents.has(intent.id)) {
				this.setPhase('negotiation');
				const neg = await this.contractNegotiatorService.negotiateAdr(intent);
				if (!neg.ok) {
					return await this.failNodeHarness(intent, graph, node,
						`ADR 协商未达标 (score=${neg.score.toFixed(2)}): ${neg.lastErrors.join('; ') || '见日志'}`);
				}
				this.negotiatedIntents.add(intent.id);
			}
			if (harnessCfg.adrGate) {
				await this.harnessGateService.assertAdrSignedOff(intent);
			}
		} catch (e) {
			if (e instanceof SecurityHarnessException) {
				return await this.failNodeHarness(intent, graph, node, e.message);
			}
			throw e;
		}
		return undefined;
	}

	private async failNodeHarness(intent: Intent, graph: ExecutionGraph, node: ExecutionNode, message: string): Promise<WorkerRun> {
		this.executionGraphService.updateNodeStatus(intent.id, node.id, 'blocked', message);
		this.setPhase('blocked');
		this.recordActivity('execution', 'Harness 阻塞', message, intent.id, node.id, 'failure');
		this.reasoningTraceService.recordTrace(intent.id, 'blocked', `Harness: ${message}`, { nodeId: node.id });
		const run: WorkerRun = {
			id: `worker_run_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			role: node.workerRole,
			status: 'failed',
			modelId: 'harness',
			tier: 'fast',
			inputSummary: node.title,
			outputSummary: message,
			tokensUsed: 0,
			startedAt: Date.now(),
			finishedAt: Date.now(),
		};
		this.persistState();
		this.emitSnapshot();
		await this.executionDocService.recordNodeCompletion({
			intentId: intent.id,
			intentTitle: intent.title,
			nodeId: node.id,
			nodeTitle: node.title,
			nodeType: node.type,
			runStatus: run.status,
			outcome: 'blocked',
			note: message.slice(0, 200),
		});
		return run;
	}

	private async appendGitPromoteLog(intent: Intent, pr: PromoteResult): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const uri = URI.joinPath(root, '.sentinel', 'git_promote_log.jsonl');
		const line = JSON.stringify({
			at: Date.now(),
			intentId: intent.id,
			copied: pr.copied,
			paths: pr.paths.slice(0, 40),
		}) + '\n';
		try {
			await this.fileService.createFolder(URI.joinPath(root, '.sentinel'));
			let prev = '';
			try {
				prev = (await this.fileService.readFile(uri)).value.toString();
			} catch {
				// new file
			}
			await this.fileService.writeFile(uri, VSBuffer.fromString(prev + line));
		} catch (e) {
			this.logService.warn('[Sentinel] git_promote_log write failed', e);
		}
	}

	/** HGT-010：软 Token 预算（routing 账本累计） */
	private checkSoftTokenBudget(cfg: ResolvedHarnessConfig, intent: Intent, node: ExecutionNode): void {
		const cap = cfg.softTokenBudgetTotal;
		if (!cfg.enabled || cap <= 0) {
			return;
		}
		const ledger = this.routingService.getCostLedger();
		if (ledger.totalTokens > cap) {
			const msg = `累计 Token ${ledger.totalTokens} 超过软预算 ${cap}（HGT-010）`;
			this.logService.warn(`[SentinelKernel] ${msg}`);
			this.recordActivity('system', 'Token 软预算告警', msg, intent.id, node.id);
			void this.harnessAuditLogService.append('token_budget', {
				action: 'warn_post_node',
				totalTokens: ledger.totalTokens,
				cap,
				intentId: intent.id,
				nodeId: node.id,
			});
		}
	}

	/** HGT-014：仅追加建议行，不执行 git */
	private async maybeAppendSuggestedGitCommit(
		cfg: ResolvedHarnessConfig,
		intent: Intent,
		node: ExecutionNode,
		finalStatus: 'completed' | 'blocked',
		workerStatus: string,
	): Promise<void> {
		if (!cfg.enabled || !cfg.suggestGitCommitAfterNode || finalStatus !== 'completed' || workerStatus !== 'completed') {
			return;
		}
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const safeTitle = node.title.replace(/\s+/g, ' ').trim().slice(0, 80);
		const line = JSON.stringify({
			t: Date.now(),
			intentId: intent.id,
			nodeId: node.id,
			nodeType: node.type,
			hint: `git add -A && git commit -m "sentinel(${node.type}): ${safeTitle}"`,
		}) + '\n';
		const uri = URI.joinPath(root, '.sentinel', 'suggested_git_commits.log');
		try {
			await this.fileService.createFolder(URI.joinPath(root, '.sentinel'));
		} catch {
			// ignore
		}
		try {
			let prev = '';
			try {
				prev = (await this.fileService.readFile(uri)).value.toString();
			} catch {
				// new
			}
			await this.fileService.writeFile(uri, VSBuffer.fromString(prev + line));
			void this.harnessAuditLogService.append('suggested_git_commit', { intentId: intent.id, nodeId: node.id });
		} catch (e) {
			this.logService.warn(`[SentinelKernel] suggested_git_commits.log: ${String(e)}`);
		}
	}

	/** HGT-014：隔离 worktree 存在时写入待执行 git 行（由 scripts/sentinel-git-commit.mjs 消费） */
	private async maybeAppendPendingGitCommand(
		cfg: ResolvedHarnessConfig,
		intent: Intent,
		node: ExecutionNode,
		finalStatus: 'completed' | 'blocked',
		workerStatus: string,
	): Promise<void> {
		if (!cfg.enabled || !cfg.gitCommitAfterNode || finalStatus !== 'completed' || workerStatus !== 'completed') {
			return;
		}
		const iso = await this.taskIsolationService.getIsolationRootIfReady(cfg, intent.id);
		if (!iso) {
			return;
		}
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const safeTitle = node.title.replace(/\s+/g, ' ').trim().slice(0, 60);
		const line = JSON.stringify({
			t: Date.now(),
			intentId: intent.id,
			nodeId: node.id,
			cwd: iso.fsPath,
			cmd: `git add -A && git commit -m "sentinel(${node.type}): ${safeTitle}"`,
		}) + '\n';
		const uri = URI.joinPath(root, '.sentinel', 'pending_git_commands.jsonl');
		try {
			await this.fileService.createFolder(URI.joinPath(root, '.sentinel'));
		} catch {
			// ignore
		}
		try {
			let prev = '';
			try {
				prev = (await this.fileService.readFile(uri)).value.toString();
			} catch {
				// new
			}
			await this.fileService.writeFile(uri, VSBuffer.fromString(prev + line));
			void this.harnessAuditLogService.append('pending_git_command', {
				intentId: intent.id,
				nodeId: node.id,
				cwd: iso.fsPath,
			});
		} catch (e) {
			this.logService.warn(`[SentinelKernel] pending_git_commands.jsonl: ${String(e)}`);
		}
	}

	private appendHarnessProgressLine(line: string): void {
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!folder) {
			return;
		}
		void this.harnessConfigService.getResolved().then(cfg =>
			appendAnthropicProgressLog(this.fileService, folder, cfg, line, this.logService),
		);
	}

	private async persistHarnessTaskState(intent: Intent, node: ExecutionNode, run: WorkerRun): Promise<void> {
		const g = this.executionGraphService.getGraph(intent.id);
		const completedNodeIds = g?.nodes.filter(n => n.status === 'completed' || n.status === 'blocked').map(n => n.id) ?? [];
		const cfg = await this.harnessConfigService.getResolved();
		const vfsPointer = cfg.enabled && cfg.stagingWrites
			? getSentinelStagingRootUri().toString()
			: (this.workspaceContextService.getWorkspace().folders[0]?.uri.toString() ?? 'file://');
		await this.reasoningTraceService.persistTaskState({
			version: 1,
			intentId: intent.id,
			updatedAt: Date.now(),
			completedNodeIds,
			pendingVariables: { lastNodeId: node.id, workerStatus: run.status },
			vfsPointer,
			phase: this.phase,
		});
	}

	// ════════════════════════════════════════════════════════════════════════
	// Real Materialization — Implementer 产出写入文件系统
	// ════════════════════════════════════════════════════════════════════════

	private async materializeWorkerOutput(intent: Intent, node: ExecutionNode, run: WorkerRun): Promise<string[]> {
		const harnessCfg = await this.harnessConfigService.getResolved();
		const useStaging = harnessCfg.enabled && harnessCfg.stagingWrites;
		const isoRoot =
			!useStaging && harnessCfg.enabled && harnessCfg.taskIsolation === 'worktree'
				? await this.taskIsolationService.getIsolationRootIfReady(harnessCfg, intent.id)
				: undefined;
		const mergePackageJson = harnessCfg.materializeMergePackageJson;
		const skipExistingEntryFiles = harnessCfg.materializeSkipExistingEntryFiles;

		const fileBlocks = this.parseFileBlocks(run.outputSummary);

		if (fileBlocks.length === 0) {
			this.logService.info(`[Sentinel Materializer] No ### FILE: blocks found in output, trying fallback code block extraction`);
			const fallbackBlocks = this.extractFallbackCodeBlocks(run.outputSummary, intent);
			fileBlocks.push(...fallbackBlocks);
		}

		if (fileBlocks.length === 0) {
			const hint = harnessCfg.implementerAgentToolLoop
				? 'Implementer 可能已通过 Agent 工具（write_file）直接写入工作区，请检查文件树与终端。'
				: 'LLM 输出可能不包含 ### FILE 标记。';
			this.recordActivity('projection', '代码物化', `未检测到 ### FILE 块。${hint}`, intent.id, node.id);
			return [];
		}

		let applied = 0;
		let failed = 0;
		const writtenFiles: string[] = [];

		this.logService.info(`[Sentinel Materializer] Preparing to write ${fileBlocks.length} files (staging=${useStaging})`);

		for (const block of fileBlocks) {
			try {
				if (!this.harnessGateService.isRelativePathInScope(block.filePath, intent.intentCard.allowedFiles)) {
					this.logService.warn(`[Sentinel Harness] 跳过越权路径: ${block.filePath}`);
					failed++;
					continue;
				}
				let uri: URI | undefined;
				if (useStaging) {
					uri = resolveSentinelStagingFileUri(block.filePath);
					this.logService.info(`[Sentinel Materializer] Staging: ${block.filePath} → ${uri.toString()}`);
					await this.ensureParentDirUri(uri);
				} else if (isoRoot) {
					uri = URI.joinPath(isoRoot, block.filePath.replace(/^\.\//, ''));
					this.logService.info(`[Sentinel Materializer] Worktree: ${block.filePath} → ${uri.toString()}`);
					await this.ensureParentDirUri(uri);
				} else {
					uri = this.resolveWorkspaceUri(block.filePath);
					if (!uri) {
						this.logService.warn(`[Sentinel Materializer] Cannot resolve path: ${block.filePath}`);
						failed++;
						continue;
					}
					this.logService.info(`[Sentinel Materializer] Resolving: ${block.filePath} → ${uri.toString()}`);
					await this.ensureParentDir(uri);
				}

				const normalizedPath = normalizeMaterializeRelativePath(block.filePath);
				const isPackageJson = normalizedPath === 'package.json' || normalizedPath.endsWith('/package.json');

				if (skipExistingEntryFiles && MATERIALIZE_ENTRY_FILE_NORMALIZED.has(normalizedPath)) {
					try {
						const already = await this.fileService.exists(uri);
						if (already) {
							this.logService.warn(`[Sentinel Materializer] 跳过已存在入口文件覆盖（避免多节点流水线尾部步骤替换整应用）: ${block.filePath}`);
							continue;
						}
					} catch {
						// 若无法探测存在性，仍尝试写入
					}
				}

				let finalContent = block.content;
				if (mergePackageJson && isPackageJson) {
					try {
						const already = await this.fileService.exists(uri);
						if (already) {
							const prev = await this.fileService.readFile(uri);
							finalContent = mergePackageJsonStrings(prev.value.toString(), block.content);
							this.logService.info(`[Sentinel Materializer] package.json 已与磁盘合并依赖/脚本字段`);
						}
					} catch {
						// 读取失败则使用模型输出原文
					}
				}

				await this.fileService.writeFile(uri, VSBuffer.fromString(finalContent));
				applied++;
				writtenFiles.push(block.filePath);
				this.logService.info(`[Sentinel Materializer] Written: ${block.filePath} (${block.content.length} chars)`);
			} catch (err: any) {
				const errMsg = err?.message || err?.toString?.() || String(err);
				this.logService.error(`[Sentinel Materializer] Failed to write ${block.filePath}: ${errMsg}`);
				failed++;
			}
		}

		this.recordActivity('projection', '代码物化',
			`已写入 ${applied} 个文件: ${writtenFiles.join(', ')}` +
			(failed > 0 ? ` (${failed} 个失败)` : '') +
			(useStaging ? ' [影子 VFS]' : isoRoot ? ' [worktree]' : ''),
			intent.id, node.id);

		if (writtenFiles.length > 0 && harnessCfg.enabled) {
			void this.harnessAuditLogService.append('materialize', {
				intentId: intent.id,
				nodeId: node.id,
				fileCount: writtenFiles.length,
				files: writtenFiles.slice(0, 48),
			});
		}

		if (writtenFiles.length > 0) {
			this.lastMaterializeRootKind = useStaging ? 'staging' : isoRoot ? 'worktree' : 'workspace';
		}

		for (const filePath of writtenFiles.slice(0, 3)) {
			try {
				let uri: URI | undefined;
				if (useStaging) {
					uri = resolveSentinelStagingFileUri(filePath);
				} else if (isoRoot) {
					uri = URI.joinPath(isoRoot, filePath.replace(/^\.\//, ''));
				} else {
					uri = this.resolveWorkspaceUri(filePath);
				}
				if (uri && !useStaging) {
					await this.editorService.openEditor({ resource: uri });
				}
			} catch {
				// best-effort
			}
		}

		this.reasoningTraceService.recordTrace(intent.id, 'projection', '代码物化结果', {
			nodeId: node.id,
			evidence: [`写入 ${applied} 个文件`, `失败 ${failed} 个`, ...writtenFiles.map(f => `✓ ${f}`)],
			decision: failed > 0 ? '部分物化失败' : '全部物化成功',
		});
		if (writtenFiles.length > 0) {
			this.mergeMaterializedPathsIntoIntentAllowedFiles(intent, writtenFiles);
		}
		return writtenFiles;
	}

	/** 物化成功后把相对路径并入 IntentCard，供后续节点 CSO / 诊断过滤使用 */
	private mergeMaterializedPathsIntoIntentAllowedFiles(intent: Intent, writtenFiles: string[]): void {
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
		const existing = intent.intentCard.allowedFiles.map(norm).filter(Boolean);
		const set = new Set(existing);
		const merged = [...existing];
		let added = 0;
		for (const raw of writtenFiles) {
			const p = norm(raw);
			if (!p || set.has(p)) {
				continue;
			}
			set.add(p);
			merged.push(p);
			added++;
		}
		if (added === 0) {
			return;
		}
		this.intentGraphService.updateIntent(intent.id, {
			intentCard: {
				...intent.intentCard,
				allowedFiles: merged,
			},
		});
		this.logService.info(`[Sentinel] intent=${intent.id} allowedFiles 已合并 ${added} 条物化路径（共 ${merged.length} 条）`);
		this.persistState();
	}

	private parseFileBlocks(output: string): Array<{ filePath: string; content: string }> {
		const results: Array<{ filePath: string; content: string }> = [];

		const regexes = [
			/###\s*FILE:\s*(.+?)\s*\n\s*```[\w]*\s*\n([\s\S]*?)```/g,
			/###\s*FILE:\s*`([^`]+)`\s*\n\s*```[\w]*\s*\n([\s\S]*?)```/g,
			/##\s*FILE:\s*(.+?)\s*\n\s*```[\w]*\s*\n([\s\S]*?)```/g,
			/FILE:\s*(.+?)\s*\n\s*```[\w]*\s*\n([\s\S]*?)```/g,
		];

		for (const regex of regexes) {
			let match: RegExpExecArray | null;
			while ((match = regex.exec(output)) !== null) {
				const filePath = match[1].trim().replace(/^`|`$/g, '');
				const content = match[2];
				if (filePath && content.trim() && !results.some(r => r.filePath === filePath)) {
					results.push({ filePath, content });
				}
			}
			if (results.length > 0) { break; }
		}

		this.logService.info(`[Sentinel Materializer] parseFileBlocks found ${results.length} files: ${results.map(r => r.filePath).join(', ')}`);
		return results;
	}

	private extractFallbackCodeBlocks(output: string, intent: Intent): Array<{ filePath: string; content: string }> {
		const results: Array<{ filePath: string; content: string }> = [];
		const langToExt: Record<string, string> = {
			tsx: '.tsx', ts: '.ts', jsx: '.jsx', js: '.js',
			python: '.py', py: '.py', html: '.html', css: '.css',
			json: '.json', vue: '.vue', svelte: '.svelte',
		};

		const codeRegex = /```(\w+)\s*\n([\s\S]*?)```/g;
		let match: RegExpExecArray | null;
		let idx = 0;

		while ((match = codeRegex.exec(output)) !== null) {
			const lang = match[1];
			const content = match[2];
			if (lang === 'diff' || !content.trim() || content.trim().length < 50) { continue; }

			const ext = langToExt[lang] || `.${lang}`;
			const goalSlug = intent.goal.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').slice(0, 20);
			const filePath = `sentinel-output/${goalSlug}_${idx}${ext}`;
			results.push({ filePath, content });
			idx++;
		}

		return results;
	}

	private resolveWorkspaceUri(filePath: string): URI | undefined {
		const cleaned = filePath.replace(/^\.\//, '');

		if (cleaned.startsWith('/') || cleaned.includes('://')) {
			return URI.file(cleaned);
		}

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			return URI.joinPath(folders[0].uri, cleaned);
		}

		const fallbackRoot = URI.joinPath(this.nativeEnvironmentService.userHome, 'sentinel-output');
		this.logService.warn(`[Sentinel Materializer] No workspace folder open, using fallback: ${fallbackRoot.fsPath}`);
		return URI.joinPath(fallbackRoot, cleaned);
	}

	private async ensureParentDir(uri: URI): Promise<void> {
		const parentPath = uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/'));
		if (parentPath) {
			const parentUri = URI.file(parentPath);
			try {
				await this.fileService.exists(parentUri);
			} catch {
				// ignore
			}
			try {
				await this.fileService.createFolder(parentUri);
			} catch {
				// folder may already exist
			}
		}
	}

	private async ensureParentDirUri(uri: URI): Promise<void> {
		const root = getSentinelStagingRootUri();
		const chain: URI[] = [];
		let current = resources.dirname(uri);
		while (current.path.length >= root.path.length && current.path !== root.path) {
			chain.unshift(current);
			current = resources.dirname(current);
		}
		for (const p of chain) {
			try {
				await this.fileService.createFolder(p);
			} catch {
				// exists
			}
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	// Real Tests — Tester 产出触发真实测试执行
	// ════════════════════════════════════════════════════════════════════════

	private async runRealTests(intent: Intent, node: ExecutionNode, run: WorkerRun): Promise<void> {
		try {
			const targetFile = intent.intentCard.allowedFiles[0] || 'unknown';
			const testCode = this.extractTestCode(run.outputSummary);

			if (testCode) {
				const cycleResult = await this.tddService.executeTDDCycle(
					targetFile,
					testCode,
					intent.goal,
					'typescript',
					`${intent.id}_${node.id}`,
				);

				const statusText = cycleResult.isGreen ? '全部通过' : `${cycleResult.testsPassed}/${cycleResult.testsGenerated} 通过`;
				this.recordActivity('verification', cycleResult.isGreen ? 'TDD 闭环通过' : 'TDD 闭环未通过',
					`迭代 ${cycleResult.iteration} 次, ${statusText}, 自修复 ${cycleResult.autoFixAttempts} 次, 耗时 ${(cycleResult.totalDuration / 1000).toFixed(1)}s`,
					intent.id, node.id);

				this.reasoningTraceService.recordTrace(intent.id, 'verification', 'TDD 闭环结果', {
					nodeId: node.id,
					evidence: [
						`Green: ${cycleResult.isGreen}`,
						`Passed: ${cycleResult.testsPassed}/${cycleResult.testsGenerated}`,
						`Iterations: ${cycleResult.iteration}`,
						`Auto-fix attempts: ${cycleResult.autoFixAttempts}`,
					],
					decision: cycleResult.isGreen ? 'TDD 闭环通过，代码质量可接受' : 'TDD 闭环未通过，需要人工干预或更多修复迭代',
				});

				if (!cycleResult.isGreen) {
					this.executionGraphService.updateNodeMetadata(intent.id, node.id, {
						result: `TDD RED: ${cycleResult.testsFailed} 个测试失败（迭代 ${cycleResult.iteration} 次后仍未 Green）`,
					});
				}
			} else {
				this.recordActivity('verification', '测试跳过', 'Tester Worker 输出中未找到可执行的测试代码', intent.id, node.id);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.warn(`[Sentinel] TDD cycle failed: ${message}`);
			this.recordActivity('verification', 'TDD 执行失败', message, intent.id, node.id);
		}
	}

	private extractTestCode(output: string): string | undefined {
		const match = output.match(/```(?:typescript|javascript|ts|js)\s*\n([\s\S]*?)```/);
		return match?.[1]?.trim();
	}

	// ════════════════════════════════════════════════════════════════════════
	// CodeGraph-driven Impact Analysis
	// ════════════════════════════════════════════════════════════════════════

	private async analyzeGoalWithCodeGraph(goal: string): Promise<{
		relevantFiles: string[];
		relatedSymbols: string[];
		constraints: string[];
	}> {
		try {
			const alignment = await this.codeGraphService.semanticAlign(goal);
			const relevantFiles: string[] = [];
			const relatedSymbols: string[] = [];

			for (const fileUri of (alignment.relevantFiles || [])) {
				const path = fileUri.path || fileUri.toString();
				if (!relevantFiles.includes(path)) {
					relevantFiles.push(path);
				}
			}

			for (const node of [...(alignment.mentionedEntities || []), ...(alignment.relatedEntities || [])]) {
				if (node.name && !relatedSymbols.includes(node.name)) {
					relatedSymbols.push(node.name);
				}
				if (node.uri) {
					const path = node.uri.path || node.uri.toString();
					if (!relevantFiles.includes(path)) {
						relevantFiles.push(path);
					}
				}
			}

			return {
				relevantFiles: relevantFiles.slice(0, 20),
				relatedSymbols: relatedSymbols.slice(0, 30),
				constraints: relevantFiles.length > 0
					? [`影响面应限制在 ${relevantFiles.join(', ')} 范围内`]
					: [],
			};
		} catch (error) {
			this.logService.warn(`[Sentinel] CodeGraph analysis failed: ${error}`);
			return { relevantFiles: [], relatedSymbols: [], constraints: [] };
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	// Auto-Preview — 生成完成后尝试自动打开关键文件
	// ════════════════════════════════════════════════════════════════════════

	private async tryAutoPreview(intent: Intent): Promise<void> {
		try {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) { return; }
			const root = folders[0].uri;

			const entryFiles = ['index.html', 'src/index.html', 'public/index.html', 'src/App.tsx', 'src/App.vue', 'src/main.ts', 'src/main.tsx', 'app.py', 'main.py', 'index.js', 'src/index.js'];

			for (const entry of entryFiles) {
				try {
					const uri = URI.joinPath(root, entry);
					await this.fileService.stat(uri);
					await this.editorService.openEditor({ resource: uri });
					this.recordActivity('system', '自动打开入口文件', `已打开 ${entry}`, intent.id);
					break;
				} catch {
					continue;
				}
			}

			const packageJsonUri = URI.joinPath(root, 'package.json');
			try {
				const content = await this.fileService.readFile(packageJsonUri);
				const pkg = JSON.parse(content.value.toString());
				if (pkg.scripts?.dev || pkg.scripts?.start) {
					const cmd = pkg.scripts.dev ? 'npm run dev' : 'npm start';
					this.recordActivity('system', '提示运行命令',
						`检测到 package.json，可在终端执行 "${cmd}" 启动应用预览`, intent.id);
				}
			} catch {
				// no package.json, that's fine
			}

			const openPreview = this.configurationService.getValue<boolean>('aiCore.crossPlatform.openProjectPreviewAfterSentinelComplete');
			if (openPreview) {
				const previewUrl = (this.configurationService.getValue<string>('aiCore.projectPreview.url') || 'http://localhost:5173').trim();
				try {
					await this.commandService.executeCommand('aicore.openProjectPreview', { url: previewUrl });
					this.recordActivity('system', '项目预览', `已打开 AI Core 项目预览（${previewUrl}）`, intent.id);
				} catch (e) {
					this.logService.warn(`[Sentinel] openProjectPreview failed: ${e}`);
				}
			}
		} catch (err) {
			this.logService.warn(`[Sentinel] Auto-preview failed: ${err}`);
		}
	}

	// ════════════════════════════════════════════════════════════════════════
	// Requirement Analysis Parser
	// ════════════════════════════════════════════════════════════════════════

	private buildCapabilityAnchorTail(analysis: RequirementAnalysis): string {
		if (
			!analysis.userCapabilityPrimary &&
			!(analysis.capabilitySignals?.length) &&
			!analysis.outputLevelingStrategy &&
			!analysis.techStackContract?.trim() &&
			!analysis.scalabilityPlan?.trim()
		) {
			return '';
		}
		const lines = [
			'',
			'---',
			'【Sentinel · 用户能力锚点（系统自动生成，供 Planner/实现对齐）】',
		];
		if (analysis.userCapabilityPrimary) {
			lines.push(`- **判定主类**：${analysis.userCapabilityPrimary}${analysis.userCapabilityCode ? `（代码: ${analysis.userCapabilityCode}）` : ''}`);
		}
		if (analysis.capabilitySignals?.length) {
			lines.push('- **推断依据**：');
			for (const s of analysis.capabilitySignals.slice(0, 12)) {
				lines.push(`  - ${s}`);
			}
		}
		lines.push(
			'- **交付对齐目标**：无论上述判定如何，后续规划与实现须达到 **资深产品经理 + 资深架构师** 同档的完整度（验收标准、非功能、风险、数据与边界、可测性），不得因用户表述简略而压缩深度。',
		);
		if (analysis.outputLevelingStrategy?.trim()) {
			lines.push(`- **本需求的具体补足策略**：${analysis.outputLevelingStrategy.trim()}`);
		}
		if (analysis.techStackContract?.trim()) {
			lines.push(`- **技术栈契约（Analyst）**：${analysis.techStackContract.trim()}`);
		}
		if (analysis.scalabilityPlan?.trim()) {
			lines.push(`- **扩展性/规模预判**：${analysis.scalabilityPlan.trim()}`);
		}
		if (analysis.userStatedCore?.trim()) {
			lines.push(`- **用户原意（对齐）**：${analysis.userStatedCore.trim()}`);
		}
		if (analysis.systemInterpretation?.trim()) {
			lines.push(`- **系统理解（对齐）**：${analysis.systemInterpretation.trim()}`);
		}
		if (analysis.proposedAcceptanceCriteria?.length) {
			lines.push('- **验收锚点（须由验证门核对，禁止假完成）**：');
			for (const c of analysis.proposedAcceptanceCriteria) {
				lines.push(`  - ${c}`);
			}
		}
		if (analysis.projectDirectorSummary?.trim()) {
			const pds = analysis.projectDirectorSummary.trim();
			lines.push(`- **项目总监统筹（Analyst 虚拟）**：${pds.slice(0, 1200)}${pds.length > 1200 ? '…' : ''}`);
		}
		if (analysis.brainstormDirectors?.length) {
			lines.push(`- **头脑风暴总监角色数**：${analysis.brainstormDirectors.length}（建议≥10）`);
		}
		lines.push('---', '');
		return lines.join('\n');
	}

	/** 自 Planner 输出解析 `DEPENDENCY_WHITELIST:` 行，合并到 IntentCard.constraints */
	private parsePlannerDependencyWhitelist(plannerOutput: string): string[] {
		const out: string[] = [];
		const regex = /^\s*DEPENDENCY_WHITELIST:\s*(.+)$/gm;
		for (const m of plannerOutput.matchAll(regex)) {
			const v = m[1].trim();
			if (v && !/^\((无新增|none)\)$/i.test(v)) {
				out.push(v);
			}
		}
		return out;
	}

	private parseAnalysisOutput(intentId: string, originalGoal: string, output: string): RequirementAnalysis {
		const extractList = (prefix: string): string[] => {
			const regex = new RegExp(`${prefix}:\\s*(.+)`, 'gm');
			const matches = [...output.matchAll(regex)];
			return matches.map(m => m[1].trim()).filter(Boolean);
		};

		const ambiguities = extractList('AMBIGUITY');
		const assumptions = extractList('ASSUMPTION');
		const questions = extractList('QUESTION');
		const suggestedFeatures = extractList('SUGGEST');
		const suggestedChildGoals = extractList('SPLIT_INTENT');
		const capabilitySignals = extractList('CAP_SIGNAL');
		const featureMatrixItems = extractList('FEATURE_MATRIX');

		let expertPanelSummary: string | undefined;
		const panelBlock = output.match(/##\s*专家组联合研判[^\n]*\n([\s\S]*?)(?=\n##\s+)/);
		if (panelBlock?.[1]) {
			expertPanelSummary = panelBlock[1].trim() || undefined;
		}

		let webResearchSummary: string | undefined;
		const webBlock = output.match(/##\s*联网检索与对标[^\n]*\n([\s\S]*?)(?=\n##\s+)/);
		if (webBlock?.[1]) {
			webResearchSummary = webBlock[1].trim() || undefined;
		}
		const webFacts = extractList('WEB_FACT');
		if (!webResearchSummary?.length && webFacts.length > 0) {
			webResearchSummary = webFacts.map(f => `• ${f}`).join('\n');
		}

		const capPrimaryM = output.match(/^\s*CAP_PRIMARY:\s*(.+)$/m);
		const userCapabilityPrimary = capPrimaryM?.[1]?.trim();
		const capCodeM = output.match(/^\s*CAP_CODE:\s*(\S+)/m);
		const userCapabilityCode = capCodeM?.[1]?.trim();
		const capLevelM = output.match(/^\s*CAP_LEVELING:\s*(.+)$/m);
		const outputLevelingStrategy = capLevelM?.[1]?.trim();

		const techStackMatch = output.match(/技术栈[：:]\s*(.+)/);
		const techStack = techStackMatch
			? techStackMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean)
			: [];

		const complexityMatch = output.match(/COMPLEXITY:\s*(simple|medium|complex)/i);
		const estimatedComplexity = (complexityMatch?.[1]?.toLowerCase() || 'medium') as 'simple' | 'medium' | 'complex';

		const techStackContractM = output.match(/^\s*TECH_STACK_CONTRACT:\s*(.+)$/m);
		const techStackContract = techStackContractM?.[1]?.trim();
		const scalabilityPlanM = output.match(/^\s*SCALABILITY_PLAN:\s*(.+)$/m);
		const scalabilityPlan = scalabilityPlanM?.[1]?.trim();

		const userStatedCoreM = output.match(/^\s*USER_STATED_CORE:\s*(.+)$/m);
		const userStatedCore = userStatedCoreM?.[1]?.trim();
		const systemInterpM = output.match(/^\s*SYSTEM_INTERPRETATION:\s*(.+)$/m);
		const systemInterpretation = systemInterpM?.[1]?.trim();
		const alignmentRisksRaw = extractList('ALIGNMENT_RISK');
		const alignmentRisks = alignmentRisksRaw.filter(r => r && !/^\(none\)$/i.test(r));
		const proposedAcceptanceCriteria = extractList('ACCEPTANCE_CRITERION').filter(Boolean);

		const brainstormDirectors = extractList('BRAINSTORM_DIRECTOR').filter(Boolean);

		let brainstormSynthesis: string | undefined;
		const bsBlock = output.match(/##\s*头脑风暴整合纪要[^\n]*\n([\s\S]*?)(?=\n##\s+)/);
		if (bsBlock?.[1]) {
			brainstormSynthesis = bsBlock[1].trim() || undefined;
		}

		let projectDirectorSummary: string | undefined;
		const pdBlock = output.match(/##\s*项目总监统筹结论[^\n]*\n([\s\S]*?)(?=\n##\s+)/);
		if (pdBlock?.[1]) {
			projectDirectorSummary = pdBlock[1].trim() || undefined;
		}

		let detailedPrdBody: string | undefined;
		const prdBlock = output.match(/##\s*详尽需求说明文档（PRD 草案）[^\n]*\n([\s\S]*?)(?=\n##\s*用户能力层级锚点)/);
		if (prdBlock?.[1]) {
			detailedPrdBody = prdBlock[1].trim() || undefined;
		}

		const specSection = output.match(/## 需求理解\s*\n([\s\S]*?)(?=\n## |$)/);
		const specShort = specSection ? specSection[1].trim() : '';
		const fullSpecParts: string[] = [];
		if (detailedPrdBody) {
			fullSpecParts.push(detailedPrdBody);
		}
		if (specShort) {
			fullSpecParts.push('【需求理解摘要】\n' + specShort);
		}
		const fullSpec = fullSpecParts.length > 0 ? fullSpecParts.join('\n\n---\n\n') : output.slice(0, 2000);

		return {
			intentId,
			originalGoal,
			fullSpec,
			ambiguities,
			assumptions,
			suggestedFeatures,
			techStack,
			estimatedComplexity,
			questions,
			confirmed: false,
			userCapabilityPrimary: userCapabilityPrimary || undefined,
			userCapabilityCode: userCapabilityCode || undefined,
			capabilitySignals: capabilitySignals.length > 0 ? capabilitySignals : undefined,
			outputLevelingStrategy: outputLevelingStrategy || undefined,
			suggestedChildGoals: suggestedChildGoals.length > 0 ? suggestedChildGoals : undefined,
			expertPanelSummary,
			webResearchSummary,
			featureMatrixItems: featureMatrixItems.length > 0 ? featureMatrixItems : undefined,
			techStackContract: techStackContract || undefined,
			scalabilityPlan: scalabilityPlan || undefined,
			userStatedCore: userStatedCore || undefined,
			systemInterpretation: systemInterpretation || undefined,
			alignmentRisks: alignmentRisks.length > 0 ? alignmentRisks : undefined,
			proposedAcceptanceCriteria: proposedAcceptanceCriteria.length > 0 ? proposedAcceptanceCriteria : undefined,
			brainstormDirectors: brainstormDirectors.length > 0 ? brainstormDirectors : undefined,
			brainstormSynthesis,
			projectDirectorSummary,
			detailedPrdBody,
			requirementUnderstandingShort: specShort || undefined,
		};
	}

	// ════════════════════════════════════════════════════════════════════════
	// Worker Output Chain — 前一 Worker 输出注入后一 Worker 上下文
	// ════════════════════════════════════════════════════════════════════════

	private getWorkerOutputChain(intentId: string): Map<string, string> {
		return this.workerOutputChain.get(intentId) || new Map();
	}

	private addToWorkerOutputChain(intentId: string, role: string, output: string): void {
		let chain = this.workerOutputChain.get(intentId);
		if (!chain) {
			chain = new Map();
			this.workerOutputChain.set(intentId, chain);
		}
		chain.set(role, output);
	}

	// ════════════════════════════════════════════════════════════════════════
	// Persistence
	// ════════════════════════════════════════════════════════════════════════

	private persistState(): void {
		try {
			const snap = this.getSnapshot();
			void this.persistenceService.saveState(snap);
			void this.persistenceService.saveIntentGraph(this.intentGraphService.getGraph());
			void this.persistenceService.saveExecutionGraphs(this.executionGraphService.listGraphs());
			void this.persistenceService.saveWorkerRuns(snap.workerRuns);
			void this.persistenceService.saveCostLedger(snap.costLedger);
			for (const intent of this.intentGraphService.listIntents()) {
				const traces = this.reasoningTraceService.getTraces(intent.id);
				if (traces.length > 0) {
					void this.persistenceService.saveReasoningTraces(intent.id, traces);
				}
			}
		} catch (error) {
			this.logService.warn(`[Sentinel] Persistence failed: ${error}`);
		}
	}

	async restorePersistedState(state: SentinelPersistedWorkspaceState): Promise<void> {
		const snap = state.snapshot;
		if (!snap) {
			return;
		}

		let intentGraph = state.intentGraph;
		if (!intentGraph?.intents?.length && snap.intents?.length) {
			intentGraph = intentSummariesToGraph(snap.intents);
		}
		if (intentGraph?.intents?.length) {
			this.intentGraphService.hydrate(intentGraph);
		}

		const graphs =
			state.executionGraphs?.length ? state.executionGraphs : (snap.executionGraphs ?? []);
		this.executionGraphService.hydrate(graphs);

		const runs = state.workerRuns?.length ? state.workerRuns : (snap.workerRuns ?? []);
		this.workerRuntimeService.hydrateRuns(runs);

		const ledger = state.costLedger?.records?.length || state.costLedger?.totalTokens || state.costLedger?.totalCost
			? state.costLedger
			: (snap.costLedger ?? state.costLedger);
		this.routingService.hydrateCostLedger(ledger ?? { totalCost: 0, totalTokens: 0, records: [] });

		this.reasoningTraceService.hydrateTraces(state.reasoningTraces);

		this.verificationGateService.hydrateBundles(snap.verificationBundles ?? []);

		if (snap.artifacts?.length) {
			this.projectionService.hydrateArtifacts(snap.artifacts);
		} else {
			this.projectionService.hydrateArtifacts([]);
		}

		this.setPhase(snap.phase);
		this.pendingAnalysis = snap.pendingAnalysis;
		this.harnessRuntimeSnapshot = { ...(snap.harnessRuntime || {}) };

		this.activities.length = 0;
		if (snap.activities?.length) {
			this.activities.push(...snap.activities.map(a => ({ ...a })));
		}

		this.activeIntentIdOverride = snap.activeIntentId;

		this.logService.info('[Sentinel] Session restored from workspace .sentinel');
		this.emitSnapshot();
	}

	forcePersistState(): void {
		this.persistState();
	}

	// ════════════════════════════════════════════════════════════════════════
	// Internal
	// ════════════════════════════════════════════════════════════════════════

	private setPhase(phase: SentinelPhase): void {
		this.phase = phase;
		this._onDidUpdatePhase.fire(phase);
	}

	private emitSnapshot(): void {
		this._onDidUpdateSnapshot.fire(this.getSnapshot());
	}

	private recordActivity(
		kind: 'intent' | 'execution' | 'verification' | 'projection' | 'system',
		title: string,
		description: string,
		intentId?: string,
		nodeId?: string,
		severity?: ActivitySeverity,
	): void {
		this.activities.push({
			id: `activity_${Date.now()}_${this.activities.length}`,
			kind,
			title,
			description,
			intentId,
			nodeId,
			createdAt: Date.now(),
			severity,
		});
		this.logService.info(`[Sentinel] ${title}: ${description}`);
	}
}

registerSingleton(ISentinelKernelService, SentinelKernelService, InstantiationType.Delayed);
