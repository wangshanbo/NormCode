/*---------------------------------------------------------------------------------------------
 *  Behavioral Harness — P5 行为快照、指纹对比与 test_harness.script.json
 *--------------------------------------------------------------------------------------------*/

import { hashAsync } from '../../../base/common/hash.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import {
	BehavioralCompareResult,
	BehavioralHarnessScript,
	BehavioralSnapshot,
} from '../common/harnessTypes.js';
import type { Intent } from '../common/intentTypes.js';

export const IBehavioralHarnessService = createDecorator<IBehavioralHarnessService>('IBehavioralHarnessService');

const MAX_FILES = 200;

export interface IBehavioralHarnessService {
	readonly _serviceBrand: undefined;
	writeHarnessScript(script: BehavioralHarnessScript): Promise<void>;
	ensureDefaultHarnessScript(intent: Intent): Promise<void>;
	captureSnapshot(intentId: string, phase: 'pre' | 'post', allowedPaths: string[]): Promise<BehavioralSnapshot>;
	compareSnapshots(pre: BehavioralSnapshot, post: BehavioralSnapshot, assertions: string[]): BehavioralCompareResult;
	capturePreForVerify(intent: Intent): Promise<void>;
	finalizePostAndCompare(intent: Intent): Promise<BehavioralCompareResult>;
}

