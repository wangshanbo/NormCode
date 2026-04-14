/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

export const ICheckpointService = createDecorator<ICheckpointService>('ICheckpointService');

// ============================================================================
// 检查点数据结构
// ============================================================================

export interface Checkpoint {
	id: string;
	/** 检查点描述（通常是任务标题） */
	label: string;
	/** 关联的任务 ID */
	taskId?: string;
	/** Git commit hash（如果在 Git 仓库中） */
	commitHash?: string;
	/** Git branch name（检查点分支） */
	branchName?: string;
	/** 变更的文件列表 */
	changedFiles: CheckpointFile[];
	/** 创建时间 */
	createdAt: number;
	/** 检查点类型 */
	type: CheckpointType;
	/** 是否已回滚 */
	rolledBack: boolean;
}

export interface CheckpointFile {
	uri: string;
	/** 变更前的内容快照 */
	originalContent?: string;
	/** 变更后的内容快照 */
	modifiedContent?: string;
	/** 变更类型 */
	changeType: 'added' | 'modified' | 'deleted';
}

export enum CheckpointType {
	/** 任务执行前自动创建 */
	PreTask = 'pre_task',
	/** 任务执行后自动创建 */
	PostTask = 'post_task',
	/** 用户手动创建 */
	Manual = 'manual',
	/** 里程碑（多个任务完成后） */
	Milestone = 'milestone',
}

export interface CheckpointDiff {
	checkpointId: string;
	files: Array<{
		path: string;
		changeType: 'added' | 'modified' | 'deleted';
		hunks: DiffHunk[];
	}>;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	content: string;
}

// ============================================================================
// 接口定义
// ============================================================================

export interface ICheckpointService {
	readonly _serviceBrand: undefined;

	readonly onDidCreateCheckpoint: Event<Checkpoint>;
	readonly onDidRollback: Event<Checkpoint>;

	/** 创建检查点（快照当前文件状态） */
	createCheckpoint(label: string, taskId?: string, type?: CheckpointType): Promise<Checkpoint>;

	/** 获取所有检查点 */
	getCheckpoints(): Checkpoint[];

	/** 获取指定检查点 */
	getCheckpoint(id: string): Checkpoint | undefined;

	/** 对比检查点与当前状态 */
	diffCheckpoint(checkpointId: string): Promise<CheckpointDiff>;

	/** 对比两个检查点 */
	diffBetween(fromId: string, toId: string): Promise<CheckpointDiff>;

	/** 回滚到指定检查点 */
	rollbackTo(checkpointId: string): Promise<boolean>;

	/** 清除检查点 */
	clearCheckpoints(): void;

	/** 获取检查点占用的存储大小 */
	getStorageSize(): number;

	/** 注册要监控的文件（Agent 工具修改的文件） */
	trackFile(uri: URI): void;

	/** 获取被追踪的文件列表 */
	getTrackedFiles(): URI[];

	/** 是否有 Git 仓库 */
	isGitAvailable(): boolean;
}

// ============================================================================
// 服务实现
// ============================================================================

export class CheckpointService extends Disposable implements ICheckpointService {
	readonly _serviceBrand: undefined;

	private readonly checkpoints: Checkpoint[] = [];
	private readonly trackedFiles = new Set<string>();
	private readonly fileSnapshots = new Map<string, string>();
	private _gitAvailable: boolean | undefined;

	private readonly _onDidCreateCheckpoint = this._register(new Emitter<Checkpoint>());
	readonly onDidCreateCheckpoint = this._onDidCreateCheckpoint.event;

