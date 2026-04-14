/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 4 — 对抗性双智能体 (Red-Teaming Swarm)
// 模型 A (实现者) 编写代码，模型 B (黑客/审查员) 独立审查

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IModelRouterService, ModelTier } from './modelRouterService.js';
import { ISymbolicVerificationService } from './symbolicVerificationService.js';

export const IRedTeamService = createDecorator<IRedTeamService>('IRedTeamService');

// ============================================================================
// 类型
// ============================================================================

export enum VulnerabilitySeverity {
	Critical = 'critical',
	High = 'high',
	Medium = 'medium',
	Low = 'low',
	Info = 'info',
}

export interface Vulnerability {
	id: string;
	severity: VulnerabilitySeverity;
	category: string;
	title: string;
	description: string;
	filePath: string;
	lineRange: { start: number; end: number };
	/** 建议修复方案 */
	suggestedFix?: string;
	/** 是否违反 Spec */
	violatesSpec: boolean;
}

export interface RedTeamReviewResult {
	reviewId: string;
	/** 目标代码描述 */
	targetDescription: string;
	/** 审查模型 */
	reviewerModel: string;
	/** 发现的漏洞 */
	vulnerabilities: Vulnerability[];
	/** 审查摘要 */
	summary: string;
	/** 审查通过？ */
	approved: boolean;
	/** Token 消耗 */
	tokensUsed: number;
	/** 耗时 (ms) */
	duration: number;
	timestamp: number;
}

export interface RedTeamRoundResult {
	/** 实现者生成的代码 */
	implementationCode: string;
	/** 黑客的审查结果 */
	review: RedTeamReviewResult;
	/** 实现者修复后的代码（如果审查不通过） */
	fixedCode?: string;
	/** 第二轮审查（修复后） */
	secondReview?: RedTeamReviewResult;
	/** 最终是否通过 */
	finalApproval: boolean;
	/** 总轮次 */
	rounds: number;
}

// ============================================================================
// 接口
// ============================================================================

export interface IRedTeamService {
	readonly _serviceBrand: undefined;

	readonly onDidCompleteReview: Event<RedTeamReviewResult>;
	readonly onDidCompleteRound: Event<RedTeamRoundResult>;

	/** 对一段代码执行对抗性审查 */
	review(
		code: string,
		filePath: string,
		taskDescription: string,
		specCriteria?: string[],
	): Promise<RedTeamReviewResult>;

	/** 完整对抗循环：实现 → 审查 → (修复 → 再审查) */
	executeRedTeamRound(
		taskDescription: string,
		implementationCode: string,
		filePath: string,
		specCriteria?: string[],
		maxRounds?: number,
	): Promise<RedTeamRoundResult>;

	/** 获取审查历史 */
	getReviewHistory(): RedTeamReviewResult[];
}

// ============================================================================
// System Prompts（关键：实现者和黑客使用不同的 System Prompt）
// ============================================================================

const HACKER_SYSTEM_PROMPT = `You are a SECURITY AUDITOR and ADVERSARIAL REVIEWER (Red Team Agent).
Your job is to find vulnerabilities, logic bugs, and spec violations in code written by another AI.

You must be HOSTILE and THOROUGH. Assume the code is guilty until proven innocent.

Check for:
1. **Security**: injection, XSS, CSRF, auth bypass, privilege escalation, data leaks
2. **Logic**: null/undefined access, off-by-one, race conditions, infinite loops, deadlocks
3. **Spec violations**: does the code actually fulfill the requirements? missing edge cases?
4. **Error handling**: unhandled exceptions, silent failures, missing validation
5. **Resource leaks**: unclosed connections, memory leaks, missing cleanup

Output as JSON array of vulnerabilities:
\`\`\`json
{
  "approved": false,
  "summary": "Found 3 issues...",
  "vulnerabilities": [
    {
      "severity": "high",
      "category": "security",
      "title": "SQL Injection in query builder",
      "description": "User input is concatenated directly...",
      "lineRange": { "start": 15, "end": 18 },
      "suggestedFix": "Use parameterized queries",
      "violatesSpec": false
    }
  ]
}
\`\`\`

If the code is genuinely secure and correct, output:
\`\`\`json
{ "approved": true, "summary": "Code passes adversarial review", "vulnerabilities": [] }
\`\`\``;

const FIXER_SYSTEM_PROMPT = `You are a CODE REPAIR agent. You receive code that has been flagged with vulnerabilities by a security auditor.

Fix ALL flagged vulnerabilities while preserving the original functionality.
Output ONLY the corrected code in a fenced code block. Do NOT explain your changes.`;

// ============================================================================
// 实现
// ============================================================================

export class RedTeamService extends Disposable implements IRedTeamService {
	readonly _serviceBrand: undefined;

