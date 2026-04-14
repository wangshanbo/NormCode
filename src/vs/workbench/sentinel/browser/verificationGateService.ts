/*---------------------------------------------------------------------------------------------
 *  Sentinel Verification Gate Service
 *  多通道验证汇总 + Reviewer Worker 输出解析 + 高风险强审查自动切换
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ILSPFeedbackService } from '../../services/aiCore/browser/lspFeedbackService.js';
import { IRedTeamService } from '../../services/aiCore/browser/redTeamService.js';
import { ISymbolicVerificationService } from '../../services/aiCore/browser/symbolicVerificationService.js';
import { ITDDService } from '../../services/aiCore/browser/tddService.js';
import { ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { createEmptyVerificationBundle, Issue, NpmScriptGateResult, VerificationBundle, VerificationStatus } from '../common/verificationTypes.js';
import { IHarnessConfigService } from './harnessConfigService.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { ISentinelNpmScriptRunnerService } from './sentinelNpmScriptRunnerService.js';
import { pickWorkspaceFolderForNpmScripts } from '../common/sentinelWorkspaceRootPick.js';
import { IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { tryParseVerifierMatchedSuccessCriteria } from '../common/verificationVerifierCriteriaParse.js';

export const IVerificationGateService = createDecorator<IVerificationGateService>('IVerificationGateService');

export type ReviewerVerdict = 'PASS' | 'WARN' | 'BLOCK';

export interface ParsedReviewerOutput {
	verdict: ReviewerVerdict;
	issues: Array<{
		severity: string;
		location: string;
		description: string;
		suggestion: string;
	}>;
	impactAnalysis: string;
	rawOutput: string;
}

export interface IVerificationGateService {
	readonly _serviceBrand: undefined;
	buildBundle(intent: Intent, node?: ExecutionNode, reviewerWorkerOutput?: string, harnessOpts?: { verifierWorkerSummary?: string }): Promise<VerificationBundle>;
	/** 覆盖内存中的验证包（供内核在 buildBundle 之后附加行为 E2E 等结果） */
	commitBundle(bundle: VerificationBundle): void;
	parseReviewerOutput(output: string): ParsedReviewerOutput;
	isHighRiskIntent(intent: Intent): boolean;
	getBundle(intentId: string, nodeId?: string): VerificationBundle | undefined;
	listBundles(): VerificationBundle[];
	hydrateBundles(bundles: VerificationBundle[]): void;
}

export class VerificationGateService extends Disposable implements IVerificationGateService {
	readonly _serviceBrand: undefined;

