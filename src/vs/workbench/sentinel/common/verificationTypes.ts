/*---------------------------------------------------------------------------------------------
 *  Sentinel Verification Types
 *--------------------------------------------------------------------------------------------*/

export type VerificationStatus = 'unknown' | 'passed' | 'warning' | 'blocked';

export type IssueSource =
	| 'diagnostic'
	| 'test'
	| 'review'
	| 'security'
	| 'symbolic'
	| 'drift'
	| 'policy'
	| 'script';

export type IssueSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Issue {
	id: string;
	title: string;
	description: string;
	source: IssueSource;
	severity: IssueSeverity;
	blocking: boolean;
	filePath?: string;
	lineStart?: number;
	lineEnd?: number;
	relatedIntentId?: string;
	relatedNodeId?: string;
}

export interface VerificationSection {
	status: VerificationStatus;
	summary: string;
	issues: Issue[];
}

export interface EvidenceRecord {
	id: string;
	kind: 'diagnostic' | 'test' | 'review' | 'symbolic' | 'trace' | 'projection';
	summary: string;
	refId?: string;
	createdAt: number;
}

/** P5-1：无头执行 npm scripts（lint/test）的结构化结果 */
export interface NpmScriptGateResult {
	ran: boolean;
	scriptName?: string;
	exitCode?: number;
	summary: string;
	blocking: boolean;
	timedOut?: boolean;
	error?: string;
	skipped?: boolean;
}

export interface VerificationBundle {
	id: string;
	intentId: string;
	nodeId?: string;
	overallStatus: VerificationStatus;
	lint: VerificationSection;
	typecheck: VerificationSection;
	tests: VerificationSection;
	review: VerificationSection;
	security: VerificationSection;
	symbolic: VerificationSection;
	/** 当 harness.verifyPackageScripts / verifyNpmBuildAfterImplement 已尝试执行时填充 */
	npmScripts?: { lint: NpmScriptGateResult; test: NpmScriptGateResult; build?: NpmScriptGateResult };
	blockingIssues: string[];
	evidence: EvidenceRecord[];
	summary: string;
	createdAt: number;
	updatedAt: number;
	/** HGT-004：验证门推断的「已满足 successCriteria」子集，供漂移检测消费 */
	matchedSuccessCriteria?: string[];
	/** HGT-026：Playwright + 独立 Evaluator LLM 流水线结果 */
	evaluatorPipeline?: EvaluatorPipelineSnapshot;
}

/** HGT-026：与 Generator 分离的评分步快照 */
export interface EvaluatorPipelineSnapshot {
	playwrightRan: boolean;
	playwrightOk?: boolean;
	playwrightExitCode?: number;
	reportRelPath?: string;
	llmRan: boolean;
	llmPass?: boolean;
	llmSummary?: string;
	skipReason?: string;
}

export function createEmptyVerificationBundle(intentId: string, nodeId?: string): VerificationBundle {
	const now = Date.now();
	const emptySection: VerificationSection = {
		status: 'unknown',
		summary: '尚未收集验证结果',
		issues: [],
	};

	return {
		id: `verification_${now}`,
		intentId,
		nodeId,
		overallStatus: 'unknown',
		lint: { ...emptySection },
		typecheck: { ...emptySection },
		tests: { ...emptySection },
		review: { ...emptySection },
		security: { ...emptySection },
		symbolic: { ...emptySection },
		blockingIssues: [],
		evidence: [],
		summary: '验证尚未开始',
		createdAt: now,
		updatedAt: now,
	};
}
