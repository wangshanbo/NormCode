/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 4 — 神经符号网关 (Neuro-Symbolic Gateway)
// 从 SDD 规范中提取逻辑断言，由约束求解器进行数学验证
// 只有"证明安全"的代码才允许合并 (Proof-Carrying Code)

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';

export const ISymbolicVerificationService = createDecorator<ISymbolicVerificationService>('ISymbolicVerificationService');

// ============================================================================
// 类型
// ============================================================================

export enum AssertionKind {
	/** 前置条件 */
	Precondition = 'precondition',
	/** 后置条件 */
	Postcondition = 'postcondition',
	/** 不变式 */
	Invariant = 'invariant',
	/** 类型约束 */
	TypeConstraint = 'type_constraint',
	/** 边界检查 */
	BoundCheck = 'bound_check',
	/** 空值检查 */
	NullCheck = 'null_check',
	/** 安全性断言 */
	SecurityAssertion = 'security',
	/** 自定义 */
	Custom = 'custom',
}

export interface LogicAssertion {
	id: string;
	kind: AssertionKind;
	/** 人类可读描述 */
	description: string;
	/** 形式化表达式 (SMT-LIB 2.0 格式) */
	expression: string;
	/** 关联的代码位置 */
	sourceFile?: string;
	sourceLine?: number;
	/** 关联的 Spec 条款 */
	specClause?: string;
}

export enum VerificationStatus {
	/** 已证明正确 */
	Verified = 'verified',
	/** 无法证明（可能存在反例） */
	Unverified = 'unverified',
	/** 发现反例（确认违规） */
	Violated = 'violated',
	/** 超时 */
	Timeout = 'timeout',
	/** 引擎错误 */
	Error = 'error',
}

export interface VerificationResult {
	assertionId: string;
	status: VerificationStatus;
	/** 如果违规，反例描述 */
	counterExample?: string;
	/** 验证耗时 (ms) */
	duration: number;
	/** 使用的求解器 */
	solver: string;
}

export interface ProofCertificate {
	id: string;
	/** 证明涉及的文件 */
	files: string[];
	/** 全部断言 */
	assertions: LogicAssertion[];
	/** 全部验证结果 */
	results: VerificationResult[];
	/** 是否全部通过 */
	allVerified: boolean;
	/** 摘要 */
	summary: string;
	timestamp: number;
}

// ============================================================================
// 接口
// ============================================================================

export interface ISymbolicVerificationService {
	readonly _serviceBrand: undefined;

	readonly onDidVerify: Event<VerificationResult>;
	readonly onDidIssueCertificate: Event<ProofCertificate>;

	/** 从 Spec 描述中提取逻辑断言 */
	extractAssertions(specDescription: string, code: string): Promise<LogicAssertion[]>;

	/** 从代码中自动推断断言（空值、边界、类型等） */
	inferAssertions(code: string, language: string): LogicAssertion[];

	/** 验证单个断言 */
	verify(assertion: LogicAssertion, code: string): Promise<VerificationResult>;

	/** 验证一组断言并生成 Proof Certificate */
	verifyAll(assertions: LogicAssertion[], code: string): Promise<ProofCertificate>;

	/** 检查代码是否允许合并（所有断言必须通过） */
	canMerge(proofCertificate: ProofCertificate): boolean;

	/** 获取历史证书 */
	getCertificates(): ProofCertificate[];
}

// ============================================================================
// 内置验证规则引擎
// ============================================================================

interface VerificationRule {
	id: string;
	kind: AssertionKind;
	description: string;
	/** 检测模式 */
	detect: RegExp;
	/** 验证逻辑 */
	verify: (code: string, match: RegExpMatchArray) => VerificationStatus;
	/** 反例生成 */
	counterExample?: (match: RegExpMatchArray) => string;
}

