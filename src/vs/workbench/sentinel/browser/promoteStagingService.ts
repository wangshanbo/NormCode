/*---------------------------------------------------------------------------------------------
 *  Sentinel Promote — Shadow VFS → 工作区真实路径（M1 P4-1）
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import * as resources from '../../../base/common/resources.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { getSentinelStagingRootUri } from '../common/sentinelStagingScheme.js';

export const ISentinelPromoteService = createDecorator<ISentinelPromoteService>('ISentinelPromoteService');

export interface PromoteResult {
	copied: number;
	skipped: number;
	paths: string[];
	errors: string[];
}

export interface ISentinelPromoteService {
	readonly _serviceBrand: undefined;
	/** 将 sentinel-staging:///workspace/** 下文件写入工作区根目录下相对路径 */
	promoteAll(allowedPathPrefixes: string[]): Promise<PromoteResult>;
}

export class SentinelPromoteService extends Disposable implements ISentinelPromoteService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async promoteAll(allowedPathPrefixes: string[]): Promise<PromoteResult> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		const stagingRoot = getSentinelStagingRootUri();
		if (!root) {
			return { copied: 0, skipped: 0, paths: [], errors: ['无工作区根目录'] };
		}

		const files: Array<{ rel: string; uri: URI }> = [];
		try {
			await this.collectFiles(stagingRoot, '', files);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { copied: 0, skipped: 0, paths: [], errors: [`枚举 Shadow 失败: ${msg}`] };
		}

		let copied = 0;
		let skipped = 0;
		const paths: string[] = [];
		const errors: string[] = [];

		const allow = (rel: string): boolean => {
			if (!allowedPathPrefixes || allowedPathPrefixes.length === 0) {
				return true;
			}
			const norm = rel.replace(/\\/g, '/');
			return allowedPathPrefixes.some(p => {
				const pre = p.replace(/\\/g, '/').replace(/\/$/, '');
				return norm === pre || norm.startsWith(pre + '/');
			});
		};

		for (const { rel, uri } of files) {
			if (!rel || rel === '.') {
				continue;
			}
			if (!allow(rel)) {
				skipped++;
				this.logService.info(`[Sentinel Promote] 跳过非白名单: ${rel}`);
				continue;
			}
			const target = URI.joinPath(root, rel);
			try {
				const content = await this.fileService.readFile(uri);
				await this.ensureParent(target);
				await this.fileService.writeFile(target, content.value);
				copied++;
				paths.push(rel);
				this.logService.info(`[Sentinel Promote] ${rel}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				errors.push(`${rel}: ${msg}`);
			}
		}

		return { copied, skipped, paths, errors };
	}

	private async collectFiles(dir: URI, prefix: string, out: Array<{ rel: string; uri: URI }>): Promise<void> {
		const stat = await this.fileService.resolve(dir);
		if (!stat.children) {
			return;
		}
		for (const child of stat.children) {
			const name = child.name;
			const rel = prefix ? `${prefix}/${name}` : name;
			if (child.isDirectory) {
				await this.collectFiles(child.resource, rel, out);
			} else if (child.isFile) {
				out.push({ rel, uri: child.resource });
			}
		}
	}

	private async ensureParent(file: URI): Promise<void> {
		const parent = resources.dirname(file);
		try {
			await this.fileService.createFolder(parent);
		} catch {
			// exists
		}
	}
}

registerSingleton(ISentinelPromoteService, SentinelPromoteService, InstantiationType.Delayed);