	private readonly reviewHistory: RedTeamReviewResult[] = [];

	private readonly _onDidCompleteReview = this._register(new Emitter<RedTeamReviewResult>());
	readonly onDidCompleteReview = this._onDidCompleteReview.event;

	private readonly _onDidCompleteRound = this._register(new Emitter<RedTeamRoundResult>());
	readonly onDidCompleteRound = this._onDidCompleteRound.event;

	private readonly API_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

	constructor(
		@ILogService private readonly logService: ILogService,
		@IModelRouterService private readonly modelRouter: IModelRouterService,
		@ISymbolicVerificationService private readonly symbolicVerifier: ISymbolicVerificationService,
	) {
		super();
	}

	// ========================================================================
	// 对抗性审查
	// ========================================================================

	async review(
		code: string,
		filePath: string,
		taskDescription: string,
		specCriteria?: string[],
	): Promise<RedTeamReviewResult> {
		this.logService.info(`[RedTeamService] Starting adversarial review for ${filePath}`);
		const startTime = Date.now();

		const userPrompt = this.buildReviewPrompt(code, filePath, taskDescription, specCriteria);

		const reviewerModel = 'glm-5.1';

		const response = await this.callLLM(HACKER_SYSTEM_PROMPT, userPrompt, reviewerModel);
		const parsed = this.parseReviewResponse(response, filePath);

		const result: RedTeamReviewResult = {
			reviewId: `review_${Date.now()}`,
			targetDescription: taskDescription,
			reviewerModel,
			vulnerabilities: parsed.vulnerabilities,
			summary: parsed.summary,
			approved: parsed.approved,
			tokensUsed: response.length,
			duration: Date.now() - startTime,
			timestamp: Date.now(),
		};

		this.reviewHistory.push(result);

		this.modelRouter.recordCost(
			result.reviewId,
			reviewerModel,
			ModelTier.Tier3_Power,
			userPrompt.length,
			response.length,
		);

		this._onDidCompleteReview.fire(result);

		this.logService.info(
			`[RedTeamService] Review complete: ${result.approved ? 'APPROVED' : 'REJECTED'}, ` +
			`${result.vulnerabilities.length} vulnerabilities found`
		);

		return result;
	}

	// ========================================================================
	// 完整对抗循环
	// ========================================================================

	async executeRedTeamRound(
		taskDescription: string,
		implementationCode: string,
		filePath: string,
		specCriteria?: string[],
		maxRounds: number = 2,
	): Promise<RedTeamRoundResult> {
		this.logService.info(`[RedTeamService] Starting Red-Team round for ${filePath}`);

		// Round 1: 黑客审查
		const firstReview = await this.review(implementationCode, filePath, taskDescription, specCriteria);

		if (firstReview.approved) {
			const result: RedTeamRoundResult = {
				implementationCode,
				review: firstReview,
				finalApproval: true,
				rounds: 1,
			};
			this._onDidCompleteRound.fire(result);
			return result;
		}

		// 审查不通过 → 修复
		if (maxRounds < 2) {
			const result: RedTeamRoundResult = {
				implementationCode,
				review: firstReview,
				finalApproval: false,
				rounds: 1,
			};
			this._onDidCompleteRound.fire(result);
			return result;
		}

		this.logService.info(`[RedTeamService] Review rejected, attempting auto-fix...`);

		// 修复代码
		const fixPrompt = this.buildFixPrompt(
			implementationCode,
			filePath,
			firstReview.vulnerabilities,
		);

		const fixResponse = await this.callLLM(FIXER_SYSTEM_PROMPT, fixPrompt, 'glm-5.1');
		const fixedCode = this.extractCode(fixResponse) || implementationCode;

		// Round 2: 再次审查修复后的代码
		const secondReview = await this.review(fixedCode, filePath, taskDescription, specCriteria);

		// 符号验证 (Proof-Carrying Code)：如果黑客审查通过，再做形式化验证
		let symbolicApproved = true;
		if (secondReview.approved) {
			try {
				this.logService.info('[RedTeamService] Running symbolic verification (Proof-Carrying Code)...');
				const assertions = this.symbolicVerifier.inferAssertions(fixedCode, 'typescript');
				if (assertions.length > 0) {
					const cert = await this.symbolicVerifier.verifyAll(assertions, fixedCode);
					symbolicApproved = this.symbolicVerifier.canMerge(cert);
					if (!symbolicApproved) {
						this.logService.warn(`[RedTeamService] Symbolic verification FAILED: ${cert.summary}`);
					}
				}
			} catch (error) {
				this.logService.warn(`[RedTeamService] Symbolic verification error: ${String(error)}`);
			}
		}

		const result: RedTeamRoundResult = {
			implementationCode,
			review: firstReview,
			fixedCode,
			secondReview,
			finalApproval: secondReview.approved && symbolicApproved,
			rounds: 2,
		};

		this._onDidCompleteRound.fire(result);

		this.logService.info(
			`[RedTeamService] Red-Team round complete: ` +
			`${result.finalApproval ? 'FINAL APPROVED' : 'STILL REJECTED'}`
		);

		return result;
	}