	private readonly _onDidRollback = this._register(new Emitter<Checkpoint>());
	readonly onDidRollback = this._onDidRollback.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		this.loadCheckpointsFromDisk().catch(() => { /* 启动时静默 */ });
	}

	// ========================================================================
	// 检查点创建
	// ========================================================================

	async createCheckpoint(
		label: string,
		taskId?: string,
		type: CheckpointType = CheckpointType.Manual
	): Promise<Checkpoint> {
		this.logService.info(`[CheckpointService] Creating checkpoint: "${label}"`);

		const changedFiles: CheckpointFile[] = [];

		// 对所有追踪的文件，保存当前内容快照
		for (const uriStr of this.trackedFiles) {
			try {
				const uri = URI.parse(uriStr);
				const content = await this.readFileContent(uri);
				const previousContent = this.fileSnapshots.get(uriStr);

				if (previousContent !== undefined && previousContent !== content) {
					changedFiles.push({
						uri: uriStr,
						originalContent: previousContent,
						modifiedContent: content,
						changeType: 'modified',
					});
				} else if (previousContent === undefined && content !== undefined) {
					changedFiles.push({
						uri: uriStr,
						modifiedContent: content,
						changeType: 'added',
					});
				}

				// 更新快照
				if (content !== undefined) {
					this.fileSnapshots.set(uriStr, content);
				}
			} catch {
				// 文件可能已被删除
				if (this.fileSnapshots.has(uriStr)) {
					changedFiles.push({
						uri: uriStr,
						originalContent: this.fileSnapshots.get(uriStr),
						changeType: 'deleted',
					});
					this.fileSnapshots.delete(uriStr);
				}
			}
		}

		const checkpoint: Checkpoint = {
			id: `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			label,
			taskId,
			changedFiles,
			createdAt: Date.now(),
			type,
			rolledBack: false,
		};

		// 尝试 Git 操作
		if (this.isGitAvailable()) {
			await this.createGitCheckpoint(checkpoint);
		}

		this.checkpoints.push(checkpoint);
		await this.saveCheckpointsToDisk();

		this.logService.info(
			`[CheckpointService] Checkpoint created: ${checkpoint.id}, ` +
			`${changedFiles.length} files changed`
		);

		this._onDidCreateCheckpoint.fire(checkpoint);
		return checkpoint;
	}

	// ========================================================================
	// 检查点查询
	// ========================================================================

	getCheckpoints(): Checkpoint[] {
		return [...this.checkpoints];
	}

	getCheckpoint(id: string): Checkpoint | undefined {
		return this.checkpoints.find(c => c.id === id);
	}

	// ========================================================================
	// Diff 对比
	// ========================================================================

	async diffCheckpoint(checkpointId: string): Promise<CheckpointDiff> {
		const checkpoint = this.getCheckpoint(checkpointId);
		if (!checkpoint) {
			return { checkpointId, files: [] };
		}

		const files: CheckpointDiff['files'] = [];

		for (const cf of checkpoint.changedFiles) {
			const hunks = this.computeDiffHunks(
				cf.originalContent || '',
				cf.modifiedContent || ''
			);

			files.push({
				path: URI.parse(cf.uri).fsPath,
				changeType: cf.changeType,
				hunks,
			});
		}

		return { checkpointId, files };
	}

	async diffBetween(fromId: string, toId: string): Promise<CheckpointDiff> {
		const fromCheckpoint = this.getCheckpoint(fromId);
		const toCheckpoint = this.getCheckpoint(toId);

		if (!fromCheckpoint || !toCheckpoint) {
			return { checkpointId: `${fromId}..${toId}`, files: [] };
		}

		const fromFiles = new Map(fromCheckpoint.changedFiles.map(f => [f.uri, f]));
		const toFiles = new Map(toCheckpoint.changedFiles.map(f => [f.uri, f]));

		const allUris = new Set([...fromFiles.keys(), ...toFiles.keys()]);
		const files: CheckpointDiff['files'] = [];

		for (const uri of allUris) {
			const fromFile = fromFiles.get(uri);
			const toFile = toFiles.get(uri);

			const fromContent = fromFile?.modifiedContent || fromFile?.originalContent || '';
			const toContent = toFile?.modifiedContent || toFile?.originalContent || '';

			if (fromContent !== toContent) {
				const hunks = this.computeDiffHunks(fromContent, toContent);
				files.push({
					path: URI.parse(uri).fsPath,
					changeType: !fromFile ? 'added' : !toFile ? 'deleted' : 'modified',
					hunks,
				});
			}
		}

		return { checkpointId: `${fromId}..${toId}`, files };
	}

	/**
	 * 简单的行级 diff 算法
	 */
	private computeDiffHunks(oldText: string, newText: string): DiffHunk[] {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const hunks: DiffHunk[] = [];

		let i = 0, j = 0;
		while (i < oldLines.length || j < newLines.length) {
			// 跳过相同行
			while (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
				i++;
				j++;
			}

			if (i >= oldLines.length && j >= newLines.length) {
				break;
			}

			// 找到差异段
			const hunkStart = { old: i + 1, new: j + 1 };
			let hunkContent = '';

			while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
				hunkContent += `-${oldLines[i]}\n`;
				i++;
			}
			while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
				hunkContent += `+${newLines[j]}\n`;
				j++;
			}

			if (hunkContent) {
				hunks.push({
					oldStart: hunkStart.old,
					oldLines: i - hunkStart.old + 1,
					newStart: hunkStart.new,
					newLines: j - hunkStart.new + 1,
					content: hunkContent,
				});
			}
		}

		return hunks;
	}

	// ========================================================================
	// 回滚
	// ========================================================================

	async rollbackTo(checkpointId: string): Promise<boolean> {
		const checkpointIndex = this.checkpoints.findIndex(c => c.id === checkpointId);
		if (checkpointIndex < 0) {
			this.logService.error(`[CheckpointService] Checkpoint not found: ${checkpointId}`);
			return false;
		}

		const checkpoint = this.checkpoints[checkpointIndex];

		this.logService.info(`[CheckpointService] Rolling back to checkpoint: ${checkpoint.label}`);

		try {
			// 收集从该检查点之后的所有变更文件
			const laterCheckpoints = this.checkpoints.slice(checkpointIndex + 1);
			const filesToRestore = new Map<string, string>();

			// 目标：恢复到检查点时刻的文件状态
			// 该检查点的 originalContent 就是变更前的状态
			for (const cp of [checkpoint, ...laterCheckpoints]) {
				for (const cf of cp.changedFiles) {
					if (!filesToRestore.has(cf.uri)) {
						// 使用检查点的 originalContent（变更前状态）
						if (cf.originalContent !== undefined) {
							filesToRestore.set(cf.uri, cf.originalContent);
						}
					}
				}
			}

			// 恢复文件
			for (const [uriStr, content] of filesToRestore) {
				try {
					const uri = URI.parse(uriStr);
					await this.fileService.writeFile(uri, VSBuffer.fromString(content));
					this.fileSnapshots.set(uriStr, content);
				} catch (err) {
					this.logService.error(`[CheckpointService] Failed to restore file ${uriStr}: ${String(err)}`);
				}
			}

			// 标记后续检查点为已回滚
			for (const cp of laterCheckpoints) {
				cp.rolledBack = true;
			}
			checkpoint.rolledBack = true;

			await this.saveCheckpointsToDisk();
			this._onDidRollback.fire(checkpoint);

			this.logService.info(`[CheckpointService] Rollback complete: restored ${filesToRestore.size} files`);
			return true;

		} catch (error) {
			this.logService.error(`[CheckpointService] Rollback failed: ${String(error)}`);
			return false;
		}
	}

	// ========================================================================
	// 文件追踪
	// ========================================================================

	trackFile(uri: URI): void {
		const uriStr = uri.toString();
		if (!this.trackedFiles.has(uriStr)) {
			this.trackedFiles.add(uriStr);

			// 立即读取当前内容作为初始快照
			this.readFileContent(uri).then(content => {
				if (content !== undefined) {
					this.fileSnapshots.set(uriStr, content);
				}
			}).catch(() => { /* 文件可能不存在 */ });
		}
	}

	getTrackedFiles(): URI[] {
		return Array.from(this.trackedFiles).map(s => URI.parse(s));
	}

	// ========================================================================
	// Git 集成
	// ========================================================================

	isGitAvailable(): boolean {
		if (this._gitAvailable === undefined) {
			const folders = this.workspaceService.getWorkspace().folders;
			if (folders.length === 0) {
				this._gitAvailable = false;
			} else {
				// 检查 .git 目录是否存在
				const gitUri = URI.joinPath(folders[0].uri, '.git');
				this.fileService.exists(gitUri).then(exists => {
					this._gitAvailable = exists;
				}).catch(() => {
					this._gitAvailable = false;
				});
				// 首次返回 false，后续更新
				this._gitAvailable = false;
			}
		}
		return this._gitAvailable;
	}

	private async createGitCheckpoint(checkpoint: Checkpoint): Promise<void> {
		// Git 操作通过 stash 或 lightweight tag 实现
		// 这里只记录元数据，实际 Git 操作需要通过 terminal service 执行
		checkpoint.branchName = `checkpoint/${checkpoint.id}`;
		this.logService.trace(`[CheckpointService] Git checkpoint metadata set: ${checkpoint.branchName}`);
	}

	// ========================================================================
	// 持久化
	// ========================================================================

	private async saveCheckpointsToDisk(): Promise<void> {
		const folder = this.getCheckpointFolder();
		if (!folder) {
			return;
		}

		try {
			await this.fileService.createFolder(folder);

			const data = {
				version: 1,
				checkpoints: this.checkpoints.map(cp => ({
					...cp,
					// 限制快照内容大小，避免占用过多磁盘
					changedFiles: cp.changedFiles.map(cf => ({
						...cf,
						originalContent: cf.originalContent?.substring(0, 100000),
						modifiedContent: cf.modifiedContent?.substring(0, 100000),
					})),
				})),
			};

			const fileUri = URI.joinPath(folder, 'checkpoints.json');
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
		} catch (error) {
			this.logService.error(`[CheckpointService] Failed to save checkpoints: ${String(error)}`);
		}
	}

	private async loadCheckpointsFromDisk(): Promise<void> {
		const folder = this.getCheckpointFolder();
		if (!folder) {
			return;
		}

		const fileUri = URI.joinPath(folder, 'checkpoints.json');
		try {
			const exists = await this.fileService.exists(fileUri);
			if (!exists) {
				return;
			}

			const content = (await this.fileService.readFile(fileUri)).value.toString();
			const data = JSON.parse(content);

			if (data.checkpoints && Array.isArray(data.checkpoints)) {
				this.checkpoints.length = 0;
				this.checkpoints.push(...data.checkpoints);
				this.logService.info(`[CheckpointService] Loaded ${this.checkpoints.length} checkpoints from disk`);
			}
		} catch (error) {
			this.logService.warn(`[CheckpointService] Failed to load checkpoints: ${String(error)}`);
		}
	}

	private getCheckpointFolder(): URI | undefined {
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return URI.joinPath(folders[0].uri, '.aicore', 'checkpoints');
	}

	// ========================================================================
	// 工具方法
	// ========================================================================

	private async readFileContent(uri: URI): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	clearCheckpoints(): void {
		this.checkpoints.length = 0;
		this.fileSnapshots.clear();
		this.trackedFiles.clear();
	}

	getStorageSize(): number {
		let size = 0;
		for (const cp of this.checkpoints) {
			for (const cf of cp.changedFiles) {
				size += (cf.originalContent?.length || 0) + (cf.modifiedContent?.length || 0);
			}
		}
		return size;
	}
}

registerSingleton(ICheckpointService, CheckpointService, InstantiationType.Delayed);
