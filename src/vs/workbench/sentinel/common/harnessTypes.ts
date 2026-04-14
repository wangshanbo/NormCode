/*---------------------------------------------------------------------------------------------
 *  Sentinel Harness — 协议与沙箱类型
 *--------------------------------------------------------------------------------------------*/

import type { SentinelPhase } from './sentinelTypes.js';

/** 工作区 .sentinel/harness.json（M1–M4 全量配置） */
export interface HarnessWorkspaceConfig {
	enabled?: boolean;
	stagingWrites?: boolean;
	negotiationRequired?: boolean;
	adrGate?: boolean;
	strictVerification?: boolean;
	/**
	 * M1：`enabled` 时若未显式写本字段，解析默认为 true。
	 * 需求分析结束后由 **内核** 直接 `confirmAndExecute`→`planIntent`→`runAll`，无需用户点击「确认」。
	 */
	autoRun?: boolean;
	/** M1：`enabled` 时默认 true；自动确认时不收集人工对 Analyst 问卷的回答（仍可通过 ADR 等闸门暂停） */
	skipUserConfirmation?: boolean;
	/** M1：实现节点验证通过后，将 Shadow 合并到真实工作区 */
	promoteAfterVerified?: boolean;
	/** M2：每节点仅注入最小 CSO（诊断 + 元数据，默认不全量贴文件） */
	statelessExecution?: boolean;
	/** M2：Reviewer 不看 Implementer 全文，仅 diff/路径/诊断摘要 */
	reviewerIsolation?: boolean;
	/** M2：Implementation Plan 硬闸门（未通过不准写实现代码） */
	implementationPlanRequired?: boolean;
	/** M3：允许的 MCP server id 列表文件，缺省则读 .sentinel/mcp_allowlist.json */
	mcpAllowlistFile?: string;
	/** M4：Promote 成功后写入 git 元数据并尝试记录快照（需 Git 仓库） */
	gitSnapshots?: boolean;
	/** M4：验证失败时自动调用节点 checkpoint 回滚 */
	autoRollbackOnVerifyFailure?: boolean;
	/** M5：除 LSP 外，读取 package.json scripts 并作为验证提示（L2） */
	verifyPackageScripts?: boolean;
	/** M5：若存在 scripts.lint / scripts.test，将其名称写入验证摘要（不保证能无头执行） */
	hintNpmScripts?: boolean;
	/** M6：在快照中附带导出路径提示 */
	exportBundleOnComplete?: boolean;
	/** P5：verify 节点前后行为快照 + 指纹对比（全量 E2E） */
	behavioralE2E?: boolean;

	/**
	 * 物化时若磁盘上已有 package.json，则与模型输出做依赖字段合并（dependencies / devDependencies / scripts 等），
	 * 避免多节点流水线后序步骤整文件覆盖导致依赖丢失。默认 true。
	 */
	materializeMergePackageJson?: boolean;
	/**
	 * 若 src/App.tsx、src/main.tsx、index.html 已存在，则跳过后序节点对这些文件的整文件覆盖（仍会写入新文件）。
	 * 防止「右键菜单」等尾部节点把整套应用入口替换成演示页。默认 true；需强制替换时可设 false。
	 */
	materializeSkipExistingEntryFiles?: boolean;
	/**
	 * 对 type 为 implement / project 的节点，在验证包构建时无头执行 `npm run build`（若 package.json 存在 scripts.build）。
	 * 失败则产生 blocking 项，节点标记 blocked。`harness.enabled` 时默认 true；纯文档/无构建工程可设 false。
	 */
	verifyNpmBuildAfterImplement?: boolean;

