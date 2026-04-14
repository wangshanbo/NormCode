/*---------------------------------------------------------------------------------------------
 *  Sentinel Harness — 工作区配置（.sentinel/harness.json）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { HarnessWorkspaceConfig } from '../common/harnessTypes.js';

export const IHarnessConfigService = createDecorator<IHarnessConfigService>('IHarnessConfigService');

export interface ResolvedHarnessConfig {
	enabled: boolean;
	stagingWrites: boolean;
	negotiationRequired: boolean;
	adrGate: boolean;
	strictVerification: boolean;
	autoRun: boolean;
	skipUserConfirmation: boolean;
	promoteAfterVerified: boolean;
	statelessExecution: boolean;
	reviewerIsolation: boolean;
	implementationPlanRequired: boolean;
	mcpAllowlistFile: string;
	gitSnapshots: boolean;
	autoRollbackOnVerifyFailure: boolean;
	verifyPackageScripts: boolean;
	hintNpmScripts: boolean;
	behavioralE2E: boolean;
	exportBundleOnComplete: boolean;
	anthropicHarnessParity: boolean;
	featureRegistryPath: string;
	progressLogPath: string;
	initScriptHintPath: string;
	implementerAgentToolLoop: boolean;
	verifierAgentToolLoop: boolean;
	agentToolMaxIterations: number;
	agentToolMaxTokensPerTurn: number;
	autoRepairOnFailure: boolean;
	autoRepairMaxRounds: number;
	agentRepairMaxIterations: number;
	designCollisionPass: boolean;
	materializeMergePackageJson: boolean;
	materializeSkipExistingEntryFiles: boolean;
	verifyNpmBuildAfterImplement: boolean;
	/** 0 = 关闭软预算告警 */
	softTokenBudgetTotal: number;
	softTokenBudgetDegradeModels: boolean;
	softTokenBudgetBlockNewNodes: boolean;
	suggestGitCommitAfterNode: boolean;
	taskIsolation: 'none' | 'worktree';
	humanGateAfterAnalysis: boolean;
	splitLargeGoalsAutoCreate: boolean;
	evaluatorRubricPath: string;
	evaluatorPipelineEnabled: boolean;
	evaluatorPlaywrightDir: string;
	evaluatorPlaywrightBlocksVerify: boolean;
	evaluatorIndependentLlmEnabled: boolean;
	evaluatorLlmBlocksOnNegative: boolean;
	gitCommitAfterNode: boolean;
	autoSkipBlockedNodesOnRunAll: boolean;
	verificationWarningBlocksCompletion: boolean;
	driftNonPassBlocksCompletion: boolean;
	defaultExecutionGraphIncludeVerify: boolean;
}

const DEFAULTS: ResolvedHarnessConfig = {
	enabled: false,
	stagingWrites: false,
	negotiationRequired: false,
	adrGate: false,
	strictVerification: false,
	autoRun: false,
	skipUserConfirmation: false,
	promoteAfterVerified: false,
	statelessExecution: false,
	reviewerIsolation: false,
	implementationPlanRequired: false,
	mcpAllowlistFile: '.sentinel/mcp_allowlist.json',
	gitSnapshots: false,
	autoRollbackOnVerifyFailure: false,
	verifyPackageScripts: false,
	hintNpmScripts: false,
	behavioralE2E: false,
	exportBundleOnComplete: false,
	anthropicHarnessParity: false,
	featureRegistryPath: '.sentinel/feature_registry.json',
	progressLogPath: '.sentinel/sentinel_progress.txt',
	initScriptHintPath: 'init.sh',
	implementerAgentToolLoop: false,
	verifierAgentToolLoop: false,
	agentToolMaxIterations: 24,
	agentToolMaxTokensPerTurn: 16384,
	autoRepairOnFailure: false,
	autoRepairMaxRounds: 2,
	agentRepairMaxIterations: 24,
	designCollisionPass: false,
	materializeMergePackageJson: true,
	materializeSkipExistingEntryFiles: true,
	verifyNpmBuildAfterImplement: false,
	softTokenBudgetTotal: 0,
	softTokenBudgetDegradeModels: false,
	softTokenBudgetBlockNewNodes: false,
	suggestGitCommitAfterNode: false,
	taskIsolation: 'none',
	humanGateAfterAnalysis: false,
	splitLargeGoalsAutoCreate: false,
	evaluatorRubricPath: '.sentinel/evaluator_rubric.md',
	evaluatorPipelineEnabled: false,
	evaluatorPlaywrightDir: '.sentinel/playwright',
	evaluatorPlaywrightBlocksVerify: true,
	evaluatorIndependentLlmEnabled: true,
	evaluatorLlmBlocksOnNegative: false,
	gitCommitAfterNode: false,
	autoSkipBlockedNodesOnRunAll: false,
	verificationWarningBlocksCompletion: false,
	driftNonPassBlocksCompletion: false,
	defaultExecutionGraphIncludeVerify: false,
};

