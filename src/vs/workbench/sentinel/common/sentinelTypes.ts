/*---------------------------------------------------------------------------------------------
 *  Sentinel Product Types
 *--------------------------------------------------------------------------------------------*/

import { ExecutionGraph } from './executionTypes.js';
import { IntentGraph, IntentSummary } from './intentTypes.js';
import { ProjectionArtifact } from './projectionTypes.js';
import { VerificationBundle } from './verificationTypes.js';
import { CostLedger, WorkerRun } from './workerTypes.js';

export type SentinelPhase =
	| 'idle'
	| 'intent_workspace'
	| 'analyzing'
	| 'awaiting_confirmation'
	| 'planning'
	| 'negotiation'
	| 'execution'
	| 'verification'
	| 'projection'
	| 'blocked';

export interface ReasoningTrace {
	id: string;
	intentId: string;
	nodeId?: string;
	phase: SentinelPhase;
	summary: string;
	evidence: string[];
	optionsConsidered: string[];
	decision: string;
	expectedImpact?: string;
	validatorHints?: string[];
	createdAt: number;
}

export type ActivitySeverity = 'neutral' | 'success' | 'warning' | 'failure';

export interface ActivityEntry {
	id: string;
	kind: 'intent' | 'execution' | 'verification' | 'projection' | 'system';
	title: string;
	description: string;
	intentId?: string;
	nodeId?: string;
	createdAt: number;
	/** 失败与成功同权：时间线可按严重度区分样式 */
	severity?: ActivitySeverity;
}

export interface PromptIngestionRequest {
	message: string;
	source: 'sentinel_ui' | 'aicore' | 'command';
	sessionId?: string;
}

export interface RequirementAnalysis {
	intentId: string;
	originalGoal: string;
	fullSpec: string;
	ambiguities: string[];
	assumptions: string[];
	suggestedFeatures: string[];
	techStack: string[];
	estimatedComplexity: 'simple' | 'medium' | 'complex';
	questions: string[];
	confirmed: boolean;
	/**
	 * 第一步深度分析：根据用户表述推断的能力主标签（如「普通用户」「资深架构师」等），
	 * 用于日志与 UI；下游交付标准不因该标签降低。
	 */
	userCapabilityPrimary?: string;
	/** 稳定分类码，便于统计 */
	userCapabilityCode?: string;
	/** 从原文推断用户能力边界的依据（短句列表） */
	capabilitySignals?: string[];
	/** 如何将产出对齐到「资深产品经理 + 资深架构师」深度 */
	outputLevelingStrategy?: string;
	/** HGT-020：Analyst 输出 `SPLIT_INTENT:` 行解析结果，供可选自动建子意图 */
	suggestedChildGoals?: string[];
	/** Analyst 在「专家组联合研判」小节中的全文（资深产品专家组队视角 + 检索策略） */
	expertPanelSummary?: string;
	/** Analyst 在「联网检索与对标」小节中的摘要（含 WEB_FACT 行已并入此文本亦可） */
	webResearchSummary?: string;
	/** 自 `FEATURE_MATRIX:` 行解析的详尽功能点（模块级） */
	featureMatrixItems?: string[];
	/** Analyst 输出的 `TECH_STACK_CONTRACT:` 一行摘要（与「技术方案」对齐的强制栈约束） */
	techStackContract?: string;
	/** Analyst 输出的 `SCALABILITY_PLAN:` 扩展性/规模预判（如十万用户级瓶颈与缓解） */
	scalabilityPlan?: string;

	/** `USER_STATED_CORE:` 一行：用户原话中最核心的诉求（含关键词引用） */
	userStatedCore?: string;
	/** `SYSTEM_INTERPRETATION:` 系统对交付范围的理解 */
	systemInterpretation?: string;
	/** `ALIGNMENT_RISK:` 逐条：原意与系统理解可能不一致之处；无风险时模型可输出 `(none)` */
	alignmentRisks?: string[];
	/** `ACCEPTANCE_CRITERION:` 逐条：可手动验证的完成定义，将合并入 IntentCard.successCriteria 与验证门 */
	proposedAcceptanceCriteria?: string[];

	/** `BRAINSTORM_DIRECTOR:` 行解析：至少 10 名资深产品总监级虚拟角色头脑风暴 */
	brainstormDirectors?: string[];
	/** `## 头脑风暴整合纪要` 全文 */
	brainstormSynthesis?: string;
	/** `## 项目总监统筹结论`：虚拟项目总监（分析阶段内统筹，非独立 Worker）收敛分歧与范围 */
	projectDirectorSummary?: string;
	/** `## 详尽需求说明文档（PRD 草案）` 正文（可与 fullSpec 合并展示） */
	detailedPrdBody?: string;
	/** `## 需求理解` 短摘要（与 PRD 拆开展示用） */
	requirementUnderstandingShort?: string;
}

export interface SentinelHarnessRuntimeSnapshot {
	/** 各意图最近一次物化相对路径（合并去重展示用） */
	materializedFilesByIntent?: Record<string, string[]>;
	/** 上一节点端到端耗时（executeNode） */
	lastNodeExecutionMs?: number;
	lastExecutedNodeTitle?: string;
	lastExecutedIntentId?: string;
	/** 最近一次物化写入根：主仓 / worktree / 影子 VFS */
	lastMaterializeRoot?: 'workspace' | 'worktree' | 'staging';
	/** 最近一次 Promote 时间与复制文件数 */
	lastPromote?: { at: number; fileCount: number };
	/** MCP 白名单 server 数量（来自 .sentinel/mcp_allowlist.json） */
	mcpAllowlistCount?: number;
	/** MCP 桥接：是否写入 .vscode/mcp.json */
	mcpBridgeWroteJson?: boolean;
	/** MCP 桥接：是否提升工作区 chat.mcp.access（衔接 Chat 宿主） */
	mcpBridgeChatAccess?: boolean;
	/** MCP 桥接说明 */
	mcpBridgeDetail?: string;
	/** 最近一次导出 bundle 的 URI 字符串 */
	lastExportUri?: string;
}

export interface SentinelProductSnapshot {
	phase: SentinelPhase;
	activeIntentId?: string;
	pendingAnalysis?: RequirementAnalysis;
	intents: IntentSummary[];
	executionGraphs: ExecutionGraph[];
	verificationBundles: VerificationBundle[];
	workerRuns: WorkerRun[];
	artifacts: ProjectionArtifact[];
	activities: ActivityEntry[];
	costLedger: CostLedger;
	lastUpdated: number;
	/** M6：Harness 运行时摘要（控制平面可展示） */
	harnessRuntime?: SentinelHarnessRuntimeSnapshot;
}

/** 工作区 `.sentinel` 恢复载荷（与 persistenceService.loadState 一致） */
export interface SentinelPersistedWorkspaceState {
	intentGraph?: IntentGraph;
	executionGraphs: ExecutionGraph[];
	reasoningTraces: Record<string, ReasoningTrace[]>;
	workerRuns: WorkerRun[];
	costLedger: CostLedger;
	snapshot?: SentinelProductSnapshot;
	persistedAt: number;
}