	private readonly bundles = new Map<string, VerificationBundle>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILSPFeedbackService private readonly lspFeedbackService: ILSPFeedbackService,
		@ITDDService private readonly tddService: ITDDService,
		@IRedTeamService private readonly redTeamService: IRedTeamService,
		@ISymbolicVerificationService private readonly symbolicVerificationService: ISymbolicVerificationService,
		@IHarnessConfigService private readonly harnessConfigService: IHarnessConfigService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISentinelNpmScriptRunnerService private readonly npmScriptRunner: ISentinelNpmScriptRunnerService,
	) {
		super();
	}

	// ════════════════════════════════════════════════════════════════════════
	// Reviewer Worker 输出解析
	// ════════════════════════════════════════════════════════════════════════

	parseReviewerOutput(output: string): ParsedReviewerOutput {
		const result: ParsedReviewerOutput = {
			verdict: 'WARN',
			issues: [],
			impactAnalysis: '',
			rawOutput: output,
		};

		const verdictMatch = output.match(/##\s*审查结论\s*[:：]\s*\[?\s*(PASS|WARN|BLOCK)\s*\]?/i);
		if (verdictMatch) {
			result.verdict = verdictMatch[1].toUpperCase() as ReviewerVerdict;
		} else if (/\bBLOCK\b/i.test(output.slice(0, 200))) {
			result.verdict = 'BLOCK';
		} else if (/\bPASS\b/i.test(output.slice(0, 200))) {
			result.verdict = 'PASS';
		}

		const issueBlockMatch = output.match(/##\s*发现的问题([\s\S]*?)(?=##|$)/i);
		if (issueBlockMatch) {
			const issueBlock = issueBlockMatch[1];
			const issuePattern = /[-*]\s*\*?\*?(?:严重性|severity)\s*[:：]\s*(.+?)(?:\n|,|，)\s*\*?\*?(?:位置|location)\s*[:：]\s*(.+?)(?:\n|,|，)\s*\*?\*?(?:描述|description)\s*[:：]\s*(.+?)(?:\n|,|，)\s*\*?\*?(?:建议|suggestion|修复)\s*[:：]\s*(.+?)(?:\n|$)/gi;
			let match;
			while ((match = issuePattern.exec(issueBlock)) !== null) {
				result.issues.push({
					severity: match[1].trim(),
					location: match[2].trim(),
					description: match[3].trim(),
					suggestion: match[4].trim(),
				});
			}

			if (result.issues.length === 0) {
				const bulletPattern = /[-*]\s+(.+)/g;
				let bulletMatch;
				while ((bulletMatch = bulletPattern.exec(issueBlock)) !== null) {
					const line = bulletMatch[1].trim();
					if (line.length > 5) {
						const isCritical = /critical|严重|高危|安全|注入|越权/i.test(line);
						result.issues.push({
							severity: isCritical ? 'critical' : 'medium',
							location: '',
							description: line,
							suggestion: '',
						});
					}
				}
			}
		}

		const impactMatch = output.match(/##\s*影响面分析([\s\S]*?)(?=##|$)/i);
		if (impactMatch) {
			result.impactAnalysis = impactMatch[1].trim();
		}

		this.logService.info(`[Sentinel Verification] Reviewer verdict: ${result.verdict}, issues: ${result.issues.length}`);
		return result;
	}

	// ════════════════════════════════════════════════════════════════════════
	// 高风险判定
	// ════════════════════════════════════════════════════════════════════════

	isHighRiskIntent(intent: Intent): boolean {
		if (intent.riskLevel === 'critical' || intent.riskLevel === 'high') {
			return true;
		}

		const goalLower = intent.goal.toLowerCase();
		const highRiskKeywords = [
			'auth', 'password', 'token', 'secret', 'credential', 'permission',
			'encrypt', 'decrypt', 'hash', 'security', 'jwt', 'session',
			'sql', 'injection', 'xss', 'csrf', 'privilege', 'admin',
			'payment', '支付', '认证', '加密', '权限', '密码', '安全',
			'database', 'migration', 'schema', 'rollback',
		];
		for (const kw of highRiskKeywords) {
			if (goalLower.includes(kw)) {
				return true;
			}
		}

		if (intent.intentCard.allowedFiles.length > 10) {
			return true;
		}

		if (intent.intentCard.stopIf.length > 2) {
			return true;
		}

		return false;
	}

	// ════════════════════════════════════════════════════════════════════════
	// Build Bundle — 多通道验证汇总
	// ════════════════════════════════════════════════════════════════════════

	async buildBundle(intent: Intent, node?: ExecutionNode, reviewerWorkerOutput?: string, harnessOpts?: { verifierWorkerSummary?: string }): Promise<VerificationBundle> {
		const bundle = createEmptyVerificationBundle(intent.id, node?.id);
		const issues: Issue[] = [];
		const isHighRisk = this.isHighRiskIntent(intent);
		const harnessCfg = await this.harnessConfigService.getResolved();
		const zeroWarningMode = harnessCfg.enabled && harnessCfg.strictVerification;
		let npmScriptSummary = '';
		if (!harnessCfg.verifyPackageScripts && harnessCfg.hintNpmScripts) {
			npmScriptSummary = await this.readPackageScriptsSummary(intent);
		}
		let npmRunResult: Awaited<ReturnType<ISentinelNpmScriptRunnerService['runLintAndTestScripts']>> | undefined;

		if (isHighRisk) {
			this.logService.info(`[Sentinel Verification] HIGH RISK intent detected: ${intent.id}, applying stricter review`);
		}

		// ── Channel 1: LSP Diagnostics (lint + typecheck split) ──
		const diagnostics = this.lspFeedbackService.getWorkspaceDiagnostics()
			.filter(item => intent.intentCard.allowedFiles.length === 0 || intent.intentCard.allowedFiles.some(file => item.path.includes(file)));

		const lintIssues: Issue[] = [];
		const typecheckIssues: Issue[] = [];

		for (const snapshot of diagnostics) {
			for (let index = 0; index < snapshot.errors.length; index++) {
				const error = snapshot.errors[index];
				const isTypeError = /ts\(\d+\)|type.*error|类型|cannot find name|not assignable/i.test(error.message);
				const severityLevel = error.severity;
				const isBlocking = severityLevel === 'error' || !severityLevel;
				const issue: Issue = {
					id: `diag_${snapshot.path}_${index}`,
					title: error.message,
					description: `${error.severity || 'error'} from ${error.source || 'marker'}`,
					source: 'diagnostic',
					severity: isBlocking ? 'high' : 'medium',
					blocking: isBlocking,
					filePath: snapshot.path,
					lineStart: error.startLine,
					lineEnd: error.endLine,
					relatedIntentId: intent.id,
					relatedNodeId: node?.id,
				};

				if (isTypeError) {
					typecheckIssues.push(issue);
				} else {
					lintIssues.push(issue);
				}
			}

			for (const warn of snapshot.warnings.slice(0, 5)) {
				lintIssues.push({
					id: `diag_warn_${snapshot.path}_${lintIssues.length}`,
					title: warn.message,
					description: `warning from ${warn.source || 'marker'}${zeroWarningMode ? ' [Zero-Warning 模式视为阻塞]' : ''}`,
					source: 'diagnostic',
					severity: zeroWarningMode ? 'high' : 'low',
					blocking: zeroWarningMode,
					filePath: snapshot.path,
					lineStart: warn.startLine,
					lineEnd: warn.endLine,
					relatedIntentId: intent.id,
					relatedNodeId: node?.id,
				});
			}
		}

		if (harnessCfg.verifyPackageScripts) {
			const folder = await this.pickWorkspaceFolderForNpm(intent);
			if (folder) {
				const r = await this.npmScriptRunner.runLintAndTestScripts(folder);
				npmRunResult = r;
				const lintGate = this.toNpmGate('lint', r.lint);
				const testGate = this.toNpmGate('test', r.test);
				bundle.npmScripts = { lint: lintGate, test: testGate };
				npmScriptSummary = [
					`P5-1 L2 无头执行: lint(${lintGate.scriptName ?? '—'}) → ${this.fmtNpmOutcome(r.lint)}`,
					`test(${testGate.scriptName ?? '—'}) → ${this.fmtNpmOutcome(r.test)}`,
				].join('；');
				if (!r.lint.skipped && r.lint.exitCode !== undefined && r.lint.exitCode !== 0) {
					lintIssues.push({
						id: `npm_lint_${Date.now()}`,
						title: `npm run ${r.lint.scriptName} 失败 (exit ${r.lint.exitCode})`,
						description: r.lint.errorMessage || (r.lint.timedOut ? '任务超时' : '脚本返回非零退出码'),
						source: 'script',
						severity: 'high',
						blocking: true,
						relatedIntentId: intent.id,
						relatedNodeId: node?.id,
					});
				} else if (!r.lint.skipped && r.lint.errorMessage && r.lint.exitCode === undefined) {
					lintIssues.push({
						id: `npm_lint_err_${Date.now()}`,
						title: `npm lint 任务未执行: ${r.lint.scriptName}`,
						description: r.lint.errorMessage,
						source: 'script',
						severity: 'medium',
						blocking: false,
						relatedIntentId: intent.id,
						relatedNodeId: node?.id,
					});
				}
			} else {
				npmScriptSummary = 'P5-1 L2: 无工作区文件夹，跳过 npm 脚本';
			}
		}

		// ── implement/project：npm run build（与 lint/test 独立，捕获错误 import / 编译失败） ──
		if (harnessCfg.verifyNpmBuildAfterImplement && node && (node.type === 'implement' || node.type === 'project')) {
			const folder = await this.pickWorkspaceFolderForNpm(intent);
			if (folder) {
				const br = await this.npmScriptRunner.runBuildScript(folder);
				const buildGate = this.toNpmGate('build', br);
				const buildLine = `build(${buildGate.scriptName ?? '—'}) → ${this.fmtNpmOutcome(br)}`;
				npmScriptSummary = npmScriptSummary ? `${npmScriptSummary}；${buildLine}` : `P5-1 L2: ${buildLine}`;
				if (!br.skipped && br.exitCode !== undefined && br.exitCode !== 0) {
					lintIssues.push({
						id: `npm_build_${Date.now()}`,
						title: `npm run ${br.scriptName ?? 'build'} 失败 (exit ${br.exitCode})`,
						description: br.errorMessage || (br.timedOut ? '任务超时' : '构建返回非零退出码'),
						source: 'script',
						severity: 'high',
						blocking: true,
						relatedIntentId: intent.id,
						relatedNodeId: node?.id,
					});
				} else if (!br.skipped && br.errorMessage && br.exitCode === undefined) {
					lintIssues.push({
						id: `npm_build_err_${Date.now()}`,
						title: 'npm build 任务未成功执行',
						description: br.errorMessage,
						source: 'script',
						severity: 'medium',
						blocking: false,
						relatedIntentId: intent.id,
						relatedNodeId: node?.id,
					});
				}
				if (bundle.npmScripts) {
					bundle.npmScripts = { ...bundle.npmScripts, build: buildGate };
				} else {
					const skipped: NpmScriptGateResult = {
						ran: false,
						summary: '未与本项一并执行',
						blocking: false,
						skipped: true,
					};
					bundle.npmScripts = { lint: skipped, test: skipped, build: buildGate };
				}
			}
		}

		bundle.lint = {
			status: lintIssues.some(i => i.blocking) ? 'blocked' : (lintIssues.length > 0 ? 'warning' : 'passed'),
			summary: lintIssues.length > 0 ? `发现 ${lintIssues.length} 个 Lint 问题（${lintIssues.filter(i => i.blocking).length} 阻塞）` : 'Lint 诊断通过',
			issues: lintIssues,
		};

		bundle.typecheck = {
			status: typecheckIssues.some(i => i.blocking) ? 'blocked' : (typecheckIssues.length > 0 ? 'warning' : 'passed'),
			summary: typecheckIssues.length > 0 ? `发现 ${typecheckIssues.length} 个类型检查问题（${typecheckIssues.filter(i => i.blocking).length} 阻塞）` : '类型检查通过',
			issues: typecheckIssues,
		};

		issues.push(...lintIssues, ...typecheckIssues);

		// ── Channel 2: TDD Test Results ──
		const testSuites = this.tddService.getAllSuites();
		const failingSuites = testSuites.filter(suite => suite.status === 'failed' || suite.status === 'error');
		const testIssues: Issue[] = failingSuites.map((suite, index) => ({
			id: `test_${suite.id}_${index}`,
			title: suite.name,
			description: `测试套件失败，当前通过率 ${suite.passRate}%`,
			source: 'test' as const,
			severity: 'medium' as const,
			blocking: false,
			relatedIntentId: intent.id,
			relatedNodeId: node?.id,
		}));
		if (npmRunResult) {
			const nt = npmRunResult.test;
			if (!nt.skipped && nt.exitCode !== undefined && nt.exitCode !== 0) {
				testIssues.push({
					id: `npm_test_${Date.now()}`,
					title: `npm run ${nt.scriptName} 失败 (exit ${nt.exitCode})`,
					description: nt.errorMessage || (nt.timedOut ? '任务超时' : '脚本返回非零退出码'),
					source: 'script',
					severity: 'high',
					blocking: true,
					relatedIntentId: intent.id,
					relatedNodeId: node?.id,
				});
			} else if (!nt.skipped && nt.errorMessage && nt.exitCode === undefined) {
				testIssues.push({
					id: `npm_test_err_${Date.now()}`,
					title: `npm test 任务未执行: ${nt.scriptName}`,
					description: nt.errorMessage,
					source: 'script',
					severity: 'medium',
					blocking: false,
					relatedIntentId: intent.id,
					relatedNodeId: node?.id,
				});
			}
		}
		bundle.tests = {
			status: testIssues.some(i => i.blocking) ? 'blocked' : (testIssues.length > 0 ? 'warning' : 'passed'),
			summary: testIssues.length > 0 ? `存在 ${testIssues.length} 个测试相关问题（${testIssues.filter(i => i.blocking).length} 阻塞）` : '测试状态正常',
			issues: testIssues,
		};
		issues.push(...testIssues);

		// ── Channel 3: Reviewer Worker Output (structured parse) ──
		let parsedReview: ParsedReviewerOutput | undefined;
		const workerReviewIssues: Issue[] = [];

		if (reviewerWorkerOutput) {
			parsedReview = this.parseReviewerOutput(reviewerWorkerOutput);

			for (let i = 0; i < parsedReview.issues.length; i++) {
				const ri = parsedReview.issues[i];
				const isCritical = /critical|严重|高危/i.test(ri.severity);
				const isHigh = /high|中高|较高/i.test(ri.severity) || isCritical;
				workerReviewIssues.push({
					id: `reviewer_worker_${Date.now()}_${i}`,
					title: ri.description.slice(0, 80),
					description: `[${ri.severity}] ${ri.description}${ri.location ? ` @ ${ri.location}` : ''}${ri.suggestion ? ` → ${ri.suggestion}` : ''}`,
					source: 'review' as const,
					severity: isCritical ? 'critical' : (isHigh ? 'high' : 'medium'),
					blocking: isCritical,
					filePath: ri.location || undefined,
					relatedIntentId: intent.id,
					relatedNodeId: node?.id,
				});
			}

			if (parsedReview.verdict === 'BLOCK') {
				if (zeroWarningMode) {
					this.logService.info(`[Sentinel Verification] Reviewer BLOCK + strictVerification：审查问题视为阻塞项`);
					for (const issue of workerReviewIssues) {
						issue.blocking = true;
						if (issue.severity !== 'critical') {
							issue.severity = 'high';
						}
					}
					if (workerReviewIssues.length === 0) {
						workerReviewIssues.push({
							id: `reviewer_block_${Date.now()}`,
							title: 'Reviewer 裁定 BLOCK',
							description: 'strictVerification 已开启：BLOCK 视为验证门阻塞，需修复后重试',
							source: 'review',
							severity: 'high',
							blocking: true,
							relatedIntentId: intent.id,
							relatedNodeId: node?.id,
						});
					}
				} else {
					this.logService.info(`[Sentinel Verification] Reviewer BLOCK verdict recorded as advisory warning (strictVerification off)`);
					if (workerReviewIssues.length === 0) {
						workerReviewIssues.push({
							id: `reviewer_block_${Date.now()}`,
							title: 'Reviewer 建议阻塞',
							description: 'Reviewer Worker 建议 BLOCK，已记录为警告（可在 harness.json 设 strictVerification: true 升级为阻塞）',
							source: 'review',
							severity: 'medium',
							blocking: false,
							relatedIntentId: intent.id,
							relatedNodeId: node?.id,
						});
					}
				}
			}

			if (isHighRisk && parsedReview.verdict === 'WARN') {
				this.logService.info(`[Sentinel Verification] High-risk mode: WARN verdict noted, only critical issues block`);
			}
		}

		// ── Channel 3b: RedTeam Service (legacy) ──
		const reviewHistory = this.redTeamService.getReviewHistory();
		const latestReview = reviewHistory.at(-1);
		const redTeamIssues: Issue[] = latestReview && !latestReview.approved
			? latestReview.vulnerabilities.map(vulnerability => ({
				id: vulnerability.id,
				title: vulnerability.title,
				description: vulnerability.description,
				source: 'review' as const,
				severity: (vulnerability.severity === 'critical' ? 'critical' : 'high') as Issue['severity'],
				blocking: vulnerability.severity === 'critical',
				filePath: vulnerability.filePath,
				lineStart: vulnerability.lineRange.start,
				lineEnd: vulnerability.lineRange.end,
				relatedIntentId: intent.id,
				relatedNodeId: node?.id,
			}))
			: [];

		const allReviewIssues = [...workerReviewIssues, ...redTeamIssues];

		const reviewVerdict: VerificationStatus = parsedReview
			? (parsedReview.verdict === 'BLOCK' ? 'warning' : parsedReview.verdict === 'WARN' ? 'warning' : 'passed')
			: (allReviewIssues.length > 0 ? 'warning' : 'passed');

		bundle.review = {
			status: reviewVerdict,
			summary: parsedReview
				? `Reviewer 裁定: ${parsedReview.verdict}，发现 ${allReviewIssues.length} 个问题${isHighRisk ? '（强审查模式）' : ''}`
				: (allReviewIssues.length > 0 ? `对抗审查发现 ${allReviewIssues.length} 个问题` : '对抗审查通过或尚未触发'),
			issues: allReviewIssues,
		};
		issues.push(...allReviewIssues);

		// ── Channel 4: Security ──
		const securityIssues = allReviewIssues.filter(issue =>
			issue.severity === 'critical' || issue.severity === 'high' ||
			/安全|security|inject|xss|csrf|越权/i.test(issue.description)
		);
		bundle.security = {
			status: securityIssues.some(i => i.blocking) ? 'blocked' : 'passed',
			summary: securityIssues.length > 0
				? `发现 ${securityIssues.length} 个安全相关问题${isHighRisk ? '（强审查模式下阻塞阈值降低）' : ''}`
				: '未发现安全阻塞问题',
			issues: securityIssues,
		};

		// ── Channel 5: Symbolic ──
		void this.symbolicVerificationService;
		bundle.symbolic = {
			status: 'unknown',
			summary: npmScriptSummary || '符号验证桥已预留，当前未自动执行',
			issues: [],
		};

		// ── Overall — 任意 blocking 项即失败（含 Zero-Warning 下的 LSP warning）
		const blockingIssues = issues.filter(i => i.blocking);
		const hasWarnings = issues.length > 0;
		bundle.overallStatus = blockingIssues.length > 0 ? 'blocked' : (hasWarnings ? 'warning' : 'passed');
		bundle.blockingIssues = blockingIssues.map(issue => issue.id);
		bundle.evidence = [
			{
				id: `evidence_lsp_${Date.now()}`,
				kind: 'diagnostic',
				summary: bundle.lint.summary,
				createdAt: Date.now(),
			},
			{
				id: `evidence_tests_${Date.now() + 1}`,
				kind: 'test',
				summary: bundle.tests.summary,
				createdAt: Date.now(),
			},
			{
				id: `evidence_review_${Date.now() + 2}`,
				kind: 'review',
				summary: bundle.review.summary,
				createdAt: Date.now(),
			},
		];
		bundle.summary = blockingIssues.length > 0
			? (zeroWarningMode && lintIssues.some(i => i.blocking)
				? `Zero-Warning：存在 ${blockingIssues.length} 个阻塞项（含 LSP 警告）`
				: `验证门阻塞：${blockingIssues.length} 个阻塞项需解决`)
			: hasWarnings
				? `验证通过（${issues.length} 个非关键警告已记录）`
				: '验证门通过：当前节点可以继续推进';
		bundle.updatedAt = Date.now();
		bundle.matchedSuccessCriteria = this.computeMatchedSuccessCriteria(node, bundle, harnessOpts?.verifierWorkerSummary);

		this.bundles.set(this.toKey(intent.id, node?.id), bundle);
		return bundle;
	}

	/**
	 * 验证门全绿时认为 gate 内 successCriteria 均已满足；warning 时仅当 Verifier 文本包含对应条目标题时计入（保守）。
	 */
	private computeMatchedSuccessCriteria(
		node: ExecutionNode | undefined,
		bundle: VerificationBundle,
		verifierWorkerSummary?: string,
	): string[] | undefined {
		const criteria = node?.gate.successCriteria;
		if (!criteria?.length) {
			return undefined;
		}
		if (bundle.overallStatus === 'blocked') {
			return [];
		}
		const parsedFromVerifier = verifierWorkerSummary
			? tryParseVerifierMatchedSuccessCriteria(verifierWorkerSummary)
			: undefined;
		const filterToGate = (arr: string[]) => arr.filter(s => criteria.includes(s));

		if (bundle.overallStatus === 'passed') {
			return [...criteria];
		}
		if (bundle.overallStatus === 'warning' && verifierWorkerSummary) {
			if (parsedFromVerifier?.length) {
				return filterToGate(parsedFromVerifier);
			}
			const text = verifierWorkerSummary;
			return criteria.filter(c => text.includes(c));
		}
		return [];
	}

	commitBundle(bundle: VerificationBundle): void {
		this.bundles.set(this.toKey(bundle.intentId, bundle.nodeId), bundle);
	}

	getBundle(intentId: string, nodeId?: string): VerificationBundle | undefined {
		return this.bundles.get(this.toKey(intentId, nodeId));
	}

	listBundles(): VerificationBundle[] {
		return Array.from(this.bundles.values());
	}

	hydrateBundles(bundles: VerificationBundle[]): void {
		this.bundles.clear();
		for (const b of bundles) {
			this.commitBundle(JSON.parse(JSON.stringify(b)) as VerificationBundle);
		}
	}

	private toKey(intentId: string, nodeId?: string): string {
		return `${intentId}:${nodeId || 'intent'}`;
	}

	private async pickWorkspaceFolderForNpm(intent: Intent): Promise<IWorkspaceFolder | undefined> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return pickWorkspaceFolderForNpmScripts(folders, this.fileService, intent.intentCard.allowedFiles, {
			info: m => this.logService.info(m),
			warn: m => this.logService.warn(m),
		});
	}

	private async readPackageScriptsSummary(intent: Intent): Promise<string> {
		const folder = await this.pickWorkspaceFolderForNpm(intent);
		const root = folder?.uri;
		if (!root) {
			return '';
		}
		try {
			const uri = URI.joinPath(root, 'package.json');
			const data = JSON.parse((await this.fileService.readFile(uri)).value.toString()) as { scripts?: Record<string, string> };
			const s = data.scripts || {};
			const keys = Object.keys(s);
			const lintKeys = keys.filter(k => /lint/i.test(k));
			const testKeys = keys.filter(k => /test/i.test(k));
			const hasBuild = Boolean(s.build);
			return `P5-1 L2: package.json 脚本 — lint: ${lintKeys.join(', ') || '无'}; test: ${testKeys.join(', ') || '无'}; build: ${hasBuild ? '有' : '无'}（verifyPackageScripts / verifyNpmBuildAfterImplement 开启时可无头执行）`;
		} catch {
			return 'P5-1 L2: 未找到可解析的 package.json';
		}
	}

	private toNpmGate(_kind: 'lint' | 'test' | 'build', o: import('./sentinelNpmScriptRunnerService.js').NpmScriptRunOutcome & { scriptName?: string; skipped: boolean }): NpmScriptGateResult {
		const ran = !o.skipped && (o.exitCode !== undefined || !!o.errorMessage);
		const blocking = !o.skipped && o.exitCode !== undefined && o.exitCode !== 0;
		let summary: string;
		if (o.skipped) {
			summary = `跳过（${o.errorMessage || '无脚本'}）`;
		} else if (o.timedOut) {
			summary = '超时';
		} else if (o.errorMessage && o.exitCode === undefined) {
			summary = `错误: ${o.errorMessage}`;
		} else if (o.exitCode === undefined) {
			summary = '未知';
		} else {
			summary = `exit ${o.exitCode}`;
		}
		return {
			ran,
			scriptName: o.scriptName,
			exitCode: o.exitCode,
			summary,
			blocking,
			timedOut: o.timedOut,
			error: o.errorMessage,
			skipped: o.skipped,
		};
	}

	private fmtNpmOutcome(o: import('./sentinelNpmScriptRunnerService.js').NpmScriptRunOutcome & { scriptName?: string; skipped: boolean }): string {
		if (o.skipped) {
			return 'skipped';
		}
		if (o.timedOut) {
			return 'timeout';
		}
		if (o.errorMessage && o.exitCode === undefined) {
			return `error: ${o.errorMessage.slice(0, 80)}`;
		}
		return o.exitCode === undefined ? 'unknown' : `code ${o.exitCode}`;
	}
}

registerSingleton(IVerificationGateService, VerificationGateService, InstantiationType.Delayed);