	// --- Anthropic Harness Engineering 对齐（见 docs/sentinel/anthropic-harness-alignment.md） ---
	/**
	 * 启用后：注入 Planner/Generator/Evaluator 范式附言，并维护 feature 注册表与进度日志。
	 * 与 `enabled: true` 同时开启且未显式写对应字段时，默认还会打开：
	 * `implementerAgentToolLoop`、`verifierAgentToolLoop`、`hintNpmScripts`、`verifyPackageScripts`、`behavioralE2E`。
	 * （`autoRun` / `skipUserConfirmation` 在任意 `enabled` 下即默认 true，不仅限于 parity。）
	 */
	anthropicHarnessParity?: boolean;
	/** 功能注册表（JSON），默认 .sentinel/feature_registry.json */
	featureRegistryPath?: string;
	/** 进度交接日志，默认 .sentinel/sentinel_progress.txt */
	progressLogPath?: string;
	/** 建议的启动脚本路径（提示用），默认 init.sh */
	initScriptHintPath?: string;
	/** Implementer 使用 GLM 函数调用 + AgentToolService 多轮工具循环（Anthropic Agent 范式） */
	implementerAgentToolLoop?: boolean;
	/** Verifier 使用工具循环（含 mcp_call 浏览器 E2E 等）；默认随 anthropicHarnessParity 开启 */
	verifierAgentToolLoop?: boolean;
	/** 工具循环最大轮次（每轮 = 一次模型 + 一批 tool） */
	agentToolMaxIterations?: number;
	/** 每轮模型 max_tokens */
	agentToolMaxTokensPerTurn?: number;

	/** Worker 失败或验证阻塞时，在节点内自动多轮「修复 Agent」（工具 + 联网检索） */
	autoRepairOnFailure?: boolean;
	/** 每个节点最多自动修复轮次（每轮含一次修复 Agent + 必要时重跑 Worker + 重建验证） */
	autoRepairMaxRounds?: number;
	/** 单轮修复 Agent 的工具循环上限（默认同 agentToolMaxIterations） */
	agentRepairMaxIterations?: number;

	/**
	 * 在「最后一轮实现」之后插入 **设计对撞**：Reviewer（产品/视觉/外链清单）→ Implementer（收敛修复）。
	 * `enabled` + `anthropicHarnessParity` 时默认 true；可设 `false` 关闭以缩短链路。
	 */
	designCollisionPass?: boolean;

	/** P1 HGT-010：软 Token 总预算（累计 `routingService` 账本）；0 或未设置表示不告警 */
	softTokenBudgetTotal?: number;
	/**
	 * HGT-010：超预算时路由降级（power→balanced→fast）。未设置且 `softTokenBudgetTotal>0` 时默认 **true**。
	 */
	softTokenBudgetDegradeModels?: boolean;
	/**
	 * HGT-010：超预算时 **阻止新节点执行**（executeNode 直接失败）。默认 false，仅告警。
	 */
	softTokenBudgetBlockNewNodes?: boolean;
	/** P1 HGT-014：节点成功后在 `.sentinel/suggested_git_commits.log` 追加一行建议提交信息（不执行 git） */
	suggestGitCommitAfterNode?: boolean;

