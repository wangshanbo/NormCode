/*---------------------------------------------------------------------------------------------
 *  多根工作区：为 npm / 验证门 / CSO 选择「最可能含目标工程」的工作区文件夹
 *--------------------------------------------------------------------------------------------*/

import { isEqual } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';

const DEFAULT_NPM_PROBES = ['package.json', 'index.html', 'public/index.html'];

export type SentinelRootPickLog = {
	info(message: string): void;
	warn(message: string): void;
};

/**
 * 多根工作区：按 `probeRelativePaths` 在各文件夹下可读文件数打分，返回最佳文件夹。
 * 单根时直接返回；`probes` 会先规范化（去绝对路径、去重、截断）。
 */
export async function pickWorkspaceFolderByProbes(
	folders: readonly IWorkspaceFolder[],
	fileService: IFileService,
	probeRelativePaths: readonly string[],
	maxProbes: number,
	log: SentinelRootPickLog,
	logScope: string,
): Promise<IWorkspaceFolder | undefined> {
	if (folders.length === 0) {
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0];
	}
	let probes = Array.from(
		new Set(probeRelativePaths.filter(p => p && !p.startsWith('/'))),
	).slice(0, Math.max(1, maxProbes));
	if (probes.length === 0) {
		probes = ['package.json'];
	}
	let bestUri = folders[0]!.uri;
	let bestScore = -1;
	for (const folder of folders) {
		let score = 0;
		for (const rel of probes) {
			try {
				await fileService.readFile(URI.joinPath(folder.uri, rel));
				score++;
			} catch {
				// unreadable
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestUri = folder.uri;
		}
	}
	if (bestScore === 0) {
		log.warn(
			`${logScope} 多根工作区未命中探测文件（${probes.slice(0, 4).join(', ')}），使用第一个文件夹。`,
		);
	} else {
		log.info(`${logScope} 多根工作区选用命中 ${bestScore}/${probes.length} 个探测路径的文件夹`);
	}
	return folders.find(f => isEqual(f.uri, bestUri));
}

/**
 * 在多个工作区文件夹中选出用于执行 `npm run build` / lint / test 的根（与 CSO 探测策略对齐）。
 */
export async function pickWorkspaceFolderForNpmScripts(
	folders: readonly IWorkspaceFolder[],
	fileService: IFileService,
	extraRelativeProbes: readonly string[],
	log: SentinelRootPickLog,
): Promise<IWorkspaceFolder | undefined> {
	const relSet = new Set<string>([
		...DEFAULT_NPM_PROBES,
		...extraRelativeProbes.filter(p => p && !p.startsWith('/')),
	]);
	const probes = Array.from(relSet).slice(0, 10);
	const list = probes.length > 0 ? probes : ['package.json'];
	return pickWorkspaceFolderByProbes(folders, fileService, list, 10, log, '[Sentinel] 验证/npm');
}
