/*---------------------------------------------------------------------------------------------
 *  跨端 IR 快照：package.json、源码路径列表、路由/API 启发式线索 → `.sentinel/cross-platform-ir.json`
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { basename, joinPath, relativePath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CrossPlatformIrSnapshot } from '../common/crossPlatformExportTypes.js';

export const ICrossPlatformIrSnapshotService = createDecorator<ICrossPlatformIrSnapshotService>('crossPlatformIrSnapshotService');

export interface ICrossPlatformIrSnapshotService {
	readonly _serviceBrand: undefined;
	takeSnapshotAndSave(): Promise<CrossPlatformIrSnapshot | undefined>;
	loadSnapshot(): Promise<CrossPlatformIrSnapshot | undefined>;
}

const IR_FILE = 'cross-platform-ir.json';
const MAX_FILES = 280;
const MAX_FILE_READ = 140_000;
const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '.sentinel', 'exports', 'coverage', '.vite',
	'__pycache__', '.next', '.nuxt',
]);

export class CrossPlatformIrSnapshotService extends Disposable implements ICrossPlatformIrSnapshotService {
	readonly _serviceBrand: undefined;

	constructor(
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private get root(): URI | undefined {
		return this.workspaceContext.getWorkspace().folders[0]?.uri;
	}

	async loadSnapshot(): Promise<CrossPlatformIrSnapshot | undefined> {
		const r = this.root;
		if (!r) {
			return undefined;
		}
		const uri = joinPath(r, '.sentinel', IR_FILE);
		try {
			const file = await this.fileService.readFile(uri);
			return JSON.parse(file.value.toString()) as CrossPlatformIrSnapshot;
		} catch {
			return undefined;
		}
	}

	async takeSnapshotAndSave(): Promise<CrossPlatformIrSnapshot | undefined> {
		const r = this.root;
		if (!r) {
			return undefined;
		}
		const folderName = basename(r) || 'workspace';

		let packageJson: Record<string, unknown> | null = null;
		let packageName = '';
		try {
			const pj = await this.fileService.readFile(joinPath(r, 'package.json'));
			packageJson = JSON.parse(pj.value.toString()) as Record<string, unknown>;
			packageName = String(packageJson.name ?? '');
		} catch {
			packageJson = null;
		}

		const sourceFiles: string[] = [];
		await this.collectSourceFiles(r, r, sourceFiles, 0, 6);

		const routeHints = new Set<string>();
		const apiHints = new Set<string>();
		await this.extractHints(r, routeHints, apiHints);

		const snapshot: CrossPlatformIrSnapshot = {
			irVersion: 1,
			takenAt: new Date().toISOString(),
			workspaceFolderName: folderName,
			packageJson,
			packageName,
			sourceFiles: sourceFiles.slice(0, MAX_FILES),
			routeHints: [...routeHints].slice(0, 80),
			apiBaseHints: [...apiHints].slice(0, 40),
		};

		const dir = joinPath(r, '.sentinel');
		await this.fileService.createFolder(dir).catch(() => undefined);
		await this.fileService.writeFile(
			joinPath(dir, IR_FILE),
			VSBuffer.fromString(JSON.stringify(snapshot, null, 2)),
		);
		this.logService.info(`[CrossPlatformIR] Snapshot saved: ${sourceFiles.length} files, ${routeHints.size} route hints`);
		return snapshot;
	}

	private async collectSourceFiles(workspaceRoot: URI, dir: URI, out: string[], depth: number, maxDepth: number): Promise<void> {
		if (out.length >= MAX_FILES || depth > maxDepth) {
			return;
		}
		let stat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			return;
		}
		if (!stat.isDirectory) {
			const rel = relativePath(workspaceRoot, dir);
			if (rel && /\.(tsx?|jsx?|vue|css|less|scss|json|html)$/i.test(rel)) {
				out.push(rel);
			}
			return;
		}
		for (const c of stat.children ?? []) {
			const name = basename(c.resource);
			if (SKIP_DIRS.has(name)) {
				continue;
			}
			if (c.isDirectory) {
				await this.collectSourceFiles(workspaceRoot, c.resource, out, depth + 1, maxDepth);
			} else {
				const rel = relativePath(workspaceRoot, c.resource);
				if (rel && /\.(tsx?|jsx?|vue|css|less|scss|json|html)$/i.test(rel)) {
					out.push(rel);
				}
			}
		}
	}

	private async extractHints(workspaceRoot: URI, routes: Set<string>, apis: Set<string>): Promise<void> {
		const candidates = [
			'src/App.tsx', 'src/App.vue', 'src/main.tsx', 'src/main.ts', 'src/router/index.ts',
			'src/routes.tsx', 'vite.config.ts', 'index.html',
		];
		let budget = MAX_FILE_READ;
		for (const rel of candidates) {
			if (budget <= 0) {
				break;
			}
			try {
				const uri = joinPath(workspaceRoot, rel);
				const file = await this.fileService.readFile(uri);
				const text = file.value.toString();
				budget -= text.length;
				this.scanRoutes(text, routes);
				this.scanApis(text, apis);
			} catch {
				// ignore
			}
		}
	}

	private scanRoutes(text: string, routes: Set<string>): void {
		const reList = [
			/path:\s*['"]([^'"]+)['"]/gi,
			/<Route[^>]+path=['"]([^'"]+)['"]/gi,
			/path:\s*`([^`]+)`/gi,
		];
		for (const re of reList) {
			let m: RegExpExecArray | null;
			const r = new RegExp(re.source, re.flags);
			while ((m = r.exec(text)) !== null) {
				const p = m[1]?.trim();
				if (p && p.length < 200 && !p.includes('${')) {
					routes.add(p);
				}
			}
		}
	}

	private scanApis(text: string, apis: Set<string>): void {
		const reList = [
			/fetch\(\s*['"]([^'"]+)['"]/gi,
			/axios\.(?:get|post)\(\s*['"]([^'"]+)['"]/gi,
			/baseURL:\s*['"]([^'"]+)['"]/gi,
			/process\.env\.(VITE_\w+)/g,
		];
		for (const re of reList) {
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				const p = m[1]?.trim();
				if (p) {
					apis.add(p);
				}
			}
		}
	}
}

registerSingleton(ICrossPlatformIrSnapshotService, CrossPlatformIrSnapshotService, InstantiationType.Delayed);