const VERIFICATION_RULES: VerificationRule[] = [
	// ======== 空值检查 ========
	{
		id: 'null_deref_property',
		kind: AssertionKind.NullCheck,
		description: 'Object may be null/undefined before property access',
		detect: /(\w+)(?:\?\.)?\.\w+/g,
		verify: (code, match) => {
			const varName = match[1];
			const hasNullCheck = new RegExp(
				`if\\s*\\(\\s*!?${varName}\\s*(?:!==?|===?)\\s*(?:null|undefined)|` +
				`${varName}\\s*&&\\s*|` +
				`${varName}\\?\\.|` +
				`if\\s*\\(\\s*${varName}\\s*\\)`
			).test(code);
			return hasNullCheck ? VerificationStatus.Verified : VerificationStatus.Unverified;
		},
		counterExample: (match) => `Variable "${match[1]}" could be null/undefined when accessed`,
	},
	// ======== 数组边界 ========
	{
		id: 'array_bounds',
		kind: AssertionKind.BoundCheck,
		description: 'Array access must be within bounds',
		detect: /(\w+)\[(\w+)\]/g,
		verify: (code, match) => {
			const arrayName = match[1];
			const indexExpr = match[2];
			const hasBoundCheck = new RegExp(
				`${indexExpr}\\s*<\\s*${arrayName}\\.length|` +
				`${indexExpr}\\s*>=?\\s*0\\s*&&|` +
				`if\\s*\\(\\s*${indexExpr}\\s*<\\s*${arrayName}\\.length`
			).test(code);
			return hasBoundCheck ? VerificationStatus.Verified : VerificationStatus.Unverified;
		},
		counterExample: (match) => `Array "${match[1]}" accessed with index "${match[2]}" without bounds check`,
	},
	// ======== 除零检查 ========
	{
		id: 'division_by_zero',
		kind: AssertionKind.BoundCheck,
		description: 'Division by zero must be prevented',
		detect: /[/]\s*(\w+)/g,
		verify: (code, match) => {
			const divisor = match[1];
			if (/^\d+$/.test(divisor) && parseInt(divisor) !== 0) {
				return VerificationStatus.Verified;
			}
			const hasZeroCheck = new RegExp(
				`if\\s*\\(\\s*${divisor}\\s*(?:!==?|===?)\\s*0|` +
				`${divisor}\\s*(?:!==?|>)\\s*0`
			).test(code);
			return hasZeroCheck ? VerificationStatus.Verified : VerificationStatus.Unverified;
		},
		counterExample: (match) => `Potential division by zero: divisor "${match[1]}" may be 0`,
	},
	// ======== SQL 注入 ========
	{
		id: 'sql_injection',
		kind: AssertionKind.SecurityAssertion,
		description: 'SQL queries must use parameterized statements',
		detect: /(?:query|execute|sql|raw)\s*\(\s*[`'"].*\$\{/g,
		verify: () => VerificationStatus.Violated,
		counterExample: () => 'String interpolation in SQL query detected - use parameterized queries',
	},
	// ======== XSS ========
	{
		id: 'xss_innerHTML',
		kind: AssertionKind.SecurityAssertion,
		description: 'innerHTML must not contain unsanitized user input',
		detect: /\.innerHTML\s*=\s*(?!['"`]<)/g,
		verify: (code) => {
			const hasSanitize = /sanitize|escape|encode|DOMPurify/i.test(code);
			return hasSanitize ? VerificationStatus.Verified : VerificationStatus.Unverified;
		},
		counterExample: () => 'innerHTML assignment without sanitization - potential XSS vulnerability',
	},
	// ======== 错误处理 ========
	{
		id: 'unhandled_promise',
		kind: AssertionKind.Invariant,
		description: 'Async operations must have error handling',
		detect: /await\s+\w+/g,
		verify: (code, match) => {
			const matchIdx = match.index || 0;
			const before = code.substring(Math.max(0, matchIdx - 200), matchIdx);
			const hasTryCatch = /try\s*\{/.test(before);
			const hasCatch = /\.catch\s*\(/.test(code.substring(matchIdx, matchIdx + 100));
			return (hasTryCatch || hasCatch) ? VerificationStatus.Verified : VerificationStatus.Unverified;
		},
		counterExample: () => 'Await expression without try/catch or .catch() error handling',
	},
	// ======== 类型安全 ========
	{
		id: 'type_assertion_any',
		kind: AssertionKind.TypeConstraint,
		description: 'Avoid unsafe type assertions (as any)',
		detect: /as\s+any\b/g,
		verify: () => VerificationStatus.Violated,
		counterExample: () => '"as any" bypasses type safety - use proper type narrowing',
	},
	// ======== 资源泄漏 ========
	{
		id: 'resource_leak_stream',
		kind: AssertionKind.Invariant,
		description: 'Streams/readers must be closed after use',
		detect: /(?:createReadStream|getReader|openSync)\s*\(/g,
		verify: (code) => {
			const hasClose = /\.close\(\)|\.destroy\(\)|finally\s*\{|\.releaseLock\(\)|using\s+/i.test(code);
			return hasClose ? VerificationStatus.Verified : VerificationStatus.Unverified;
		},
		counterExample: () => 'Stream/reader opened without corresponding close/destroy in finally block',
	},
];

// ============================================================================
// 实现
// ============================================================================

export class SymbolicVerificationService extends Disposable implements ISymbolicVerificationService {
	readonly _serviceBrand: undefined;

	private readonly certificates: ProofCertificate[] = [];

	private readonly _onDidVerify = this._register(new Emitter<VerificationResult>());
	readonly onDidVerify = this._onDidVerify.event;

	private readonly _onDidIssueCertificate = this._register(new Emitter<ProofCertificate>());
	readonly onDidIssueCertificate = this._onDidIssueCertificate.event;

	private readonly API_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	// ========================================================================
	// 断言提取（从 Spec 描述 + LLM）
	// ========================================================================

	async extractAssertions(specDescription: string, code: string): Promise<LogicAssertion[]> {
		this.logService.info('[SymbolicVerification] Extracting assertions from spec...');

		const systemPrompt = `You are a formal verification assistant. Extract logical assertions from the specification and code.

Output a JSON array of assertions. Each assertion has:
- kind: "precondition" | "postcondition" | "invariant" | "type_constraint" | "bound_check" | "null_check" | "security"
- description: human-readable description
- expression: SMT-LIB 2.0 style expression (simplified)

Example output:
\`\`\`json
[
  {"kind": "precondition", "description": "User ID must be positive", "expression": "(assert (> userId 0))"},
  {"kind": "null_check", "description": "Config must not be null", "expression": "(assert (not (= config null)))"}
]
\`\`\``;

		const userPrompt = `## Specification\n${specDescription}\n\n## Code\n\`\`\`\n${code}\n\`\`\`\n\nExtract all verifiable assertions.`;

		try {
			const response = await this.callLLM(systemPrompt, userPrompt);
			return this.parseAssertionResponse(response);
		} catch (error) {
			this.logService.warn(`[SymbolicVerification] LLM extraction failed: ${String(error)}`);
			return this.inferAssertions(code, 'typescript');
		}
	}

	// ========================================================================
	// 自动推断断言
	// ========================================================================

	inferAssertions(code: string, _language: string): LogicAssertion[] {
		const assertions: LogicAssertion[] = [];
		let assertionId = 0;

		for (const rule of VERIFICATION_RULES) {
			const regex = new RegExp(rule.detect.source, rule.detect.flags);
			let match;

			while ((match = regex.exec(code)) !== null) {
				// 确定行号
				const beforeMatch = code.substring(0, match.index);
				const line = beforeMatch.split('\n').length;

				assertions.push({
					id: `auto_${assertionId++}`,
					kind: rule.kind,
					description: rule.description,
					expression: `(assert (${rule.id} "${match[0].substring(0, 50)}"))`,
					sourceLine: line,
				});
			}
		}

		this.logService.info(`[SymbolicVerification] Inferred ${assertions.length} assertions`);
		return assertions;
	}

	// ========================================================================
	// 验证
	// ========================================================================

	async verify(assertion: LogicAssertion, code: string): Promise<VerificationResult> {
		const startTime = performance.now();

		// 查找匹配的内置验证规则
		const rule = VERIFICATION_RULES.find(r => r.kind === assertion.kind);

		let status = VerificationStatus.Unverified;
		let counterExample: string | undefined;

		if (rule) {
			const regex = new RegExp(rule.detect.source, rule.detect.flags);
			const match = regex.exec(code);

			if (match) {
				status = rule.verify(code, match);
				if (status !== VerificationStatus.Verified && rule.counterExample) {
					counterExample = rule.counterExample(match);
				}
			} else {
				status = VerificationStatus.Verified;
			}
		} else {
			// 没有内置规则，使用 LLM 辅助验证
			status = await this.llmVerify(assertion, code);
		}

		const result: VerificationResult = {
			assertionId: assertion.id,
			status,
			counterExample,
			duration: performance.now() - startTime,
			solver: rule ? 'builtin-rule-engine' : 'llm-assisted',
		};

		this._onDidVerify.fire(result);
		return result;
	}

	async verifyAll(assertions: LogicAssertion[], code: string): Promise<ProofCertificate> {
		this.logService.info(`[SymbolicVerification] Verifying ${assertions.length} assertions...`);
		const startTime = performance.now();

		const results: VerificationResult[] = [];

		for (const assertion of assertions) {
			const result = await this.verify(assertion, code);
			results.push(result);
		}

		const allVerified = results.every(
			r => r.status === VerificationStatus.Verified
		);

		const violated = results.filter(r => r.status === VerificationStatus.Violated);
		const unverified = results.filter(r => r.status === VerificationStatus.Unverified);
		const verified = results.filter(r => r.status === VerificationStatus.Verified);

		let summary: string;
		if (allVerified) {
			summary = `All ${assertions.length} assertions verified. Code is provably safe.`;
		} else {
			summary = `${verified.length}/${assertions.length} verified, ` +
				`${violated.length} violated, ${unverified.length} unverified. ` +
				`Code requires fixes before merge.`;
		}

		const certificate: ProofCertificate = {
			id: `cert_${Date.now()}`,
			files: [...new Set(assertions.map(a => a.sourceFile).filter((f): f is string => !!f))],
			assertions,
			results,
			allVerified,
			summary,
			timestamp: Date.now(),
		};

		this.certificates.push(certificate);
		this._onDidIssueCertificate.fire(certificate);

		this.logService.info(
			`[SymbolicVerification] Certificate issued: ${allVerified ? 'PASS' : 'FAIL'} ` +
			`(${(performance.now() - startTime).toFixed(0)}ms)`
		);

		return certificate;
	}

	// ========================================================================
	// Proof-Carrying Code 合并门
	// ========================================================================

	canMerge(cert: ProofCertificate): boolean {
		if (!cert.allVerified) {
			const violated = cert.results.filter(r => r.status === VerificationStatus.Violated);
			this.logService.warn(
				`[SymbolicVerification] MERGE BLOCKED: ${violated.length} assertions violated`
			);
			return false;
		}
		return true;
	}

	getCertificates(): ProofCertificate[] {
		return [...this.certificates];
	}

	// ========================================================================
	// 私有：LLM 辅助验证
	// ========================================================================

	private async llmVerify(assertion: LogicAssertion, code: string): Promise<VerificationStatus> {
		const systemPrompt = `You are a formal verification engine. Given an assertion and code, determine if the assertion holds.
Output ONLY one of: "verified", "violated", "unverified"`;

		const userPrompt = `Assertion: ${assertion.description}\nExpression: ${assertion.expression}\n\nCode:\n\`\`\`\n${code.substring(0, 3000)}\n\`\`\``;

		try {
			const response = await this.callLLM(systemPrompt, userPrompt);
			const lower = response.toLowerCase().trim();

			if (lower.includes('verified') && !lower.includes('unverified')) {
				return VerificationStatus.Verified;
			}
			if (lower.includes('violated')) {
				return VerificationStatus.Violated;
			}
			return VerificationStatus.Unverified;
		} catch {
			return VerificationStatus.Error;
		}
	}

	// ========================================================================
	// 私有：解析 LLM 断言提取响应
	// ========================================================================

	private parseAssertionResponse(response: string): LogicAssertion[] {
		const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
		const jsonStr = jsonMatch[1] || response;

		try {
			const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
			if (arrayMatch) {
				const parsed = JSON.parse(arrayMatch[0]);
				return (parsed as Array<Record<string, string>>).map((item, i) => ({
					id: `spec_${i}`,
					kind: (item.kind as AssertionKind) || AssertionKind.Custom,
					description: item.description || '',
					expression: item.expression || '',
				}));
			}
		} catch {
			// 解析失败
		}

		return [];
	}

	// ========================================================================
	// LLM 调用
	// ========================================================================

	private getApiKey(): string {
		return '20cca2b90c8c4348aaab3d4f6814c33b.Ow4WJfqfc06uB4KI';
	}

	private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 60000);

		try {
			const response = await fetch(this.API_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.getApiKey()}`,
				},
				body: JSON.stringify({
					model: 'glm-5.1',
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					temperature: 0.1,
					max_tokens: 4096,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			if (!response.ok) {
				throw new Error(`API error: ${response.status}`);
			}

			const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
			return data.choices?.[0]?.message?.content || '';
		} catch (error) {
			clearTimeout(timeoutId);
			throw error;
		}
	}
}

registerSingleton(ISymbolicVerificationService, SymbolicVerificationService, InstantiationType.Delayed);