	/** HGT-005：任务级隔离；`worktree` 时物化/工具应优先使用 `.sentinel/worktrees/<intentId>`（需先运行脚本创建） */
	taskIsolation?: 'none' | 'worktree';
	/**
	 * 为 true 时：需求分析完成后 **不** 自动 confirm→plan→runAll（即使 autoRun 为 true），强制进入待确认。
	 * 对应意识形态：**何时不自动**。
	 */
	humanGateAfterAnalysis?: boolean;
	/**
	 * 为 true 且 Analyst 输出 `SPLIT_INTENT:` 行时：自动为每条创建子 Intent（最多 5），**不**自动跑父 Intent 全链路。
	 * HGT-020 最小落地。
	 */
	splitLargeGoalsAutoCreate?: boolean;
	/** HGT-026：固定评分 rubric 文件路径（占位；Evaluator 提示可引用） */
	evaluatorRubricPath?: string;
	/**
	 * HGT-026：在 **verify** 节点验证包构建后，运行 Playwright（`evaluatorPlaywrightDir` 下须存在 playwright.config.*），
	 * 并可选用 **独立** 轻量模型对「报告 + rubric」打分（与 Implementer 路由分离）。
	 */
	evaluatorPipelineEnabled?: boolean;
	/** 相对工作区根，默认 `.sentinel/playwright` */
	evaluatorPlaywrightDir?: string;
	/** Playwright 失败时是否将验证包标为 blocked（默认 true，当 evaluatorPipelineEnabled 时建议保持） */
	evaluatorPlaywrightBlocksVerify?: boolean;
	/** 是否在 Playwright 之后调用独立轻量模型对照 rubric（默认 true） */
	evaluatorIndependentLlmEnabled?: boolean;
	/** 独立 LLM 输出 pass:false 时是否阻塞（默认 false，避免模型误判误杀） */
	evaluatorLlmBlocksOnNegative?: boolean;
	/**
	 * HGT-014：在隔离 worktree 存在时，向 `.sentinel/pending_git_commands.jsonl` 追加待执行 git 行（仍不直接 exec；可由 scripts/sentinel-git-commit.mjs 消费）
	 */
	gitCommitAfterNode?: boolean;
	/**
	 * `runAllNodes` 遇到验证阻塞节点时：重试耗尽后是否仍标为「已完成」并继续后续节点。
	 * 默认 **false**（中止自动执行、保留 blocked，避免假完成）；设为 **true** 恢复旧行为（自动跳过阻塞节点）。
	 */
	autoSkipBlockedNodesOnRunAll?: boolean;
	/**
	 * `harness.enabled` 时：验证包 `overallStatus === 'warning'` 仍将节点标为 **blocked**（默认 false，此时 warning 仅 advisory，节点可 completed）。
	 */
	verificationWarningBlocksCompletion?: boolean;
	/**
	 * `harness.enabled` 时：漂移 `drift.status !== 'pass'`（含 warning/blocked）将节点标为 **blocked**。默认 false。
	 */
	driftNonPassBlocksCompletion?: boolean;
	/**
	 * `harness.enabled` 时：默认执行图（Planner 未产出动态图或解析失败）及动态图是否在实现链末追加 **验证** 节点，避免「实现即收尾」与目标漂移。默认 true；`harness.enabled` 为 false 时不生效。
	 */
	defaultExecutionGraphIncludeVerify?: boolean;
}

/** ADR 记录（与 adr.schema.json 对齐的最小可执行子集） */
export interface AdrRecord {
	logic_path: string;
	dependency_whitelist_check: string;
	potential_risks: string;
	rollback_plan: string;
}

/** Implementation Plan（P4-4） */
export interface ImplementationPlanRecord {
	title: string;
	steps: string[];
	acceptance_criteria: string[];
	non_goals: string[];
	risks: string[];
}

export interface NegotiationResult {
	ok: boolean;
	score: number;
	iterations: number;
	adr?: AdrRecord;
	lastErrors: string[];
}

export interface PlanNegotiationResult {
	ok: boolean;
	score: number;
	plan?: ImplementationPlanRecord;
	lastErrors: string[];
}

/** .sentinel/task_state.json */
export interface SentinelTaskStateFile {
	version: 1;
	intentId: string;
	updatedAt: number;
	completedNodeIds: string[];
	pendingVariables: Record<string, string>;
	vfsPointer: string;
	phase: SentinelPhase;
}

export interface BehavioralHarnessScript {
	version: 1;
	intentId: string;
	/** 相对工作区路径子串：post 相对 pre 若这些路径下文件指纹变化则记为失败 */
	assertions: string[];
	preSnapshotRef?: string;
	postSnapshotRef?: string;
}

/** P5 行为快照（文件内容 SHA-1 指纹） */
export interface BehavioralFileFingerprint {
	relativePath: string;
	sha1: string;
	size: number;
}

export interface BehavioralSnapshot {
	version: 1;
	intentId: string;
	phase: 'pre' | 'post';
	capturedAt: number;
	files: BehavioralFileFingerprint[];
}

export interface BehavioralCompareResult {
	ok: boolean;
	changedPaths: string[];
	failures: string[];
	preRef: string;
	postRef: string;
}