export class BehavioralHarnessService extends Disposable implements IBehavioralHarnessService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async writeHarnessScript(script: BehavioralHarnessScript): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const uri = URI.joinPath(root, '.sentinel', 'test_harness.script.json');
		await this.fileService.createFolder(URI.joinPath(root, '.sentinel'));
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(script, undefined, '\t')));
	}

	async ensureDefaultHarnessScript(intent: Intent): Promise<void> {
		const assertions = intent.intentCard.allowedFiles.length > 0
			? intent.intentCard.allowedFiles.map(f => f.replace(/\\/g, '/'))
			: ['package.json', '.sentinel/harness.json'];
		await this.writeHarnessScript({
			version: 1,
			intentId: intent.id,
			assertions,
		});
	}

	async capturePreForVerify(intent: Intent): Promise<void> {
		await this.ensureDefaultHarnessScript(intent);
		const snap = await this.captureSnapshot(intent.id, 'pre', intent.intentCard.allowedFiles);
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const ref = `.sentinel/behavioral_snapshots/${intent.id}_pre.json`;
		const uri = URI.joinPath(root, '.sentinel', 'behavioral_snapshots', `${intent.id}_pre.json`);
		await this.fileService.createFolder(URI.joinPath(root, '.sentinel', 'behavioral_snapshots'));
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(snap, undefined, '\t')));
		const scriptUri = URI.joinPath(root, '.sentinel', 'test_harness.script.json');
		try {
			const raw = JSON.parse((await this.fileService.readFile(scriptUri)).value.toString()) as BehavioralHarnessScript;
			raw.preSnapshotRef = ref;
			await this.fileService.writeFile(scriptUri, VSBuffer.fromString(JSON.stringify(raw, undefined, '\t')));
		} catch {
			// ignore
		}
	}

	async finalizePostAndCompare(intent: Intent): Promise<BehavioralCompareResult> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		const defaultPre = `.sentinel/behavioral_snapshots/${intent.id}_pre.json`;
		if (!root) {
			return { ok: true, changedPaths: [], failures: [], preRef: defaultPre, postRef: '' };
		}
		const scriptUri = URI.joinPath(root, '.sentinel', 'test_harness.script.json');
		let assertions: string[] = [];
		try {
			const raw = JSON.parse((await this.fileService.readFile(scriptUri)).value.toString()) as BehavioralHarnessScript;
			assertions = raw.assertions || [];
		} catch {
			assertions = intent.intentCard.allowedFiles.map(f => f.replace(/\\/g, '/'));
		}
		const post = await this.captureSnapshot(intent.id, 'post', intent.intentCard.allowedFiles);
		const postRef = `.sentinel/behavioral_snapshots/${intent.id}_post.json`;
		const postUri = URI.joinPath(root, '.sentinel', 'behavioral_snapshots', `${intent.id}_post.json`);
		await this.fileService.createFolder(URI.joinPath(root, '.sentinel', 'behavioral_snapshots'));
		await this.fileService.writeFile(postUri, VSBuffer.fromString(JSON.stringify(post, undefined, '\t')));
		let preRefOut = defaultPre;
		try {
			const raw = JSON.parse((await this.fileService.readFile(scriptUri)).value.toString()) as BehavioralHarnessScript;
			raw.postSnapshotRef = postRef;
			preRefOut = raw.preSnapshotRef ?? defaultPre;
			await this.fileService.writeFile(scriptUri, VSBuffer.fromString(JSON.stringify(raw, undefined, '\t')));
		} catch {
			// ignore
		}

		const preUri = URI.joinPath(root, '.sentinel', 'behavioral_snapshots', `${intent.id}_pre.json`);
		let pre: BehavioralSnapshot;
		try {
			pre = JSON.parse((await this.fileService.readFile(preUri)).value.toString()) as BehavioralSnapshot;
		} catch {
			return { ok: true, changedPaths: [], failures: ['pre snapshot missing, skip compare'], preRef: preRefOut, postRef };
		}
		const result = this.compareSnapshots(pre, post, assertions);
		return { ...result, preRef: preRefOut, postRef };
	}

	async captureSnapshot(intentId: string, phase: 'pre' | 'post', allowedPaths: string[]): Promise<BehavioralSnapshot> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return { version: 1, intentId, phase, capturedAt: Date.now(), files: [] };
		}
		const seeds = allowedPaths.length > 0 ? allowedPaths : ['package.json'];
		const files: BehavioralSnapshot['files'] = [];
		for (const seg of seeds) {
			if (files.length >= MAX_FILES) {
				break;
			}
			const clean = seg.replace(/\\/g, '/').replace(/^\/+/, '');
			const base = URI.joinPath(root, clean);
			await this.walkFiles(base, root, files);
		}
		return { version: 1, intentId, phase, capturedAt: Date.now(), files };
	}

	private async walkFiles(uri: URI, root: URI, out: BehavioralSnapshot['files']): Promise<void> {
		if (out.length >= MAX_FILES) {
			return;
		}
		try {
			const stat = await this.fileService.resolve(uri);
			if (stat.isFile) {
				const content = await this.fileService.readFile(uri);
				const sha1 = await hashAsync(content.value);
				const relativePath = uri.path.slice(root.path.length).replace(/^\//, '');
				out.push({ relativePath, sha1, size: content.size });
				return;
			}
			if (stat.isDirectory && stat.children) {
				for (const ch of stat.children) {
					if (out.length >= MAX_FILES) {
						return;
					}
					await this.walkFiles(ch.resource, root, out);
				}
			}
		} catch {
			// path missing
		}
	}

	compareSnapshots(pre: BehavioralSnapshot, post: BehavioralSnapshot, assertions: string[]): BehavioralCompareResult {
		const preMap = new Map(pre.files.map(f => [f.relativePath.replace(/\\/g, '/'), f.sha1]));
		const postMap = new Map(post.files.map(f => [f.relativePath.replace(/\\/g, '/'), f.sha1]));
		const changedPaths: string[] = [];
		for (const [p, h0] of preMap) {
			const h1 = postMap.get(p);
			if (h1 !== undefined && h1 !== h0) {
				changedPaths.push(p);
			}
		}
		for (const [p] of postMap) {
			if (!preMap.has(p)) {
				changedPaths.push(p);
			}
		}
		const failures: string[] = [];
		const assertList = assertions.length > 0 ? assertions.map(a => a.replace(/\\/g, '/')) : [];
		for (const c of changedPaths) {
			const cn = c.replace(/\\/g, '/');
			for (const a of assertList) {
				if (cn === a || cn.startsWith(a) || cn.includes(`/${a}`) || cn.includes(a)) {
					failures.push(`受保护路径范围内发生变更: ${a} (${cn})`);
				}
			}
		}
		const ok = failures.length === 0;
		return {
			ok,
			changedPaths,
			failures,
			preRef: '',
			postRef: '',
		};
	}
}

registerSingleton(IBehavioralHarnessService, BehavioralHarnessService, InstantiationType.Delayed);
