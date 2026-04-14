/*---------------------------------------------------------------------------------------------
 *  Sentinel Materializer Service
 *  从 LLM 产出的工件中提取 diff/代码并物化到文件系统
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { MaterializationResult, PatchOperation, PatchPlan, ProjectionArtifact } from '../common/projectionTypes.js';

export const IMaterializerService = createDecorator<IMaterializerService>('IMaterializerService');

export interface IMaterializerService {
	readonly _serviceBrand: undefined;
	materialize(intent: Intent, node: ExecutionNode, artifacts: ProjectionArtifact[]): MaterializationResult;
	applyPatchPlan(patchPlan: PatchPlan): Promise<{ applied: number; failed: number; errors: string[] }>;
	getHistory(): MaterializationResult[];
}

export class MaterializerService extends Disposable implements IMaterializerService {
	readonly _serviceBrand: undefined;

	private readonly history: MaterializationResult[] = [];

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	materialize(intent: Intent, node: ExecutionNode, artifacts: ProjectionArtifact[]): MaterializationResult {
		const operations = this.extractOperations(intent, node, artifacts);

		const patchPlan: PatchPlan = {
			id: `patch_plan_${Date.now()}_${node.id}`,
			intentId: intent.id,
			nodeId: node.id,
			operations,
			rationale: '根据意图约束与工件投影生成的结构化 Patch 计划。',
			createdAt: Date.now(),
		};

		const result: MaterializationResult = {
			artifactIds: artifacts.map(item => item.id),
			patchPlan,
			summary: operations.length > 0
				? `已为 ${artifacts.length} 个工件生成 ${operations.length} 个文件操作。`
				: `已为 ${artifacts.length} 个工件生成 Patch 计划（无具体文件变更）。`,
		};

		this.history.push(result);
		this.logService.info(`[Sentinel Materializer] Generated patch plan with ${operations.length} operations`);

		return result;
	}

	async applyPatchPlan(patchPlan: PatchPlan): Promise<{ applied: number; failed: number; errors: string[] }> {
		let applied = 0;
		let failed = 0;
		const errors: string[] = [];

		for (const op of patchPlan.operations) {
			try {
				const uri = this.resolveFileUri(op.filePath);
				if (!uri) {
					errors.push(`无法解析文件路径: ${op.filePath}`);
					failed++;
					continue;
				}

				switch (op.kind) {
					case 'create': {
						if (op.newContent) {
							await this.fileService.writeFile(uri, VSBuffer.fromString(op.newContent));
							applied++;
							this.logService.info(`[Sentinel Materializer] Created: ${op.filePath}`);
						}
						break;
					}
					case 'update': {
						if (op.newContent) {
							await this.fileService.writeFile(uri, VSBuffer.fromString(op.newContent));
							applied++;
							this.logService.info(`[Sentinel Materializer] Updated: ${op.filePath}`);
						} else if (op.diff) {
							const existing = await this.fileService.readFile(uri);
							const patched = this.applyUnifiedDiff(existing.value.toString(), op.diff);
							if (patched !== null) {
								await this.fileService.writeFile(uri, VSBuffer.fromString(patched));
								applied++;
								this.logService.info(`[Sentinel Materializer] Patched: ${op.filePath}`);
							} else {
								errors.push(`diff 应用失败: ${op.filePath}`);
								failed++;
							}
						}
						break;
					}
					case 'delete': {
						await this.fileService.del(uri);
						applied++;
						this.logService.info(`[Sentinel Materializer] Deleted: ${op.filePath}`);
						break;
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${op.filePath}: ${message}`);
				failed++;
				this.logService.error(`[Sentinel Materializer] Failed to apply operation on ${op.filePath}: ${message}`);
			}
		}

		return { applied, failed, errors };
	}

	getHistory(): MaterializationResult[] {
		return [...this.history];
	}

	private extractOperations(intent: Intent, node: ExecutionNode, artifacts: ProjectionArtifact[]): PatchOperation[] {
		const operations: PatchOperation[] = [];

		for (const artifact of artifacts) {
			if (!artifact.content) {
				continue;
			}

			const diffs = this.extractDiffBlocks(artifact.content);
			if (diffs.length > 0) {
				for (const diff of diffs) {
					operations.push({
						filePath: diff.filePath || artifact.location || 'unknown',
						kind: 'update',
						diff: diff.content,
						summary: `${node.title}: ${artifact.summary?.slice(0, 100) || 'diff patch'}`,
					});
				}
				continue;
			}

			const codeBlocks = this.extractCodeBlocks(artifact.content);
			if (codeBlocks.length > 0) {
				for (const block of codeBlocks) {
					operations.push({
						filePath: block.filePath || artifact.location || 'unknown',
						kind: 'update',
						newContent: block.content,
						summary: `${node.title}: ${block.language || 'code'} block`,
					});
				}
				continue;
			}

			if (intent.intentCard.allowedFiles.length > 0) {
				operations.push({
					filePath: intent.intentCard.allowedFiles[0],
					kind: 'update',
					summary: `${node.title} 预计会影响该工件投影`,
				});
			}
		}

		return operations;
	}

	private extractDiffBlocks(content: string): Array<{ filePath?: string; content: string }> {
		const diffRegex = /```diff\s*\n([\s\S]*?)```/g;
		const results: Array<{ filePath?: string; content: string }> = [];
		let match: RegExpExecArray | null;

		while ((match = diffRegex.exec(content)) !== null) {
			const diffContent = match[1].trim();
			const filePathMatch = diffContent.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(?:\s|$)/m);
			results.push({
				filePath: filePathMatch?.[1],
				content: diffContent,
			});
		}

		return results;
	}

	private extractCodeBlocks(content: string): Array<{ filePath?: string; language?: string; content: string }> {
		const codeRegex = /```(\w+)?\s*\n([\s\S]*?)```/g;
		const results: Array<{ filePath?: string; language?: string; content: string }> = [];
		let match: RegExpExecArray | null;

		while ((match = codeRegex.exec(content)) !== null) {
			const language = match[1];
			if (language === 'diff') {
				continue;
			}
			results.push({
				language,
				content: match[2].trim(),
			});
		}

		return results;
	}

	private applyUnifiedDiff(original: string, diff: string): string | null {
		try {
			const lines = original.split('\n');
			const diffLines = diff.split('\n');
			const result = [...lines];
			let offset = 0;

			for (const line of diffLines) {
				if (line.startsWith('@@')) {
					const hunkMatch = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
					if (hunkMatch) {
						offset = parseInt(hunkMatch[1], 10) - 1;
					}
				} else if (line.startsWith('-')) {
					const idx = offset;
					if (idx >= 0 && idx < result.length) {
						result.splice(idx, 1);
					}
				} else if (line.startsWith('+')) {
					result.splice(offset, 0, line.slice(1));
					offset++;
				} else {
					offset++;
				}
			}

			return result.join('\n');
		} catch {
			return null;
		}
	}

	private resolveFileUri(filePath: string): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		const rootUri = folders[0].uri;
		if (filePath.startsWith('/') || filePath.includes('://')) {
			return URI.file(filePath);
		}

		return URI.joinPath(rootUri, filePath);
	}
}

registerSingleton(IMaterializerService, MaterializerService, InstantiationType.Delayed);