export interface IHarnessConfigService {
	readonly _serviceBrand: undefined;
	getResolved(): Promise<ResolvedHarnessConfig>;
}

export class HarnessConfigService extends Disposable implements IHarnessConfigService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async getResolved(): Promise<ResolvedHarnessConfig> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return { ...DEFAULTS };
		}
		const uri = URI.joinPath(root, '.sentinel', 'harness.json');
		try {
			const file = await this.fileService.readFile(uri);
			const raw = JSON.parse(file.value.toString()) as HarnessWorkspaceConfig;
			const anthropicParity = raw.anthropicHarnessParity ?? DEFAULTS.anthropicHarnessParity;
			const enabled = raw.enabled ?? DEFAULTS.enabled;
			/** Parity 打开时默认强化验证与工具环；与 enabled 独立 */
			const anthropicAutoChain = enabled && anthropicParity;
			const resolved: ResolvedHarnessConfig = {
				enabled,
				stagingWrites: raw.stagingWrites ?? DEFAULTS.stagingWrites,
				negotiationRequired: raw.negotiationRequired ?? DEFAULTS.negotiationRequired,
				adrGate: raw.adrGate ?? DEFAULTS.adrGate,
				strictVerification: raw.strictVerification ?? DEFAULTS.strictVerification,
				/** 只要启用 harness 且未显式写 false，默认自动跑全链路（无需用户理解「确认」） */
				autoRun: raw.autoRun !== undefined ? raw.autoRun : (enabled ? true : DEFAULTS.autoRun),
				skipUserConfirmation: raw.skipUserConfirmation !== undefined ? raw.skipUserConfirmation : (enabled ? true : DEFAULTS.skipUserConfirmation),
				promoteAfterVerified: raw.promoteAfterVerified ?? DEFAULTS.promoteAfterVerified,
				statelessExecution: raw.statelessExecution ?? DEFAULTS.statelessExecution,
				reviewerIsolation: raw.reviewerIsolation ?? DEFAULTS.reviewerIsolation,
				implementationPlanRequired: raw.implementationPlanRequired ?? DEFAULTS.implementationPlanRequired,
				mcpAllowlistFile: raw.mcpAllowlistFile ?? DEFAULTS.mcpAllowlistFile,
				gitSnapshots: raw.gitSnapshots ?? DEFAULTS.gitSnapshots,
				autoRollbackOnVerifyFailure: raw.autoRollbackOnVerifyFailure ?? DEFAULTS.autoRollbackOnVerifyFailure,
				verifyPackageScripts: raw.verifyPackageScripts !== undefined ? raw.verifyPackageScripts : (anthropicAutoChain ? true : DEFAULTS.verifyPackageScripts),
				hintNpmScripts: raw.hintNpmScripts !== undefined ? raw.hintNpmScripts : (anthropicAutoChain ? true : DEFAULTS.hintNpmScripts),
				behavioralE2E: raw.behavioralE2E !== undefined ? raw.behavioralE2E : (anthropicAutoChain ? true : DEFAULTS.behavioralE2E),
				exportBundleOnComplete: raw.exportBundleOnComplete ?? DEFAULTS.exportBundleOnComplete,
				anthropicHarnessParity: anthropicParity,
				featureRegistryPath: raw.featureRegistryPath ?? DEFAULTS.featureRegistryPath,
				progressLogPath: raw.progressLogPath ?? DEFAULTS.progressLogPath,
				initScriptHintPath: raw.initScriptHintPath ?? DEFAULTS.initScriptHintPath,
				implementerAgentToolLoop: raw.implementerAgentToolLoop ?? (anthropicParity ? true : DEFAULTS.implementerAgentToolLoop),
				verifierAgentToolLoop: raw.verifierAgentToolLoop ?? (anthropicParity ? true : DEFAULTS.verifierAgentToolLoop),
				agentToolMaxIterations: raw.agentToolMaxIterations ?? DEFAULTS.agentToolMaxIterations,
				agentToolMaxTokensPerTurn: raw.agentToolMaxTokensPerTurn ?? DEFAULTS.agentToolMaxTokensPerTurn,
				autoRepairOnFailure: raw.autoRepairOnFailure !== undefined ? raw.autoRepairOnFailure : (enabled ? true : DEFAULTS.autoRepairOnFailure),
				autoRepairMaxRounds: raw.autoRepairMaxRounds ?? (enabled ? 3 : DEFAULTS.autoRepairMaxRounds),
				agentRepairMaxIterations: raw.agentRepairMaxIterations ?? DEFAULTS.agentRepairMaxIterations,
				designCollisionPass:
					raw.designCollisionPass !== undefined
						? raw.designCollisionPass
						: (anthropicAutoChain ? true : DEFAULTS.designCollisionPass),
				materializeMergePackageJson: raw.materializeMergePackageJson !== false,
				materializeSkipExistingEntryFiles: raw.materializeSkipExistingEntryFiles !== false,
				verifyNpmBuildAfterImplement:
					enabled ? raw.verifyNpmBuildAfterImplement !== false : DEFAULTS.verifyNpmBuildAfterImplement,
				softTokenBudgetTotal:
					typeof raw.softTokenBudgetTotal === 'number' && raw.softTokenBudgetTotal >= 0
						? raw.softTokenBudgetTotal
						: DEFAULTS.softTokenBudgetTotal,
				softTokenBudgetDegradeModels:
					raw.softTokenBudgetDegradeModels !== undefined
						? !!raw.softTokenBudgetDegradeModels
						: (typeof raw.softTokenBudgetTotal === 'number' && raw.softTokenBudgetTotal > 0 ? true : DEFAULTS.softTokenBudgetDegradeModels),
				softTokenBudgetBlockNewNodes: raw.softTokenBudgetBlockNewNodes ?? DEFAULTS.softTokenBudgetBlockNewNodes,
				suggestGitCommitAfterNode: raw.suggestGitCommitAfterNode ?? DEFAULTS.suggestGitCommitAfterNode,
				taskIsolation:
					raw.taskIsolation === 'worktree' ? 'worktree' : DEFAULTS.taskIsolation,
				humanGateAfterAnalysis: raw.humanGateAfterAnalysis ?? DEFAULTS.humanGateAfterAnalysis,
				splitLargeGoalsAutoCreate: raw.splitLargeGoalsAutoCreate ?? DEFAULTS.splitLargeGoalsAutoCreate,
				evaluatorRubricPath: raw.evaluatorRubricPath ?? DEFAULTS.evaluatorRubricPath,
				evaluatorPipelineEnabled: raw.evaluatorPipelineEnabled ?? DEFAULTS.evaluatorPipelineEnabled,
				evaluatorPlaywrightDir: raw.evaluatorPlaywrightDir ?? DEFAULTS.evaluatorPlaywrightDir,
				evaluatorPlaywrightBlocksVerify:
					raw.evaluatorPlaywrightBlocksVerify !== undefined
						? !!raw.evaluatorPlaywrightBlocksVerify
						: DEFAULTS.evaluatorPlaywrightBlocksVerify,
				evaluatorIndependentLlmEnabled:
					raw.evaluatorIndependentLlmEnabled !== undefined
						? !!raw.evaluatorIndependentLlmEnabled
						: DEFAULTS.evaluatorIndependentLlmEnabled,
				evaluatorLlmBlocksOnNegative: raw.evaluatorLlmBlocksOnNegative ?? DEFAULTS.evaluatorLlmBlocksOnNegative,
				gitCommitAfterNode: raw.gitCommitAfterNode ?? DEFAULTS.gitCommitAfterNode,
				autoSkipBlockedNodesOnRunAll: raw.autoSkipBlockedNodesOnRunAll ?? DEFAULTS.autoSkipBlockedNodesOnRunAll,
				verificationWarningBlocksCompletion: raw.verificationWarningBlocksCompletion ?? DEFAULTS.verificationWarningBlocksCompletion,
				driftNonPassBlocksCompletion: raw.driftNonPassBlocksCompletion ?? DEFAULTS.driftNonPassBlocksCompletion,
				defaultExecutionGraphIncludeVerify:
					enabled ? raw.defaultExecutionGraphIncludeVerify !== false : DEFAULTS.defaultExecutionGraphIncludeVerify,
			};
			if (resolved.enabled) {
				resolved.stagingWrites = raw.stagingWrites !== false;
				resolved.negotiationRequired = raw.negotiationRequired !== false;
				resolved.adrGate = raw.adrGate !== false;
				/** 与 pipeline #5 一致：启用 Harness 时默认严格验证（Reviewer BLOCK 可挡门禁）；显式 `"strictVerification": false` 可关闭 */
				resolved.strictVerification = raw.strictVerification !== false;
			}
			return resolved;
		} catch {
			return { ...DEFAULTS };
		}
	}
}

registerSingleton(IHarnessConfigService, HarnessConfigService, InstantiationType.Delayed);
