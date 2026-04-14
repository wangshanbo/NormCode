/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 1 — LSP 诊断反馈流 + 失忆代理协议 (Amnesic Agent)
// 将 IDE 原生的 Error/Warning 实时喂给 AI 形成闭环自修复

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarkerService, IMarker, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICheckpointService, CheckpointType } from './checkpointService.js';
import { ITreeSitterService } from './treeSitterService.js';

export const ILSPFeedbackService = createDecorator<ILSPFeedbackService>('ILSPFeedbackService');

// ============================================================================
// 类型
// ============================================================================

export interface DiagnosticSnapshot {
	uri: string;
	path: string;
	errors: DiagnosticEntry[];
	warnings: DiagnosticEntry[];
	timestamp: number;
}

export interface DiagnosticEntry {
	message: string;
	severity: 'error' | 'warning' | 'info';
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	source?: string;
	code?: string;
}

export interface AmnesicContext {
	/** 本轮受影响文件的 AST 快照（精简版） */
	affectedFiles: Array<{
		path: string;
		content: string;
		diagnostics: DiagnosticEntry[];
		/** Tree-sitter AST 摘要（由 Rust Body 层提供） */
		astSummary?: string;
	}>;
	/** 进度日志 */
	progressLog: string;
	/** 成功标准 */
	successCriteria: string[];
	/** 本轮已尝试修复的次数 */
	iteration: number;
	/** 上一轮失败的错误摘要 */
	previousErrors?: string;
}

export interface AutoFixResult {
	fixed: number;
	remaining: number;
	iterations: number;
	success: boolean;
}

// ============================================================================
// 接口
// ============================================================================

export interface ILSPFeedbackService {
	readonly _serviceBrand: undefined;

	readonly onDidDetectErrors: Event<DiagnosticSnapshot[]>;
	readonly onDidAutoFix: Event<AutoFixResult>;

	/** 收集指定文件的诊断信息 */
	getDiagnostics(uri: URI): DiagnosticSnapshot;

	/** 收集工作区所有文件的错误 */
	getWorkspaceDiagnostics(): DiagnosticSnapshot[];

	/** 构建失忆代理上下文（仅含本轮所需的精确信息） */
	buildAmnesicContext(
		affectedUris: URI[],
		successCriteria: string[],
		progressLog?: string,
	): Promise<AmnesicContext>;

	/** 执行自修复循环：检测错误 → LLM 修复 → 再验证 */
	runAutoFixLoop(
		targetUris: URI[],
		maxIterations?: number,
		taskId?: string,
	): Promise<AutoFixResult>;

	/** 监控指定文件的诊断变化 */
	watchFiles(uris: URI[]): void;

	/** 停止监控 */
	unwatchAll(): void;
}

// ============================================================================
// 实现
// ============================================================================

export class LSPFeedbackService extends Disposable implements ILSPFeedbackService {
	readonly _serviceBrand: undefined;

	private readonly watchedFiles = new Set<string>();
	private readonly _onDidDetectErrors = this._register(new Emitter<DiagnosticSnapshot[]>());
	readonly onDidDetectErrors = this._onDidDetectErrors.event;

	private readonly _onDidAutoFix = this._register(new Emitter<AutoFixResult>());
	readonly onDidAutoFix = this._onDidAutoFix.event;

	private readonly API_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

	constructor(
		@ILogService private readonly logService: ILogService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ICheckpointService private readonly checkpointService: ICheckpointService,
		@ITreeSitterService private readonly treeSitter: ITreeSitterService,
	) {
		super();

		this._register(this.markerService.onMarkerChanged(uris => {
			const snapshots: DiagnosticSnapshot[] = [];
			for (const uri of uris) {
				if (this.watchedFiles.has(uri.toString())) {
					const snap = this.getDiagnostics(uri);
					if (snap.errors.length > 0) {
						snapshots.push(snap);
					}
				}
			}
			if (snapshots.length > 0) {
				this._onDidDetectErrors.fire(snapshots);
			}
		}));
	}

	// ========================================================================
	// 诊断收集
	// ========================================================================

	getDiagnostics(uri: URI): DiagnosticSnapshot {
		const markers = this.markerService.read({ resource: uri });
		const errors: DiagnosticEntry[] = [];
		const warnings: DiagnosticEntry[] = [];

		for (const marker of markers) {
			const entry = this.markerToEntry(marker);
			if (marker.severity === MarkerSeverity.Error) {
				errors.push(entry);
			} else if (marker.severity === MarkerSeverity.Warning) {
				warnings.push(entry);
			}
		}

		return {
			uri: uri.toString(),
			path: uri.fsPath,
			errors,
			warnings,
			timestamp: Date.now(),
		};
	}