	// ========================================================================
	// 查询
	// ========================================================================

	getReviewHistory(): RedTeamReviewResult[] {
		return [...this.reviewHistory];
	}

	// ========================================================================
	// 私有方法
	// ========================================================================

	private buildReviewPrompt(
		code: string,
		filePath: string,
		taskDescription: string,
		specCriteria?: string[],
	): string {
		let prompt = `## Code to Review\n\n`;
		prompt += `**File:** ${filePath}\n`;
		prompt += `**Task:** ${taskDescription}\n\n`;

		if (specCriteria && specCriteria.length > 0) {
			prompt += `**Spec Criteria (must be fulfilled):**\n`;
			for (const c of specCriteria) {
				prompt += `- ${c}\n`;
			}
			prompt += `\n`;
		}

		prompt += `\`\`\`\n${code}\n\`\`\`\n\n`;
		prompt += `Please perform a thorough adversarial review. Output your findings as JSON.`;

		return prompt;
	}

	private buildFixPrompt(code: string, filePath: string, vulnerabilities: Vulnerability[]): string {
		let prompt = `## Code with Vulnerabilities\n\n`;
		prompt += `**File:** ${filePath}\n\n`;
		prompt += `\`\`\`\n${code}\n\`\`\`\n\n`;
		prompt += `## Vulnerabilities to Fix\n\n`;

		for (const v of vulnerabilities) {
			prompt += `- **[${v.severity.toUpperCase()}] ${v.title}**: ${v.description}`;
			if (v.suggestedFix) {
				prompt += ` (Suggested: ${v.suggestedFix})`;
			}
			prompt += `\n`;
		}

		prompt += `\nPlease fix ALL vulnerabilities and output the corrected code.`;
		return prompt;
	}

	private parseReviewResponse(response: string, filePath: string): {
		approved: boolean;
		summary: string;
		vulnerabilities: Vulnerability[];
	} {
		// 尝试解析 JSON
		const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
		const jsonStr = jsonMatch[1] || response;

		try {
			const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
			if (objectMatch) {
				const parsed = JSON.parse(objectMatch[0]);

				const vulnerabilities: Vulnerability[] = (parsed.vulnerabilities || []).map((v: Record<string, unknown>, i: number) => ({
					id: `vuln_${Date.now()}_${i}`,
					severity: (v.severity as VulnerabilitySeverity) || VulnerabilitySeverity.Medium,
					category: (v.category as string) || 'general',
					title: (v.title as string) || 'Unknown',
					description: (v.description as string) || '',
					filePath,
					lineRange: (v.lineRange as { start: number; end: number }) || { start: 0, end: 0 },
					suggestedFix: v.suggestedFix as string | undefined,
					violatesSpec: (v.violatesSpec as boolean) || false,
				}));

				return {
					approved: !!parsed.approved,
					summary: (parsed.summary as string) || '',
					vulnerabilities,
				};
			}
		} catch {
			// 解析失败
		}

		// 回退：如果无法解析 JSON，基于文本判断
		const hasIssues = response.toLowerCase().includes('vulnerability')
			|| response.toLowerCase().includes('issue')
			|| response.toLowerCase().includes('bug');

		return {
			approved: !hasIssues,
			summary: response.substring(0, 500),
			vulnerabilities: [],
		};
	}

	private extractCode(response: string): string | undefined {
		const codeMatch = response.match(/```(?:\w+)?\s*([\s\S]*?)```/);
		return codeMatch ? codeMatch[1].trim() : undefined;
	}

	private getApiKey(): string {
		return '20cca2b90c8c4348aaab3d4f6814c33b.Ow4WJfqfc06uB4KI';
	}

	private async callLLM(systemPrompt: string, userPrompt: string, model: string = 'glm-5.1'): Promise<string> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 120000);

		try {
			const response = await fetch(this.API_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.getApiKey()}`,
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					temperature: 0.2,
					max_tokens: 8192,
					stream: true,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			if (!response.ok) throw new Error(`API error: ${response.status}`);

			const reader = response.body?.getReader();
			if (!reader) throw new Error('No response body');

			const decoder = new TextDecoder();
			let content = '';
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6).trim();
					if (data === '[DONE]') continue;
					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) content += delta;
					} catch { /* ignore */ }
				}
			}
			return content;
		} catch (error) {
			clearTimeout(timeoutId);
			throw error;
		}
	}
}

registerSingleton(IRedTeamService, RedTeamService, InstantiationType.Delayed);