	getWorkspaceDiagnostics(): DiagnosticSnapshot[] {
		const snapshots: DiagnosticSnapshot[] = [];
		const allMarkers = this.markerService.read({});
		const byUri = new Map<string, IMarker[]>();

		for (const marker of allMarkers) {
			if (marker.severity !== MarkerSeverity.Error && marker.severity !== MarkerSeverity.Warning) {
				continue;
			}
			const key = marker.resource.toString();
			const list = byUri.get(key) || [];
			list.push(marker);
			byUri.set(key, list);
		}

		for (const [uriStr, markers] of byUri) {
			const errors: DiagnosticEntry[] = [];
			const warnings: DiagnosticEntry[] = [];

			for (const m of markers) {
				const entry = this.markerToEntry(m);
				if (m.severity === MarkerSeverity.Error) {
					errors.push(entry);
				} else {
					warnings.push(entry);
				}
			}

			if (errors.length > 0 || warnings.length > 0) {
				snapshots.push({
					uri: uriStr,
					path: URI.parse(uriStr).fsPath,
					errors,
					warnings,
					timestamp: Date.now(),
				});
			}
		}

		return snapshots;
	}

	private markerToEntry(marker: IMarker): DiagnosticEntry {
		return {
			message: marker.message,
			severity: marker.severity === MarkerSeverity.Error ? 'error'
				: marker.severity === MarkerSeverity.Warning ? 'warning' : 'info',
			startLine: marker.startLineNumber,
			startColumn: marker.startColumn,
			endLine: marker.endLineNumber,
			endColumn: marker.endColumn,
			source: marker.source,
			code: typeof marker.code === 'string' ? marker.code
				: typeof marker.code === 'object' && marker.code ? String(marker.code.value) : undefined,
		};
	}

	// ========================================================================
	// 失忆代理上下文（Amnesic Agent Protocol）
	// ========================================================================

	async buildAmnesicContext(
		affectedUris: URI[],
		successCriteria: string[],
		progressLog?: string,
	): Promise<AmnesicContext> {
		const affectedFiles: AmnesicContext['affectedFiles'] = [];

		for (const uri of affectedUris) {
			try {
				const content = (await this.fileService.readFile(uri)).value.toString();
				const diag = this.getDiagnostics(uri);

				// Rust Body 层：注入 Tree-sitter AST 快照
				let astSummary: string | undefined;
				try {
					astSummary = await this.treeSitter.getASTSummary(uri);
				} catch {
					// AST 不可用时降级为纯文本
				}

				affectedFiles.push({
					path: uri.fsPath,
					content: this.truncateContent(content, 5000),
					diagnostics: [...diag.errors, ...diag.warnings],
					astSummary,
				});
			} catch {
				// 文件可能不存在
			}
		}

		return {
			affectedFiles,
			progressLog: progressLog || '',
			successCriteria,
			iteration: 0,
		};
	}

	/**
	 * 将失忆上下文序列化为 System Prompt 片段（精确注入）
	 */
	static formatAmnesicPrompt(ctx: AmnesicContext): string {
		let prompt = `## Amnesic Agent Context (Iteration ${ctx.iteration + 1})\n\n`;

		prompt += `### SUCCESS_CRITERIA\n`;
		for (const c of ctx.successCriteria) {
			prompt += `- [ ] ${c}\n`;
		}
		prompt += `\n`;

		if (ctx.progressLog) {
			prompt += `### PROGRESS.log\n\`\`\`\n${ctx.progressLog}\n\`\`\`\n\n`;
		}

		if (ctx.previousErrors) {
			prompt += `### Previous Errors (must fix)\n\`\`\`\n${ctx.previousErrors}\n\`\`\`\n\n`;
		}

		for (const file of ctx.affectedFiles) {
			prompt += `### File: ${file.path}\n`;

			if (file.astSummary) {
				prompt += `**AST Snapshot (Tree-sitter):**\n${file.astSummary}\n\n`;
			}

			if (file.diagnostics.length > 0) {
				prompt += `**Diagnostics:**\n`;
				for (const d of file.diagnostics) {
					prompt += `- [${d.severity.toUpperCase()}] L${d.startLine}: ${d.message}\n`;
				}
				prompt += `\n`;
			}

			prompt += `\`\`\`\n${file.content}\n\`\`\`\n\n`;
		}

		return prompt;
	}

	// ========================================================================
	// 自修复循环
	// ========================================================================

	async runAutoFixLoop(
		targetUris: URI[],
		maxIterations: number = 3,
		taskId?: string,
	): Promise<AutoFixResult> {
		this.logService.info(`[LSPFeedbackService] Starting auto-fix loop for ${targetUris.length} files`);

		// 创建修复前检查点
		if (taskId) {
			await this.checkpointService.createCheckpoint(
				`Auto-fix: pre-fix checkpoint`,
				taskId,
				CheckpointType.PreTask,
			);
		}

		let totalFixed = 0;

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			// 收集当前诊断
			const diagnostics: DiagnosticSnapshot[] = [];
			for (const uri of targetUris) {
				const snap = this.getDiagnostics(uri);
				if (snap.errors.length > 0) {
					diagnostics.push(snap);
				}
			}

			if (diagnostics.length === 0) {
				this.logService.info(`[LSPFeedbackService] All errors fixed after ${iteration} iterations`);
				const result: AutoFixResult = {
					fixed: totalFixed,
					remaining: 0,
					iterations: iteration,
					success: true,
				};
				this._onDidAutoFix.fire(result);
				return result;
			}

			this.logService.info(
				`[LSPFeedbackService] Iteration ${iteration + 1}: ` +
				`${diagnostics.reduce((s, d) => s + d.errors.length, 0)} errors in ${diagnostics.length} files`
			);

			// 构建失忆上下文
			const ctx = await this.buildAmnesicContext(
				targetUris,
				['All compilation errors must be fixed', 'No regressions in existing tests'],
			);
			ctx.iteration = iteration;

			if (iteration > 0) {
				ctx.previousErrors = diagnostics
					.flatMap(d => d.errors)
					.map(e => `${e.message} (L${e.startLine})`)
					.join('\n');
			}

			// 调用 LLM 修复
			const errorsBefore = diagnostics.reduce((s, d) => s + d.errors.length, 0);
			await this.requestFix(ctx);

			// 等待 LSP 更新诊断（短暂延迟）
			await new Promise(resolve => setTimeout(resolve, 2000));

			// 统计修复结果
			let errorsAfter = 0;
			for (const uri of targetUris) {
				const snap = this.getDiagnostics(uri);
				errorsAfter += snap.errors.length;
			}

			const fixed = errorsBefore - errorsAfter;
			totalFixed += Math.max(0, fixed);

			if (fixed <= 0) {
				this.logService.warn('[LSPFeedbackService] No progress, stopping auto-fix');
				break;
			}
		}

		// 最终统计
		let remaining = 0;
		for (const uri of targetUris) {
			remaining += this.getDiagnostics(uri).errors.length;
		}

		const result: AutoFixResult = {
			fixed: totalFixed,
			remaining,
			iterations: maxIterations,
			success: remaining === 0,
		};

		this._onDidAutoFix.fire(result);
		return result;
	}

	private async requestFix(ctx: AmnesicContext): Promise<void> {
		const prompt = LSPFeedbackService.formatAmnesicPrompt(ctx);

		const systemPrompt = `You are a code repair agent operating under the Amnesic Agent Protocol.
Your context has been reset. You only see the affected files and their diagnostics.

RULES:
1. Fix ALL compilation errors listed in diagnostics.
2. Do NOT introduce new errors.
3. Output ONLY the corrected file content in fenced code blocks with the file path.
4. Do NOT explain your changes.

Format:
\`\`\`filepath:/path/to/file.ts
corrected content here
\`\`\``;

		try {
			const response = await this.callLLM(systemPrompt, prompt);
			await this.applyFixes(response);
		} catch (error) {
			this.logService.error(`[LSPFeedbackService] Fix request failed: ${String(error)}`);
		}
	}

	private async applyFixes(llmResponse: string): Promise<void> {
		const fileBlockRegex = /```filepath:(.+?)\n([\s\S]*?)```/g;
		let match;

		while ((match = fileBlockRegex.exec(llmResponse)) !== null) {
			const filePath = match[1].trim();
			const content = match[2];

			try {
			const folders = this.workspaceService.getWorkspace().folders;
			if (folders.length === 0) {
				continue;
			}

				const fileUri = filePath.startsWith('/')
					? URI.file(filePath)
					: URI.joinPath(folders[0].uri, filePath);

				const { VSBuffer } = await import('../../../../base/common/buffer.js');
				await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
				this.checkpointService.trackFile(fileUri);

				this.logService.info(`[LSPFeedbackService] Applied fix to ${filePath}`);
			} catch (error) {
				this.logService.error(`[LSPFeedbackService] Failed to apply fix to ${filePath}: ${String(error)}`);
			}
		}
	}

	// ========================================================================
	// 文件监控
	// ========================================================================

	watchFiles(uris: URI[]): void {
		for (const uri of uris) {
			this.watchedFiles.add(uri.toString());
		}
	}

	unwatchAll(): void {
		this.watchedFiles.clear();
	}

	// ========================================================================
	// 工具方法
	// ========================================================================

	private truncateContent(content: string, maxLength: number): string {
		if (content.length <= maxLength) {
			return content;
		}
		const half = Math.floor(maxLength / 2);
		return content.substring(0, half) + '\n// ... truncated ...\n' + content.substring(content.length - half);
	}

	private getApiKey(): string {
		return '20cca2b90c8c4348aaab3d4f6814c33b.Ow4WJfqfc06uB4KI';
	}

	private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
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
					model: 'glm-5.1',
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					temperature: 0.1,
					max_tokens: 8192,
					stream: true,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			if (!response.ok) {
				throw new Error(`API error: ${response.status}`);
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('No response body');
			}

			const decoder = new TextDecoder();
			let content = '';
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) {
						continue;
					}
					const data = line.slice(6).trim();
					if (data === '[DONE]') {
						continue;
					}
					try {
						const parsed = JSON.parse(data);
						const delta = parsed.choices?.[0]?.delta?.content;
						if (delta) {
							content += delta;
						}
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

registerSingleton(ILSPFeedbackService, LSPFeedbackService, InstantiationType.Delayed);
