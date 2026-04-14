/*---------------------------------------------------------------------------------------------
 *  跨端导出：manifest、IR 快照、模板脚手架、LLM 结构化落盘、校验门
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IOverlayWebview } from '../../../contrib/webview/browser/webview.js';
import { ILLMService } from '../common/llmService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import {
	ALL_CROSS_PLATFORM_TARGETS,
	createEmptyCrossPlatformManifest,
	CrossPlatformExportManifest,
	CrossPlatformIrSnapshot,
	CrossPlatformTargetId,
} from '../common/crossPlatformExportTypes.js';
import { getScaffoldFiles } from '../common/crossPlatformTemplates.js';
import { parseLlmFileBundle } from '../common/crossPlatformLlmParse.js';
import { runCrossPlatformGate } from '../common/crossPlatformGates.js';
import { ICrossPlatformIrSnapshotService } from './crossPlatformIrSnapshotService.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISentinelNpmScriptRunnerService } from '../../../sentinel/browser/sentinelNpmScriptRunnerService.js';
import { IHarnessAuditLogService } from './harnessAuditLogService.js';

export const ICrossPlatformExportService = createDecorator<ICrossPlatformExportService>('crossPlatformExportService');

export interface ICrossPlatformExportService {
	readonly _serviceBrand: undefined;
	loadManifest(): Promise<CrossPlatformExportManifest | undefined>;
	saveManifest(partial: Partial<CrossPlatformExportManifest> & Pick<CrossPlatformExportManifest, 'version'>): Promise<void>;
	handlePreviewMessage(webview: IOverlayWebview, message: unknown): Promise<void>;
	/** 命令：仅刷新 IR 快照 */
	snapshotIrNow(): Promise<void>;
}

const MANIFEST_NAME = 'cross-platform-export.json';
const EXPORTS_ROOT = 'exports';

function manifestUri(workspaceRoot: URI): URI {
	return joinPath(workspaceRoot, '.sentinel', MANIFEST_NAME);
}

export class CrossPlatformExportService extends Disposable implements ICrossPlatformExportService {
	readonly _serviceBrand: undefined;

	/** HGT-025：串行化多目标生成，避免并发写 manifest / exports */
	private generateChain: Promise<void> = Promise.resolve();

	constructor(
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ILLMService private readonly llmService: ILLMService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICrossPlatformIrSnapshotService private readonly irSnapshotService: ICrossPlatformIrSnapshotService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISentinelNpmScriptRunnerService private readonly npmScriptRunner: ISentinelNpmScriptRunnerService,
		@IHarnessAuditLogService private readonly harnessAuditLogService: IHarnessAuditLogService,
	) {
		super();
	}

	private get workspaceRoot(): URI | undefined {
		return this.workspaceContext.getWorkspace().folders[0]?.uri;
	}

	async loadManifest(): Promise<CrossPlatformExportManifest | undefined> {
		const root = this.workspaceRoot;
		if (!root) {
			return undefined;
		}
		try {
			const file = await this.fileService.readFile(manifestUri(root));
			const data = JSON.parse(file.value.toString()) as CrossPlatformExportManifest;
			if (data?.version !== 1) {
				return undefined;
			}
			return data;
		} catch {
			return undefined;
		}
	}

	async saveManifest(partial: Partial<CrossPlatformExportManifest> & { version: 1 }): Promise<void> {
		const root = this.workspaceRoot;
		if (!root) {
			return;
		}
		const prev = (await this.loadManifest()) ?? createEmptyCrossPlatformManifest(partial.previewUrl ?? '');
		const next: CrossPlatformExportManifest = {
			...prev,
			...partial,
			version: 1,
			finalized: partial.finalized !== undefined ? partial.finalized : prev.finalized,
			finalizedAt:
				partial.finalized === false
					? undefined
					: partial.finalizedAt !== undefined
						? partial.finalizedAt
						: prev.finalizedAt,
			previewUrl: partial.previewUrl !== undefined ? partial.previewUrl : prev.previewUrl,
			targets: { ...prev.targets, ...(partial.targets ?? {}) },
			runs: { ...prev.runs, ...(partial.runs ?? {}) },
			modules: partial.modules ?? prev.modules,
			irVersion: partial.irVersion !== undefined ? partial.irVersion : prev.irVersion,
			irSnapshotAt: partial.irSnapshotAt !== undefined ? partial.irSnapshotAt : prev.irSnapshotAt,
			irPath: partial.irPath !== undefined ? partial.irPath : prev.irPath,
			updatedAt: new Date().toISOString(),
		};
		const dir = joinPath(root, '.sentinel');
		await this.fileService.createFolder(dir).catch(() => undefined);
		await this.fileService.writeFile(manifestUri(root), VSBuffer.fromString(JSON.stringify(next, null, 2)));
	}

	async snapshotIrNow(): Promise<void> {
		const ir = await this.irSnapshotService.takeSnapshotAndSave();
		if (!ir) {
			this.notificationService.notify({ severity: Severity.Warning, message: localize('crossPlatform.irNoWs', 'Open a workspace to snapshot IR.') });
			return;
		}
		const m = await this.loadManifest();
		if (m) {
			await this.saveManifest({
				...m,
				irVersion: ir.irVersion,
				irSnapshotAt: ir.takenAt,
				irPath: '.sentinel/cross-platform-ir.json',
			});
		}
		this.notificationService.info(localize('crossPlatform.irSaved', 'IR snapshot saved to .sentinel/cross-platform-ir.json'));
	}

	private async ensureIr(workspaceRoot: URI): Promise<CrossPlatformIrSnapshot> {
		let ir = await this.irSnapshotService.loadSnapshot();
		if (!ir) {
			ir = await this.irSnapshotService.takeSnapshotAndSave();
		}
		if (!ir) {
			throw new Error('IR snapshot failed');
		}
		const m = await this.loadManifest();
		if (m) {
			await this.saveManifest({
				...m,
				irVersion: ir.irVersion,
				irSnapshotAt: ir.takenAt,
				irPath: '.sentinel/cross-platform-ir.json',
			});
		}
		return ir;
	}

	async handlePreviewMessage(webview: IOverlayWebview, message: unknown): Promise<void> {
		const m = message as { type?: string; action?: string; payload?: Record<string, unknown> };
		if (m.type !== 'projectPreview') {
			return;
		}
		const root = this.workspaceRoot;
		if (!root) {
			webview.postMessage({
				type: 'projectPreviewState',
				payload: { error: localize('crossPlatform.noWorkspace', 'Open a workspace folder to use cross-platform export.') },
			});
			return;
		}

		switch (m.action) {
			case 'getState': {
				const previewUrl = typeof m.payload?.previewUrl === 'string' ? m.payload.previewUrl : '';
				let loaded = await this.loadManifest();
				if (!loaded) {
					loaded = createEmptyCrossPlatformManifest(previewUrl);
					await this.saveManifest(loaded);
				} else if (previewUrl && loaded.previewUrl !== previewUrl) {
					await this.saveManifest({ ...loaded, previewUrl });
					loaded = { ...loaded, previewUrl };
				}
				webview.postMessage({ type: 'projectPreviewState', payload: { manifest: loaded } });
				break;
			}
			case 'setFinalized': {
				const v = !!m.payload?.finalized;
				const pv = String(m.payload?.previewUrl ?? '');
				const loaded = (await this.loadManifest()) ?? createEmptyCrossPlatformManifest(pv);
				if (v) {
					const ir = await this.irSnapshotService.takeSnapshotAndSave();
					await this.saveManifest({
						...loaded,
						finalized: true,
						finalizedAt: new Date().toISOString(),
						previewUrl: pv || loaded.previewUrl,
						irVersion: ir?.irVersion ?? 1,
						irSnapshotAt: ir?.takenAt,
						irPath: '.sentinel/cross-platform-ir.json',
					});
					if (!ir) {
						this.notificationService.notify({
							severity: Severity.Warning,
							message: localize('crossPlatform.irWarn', 'Finalize saved, but IR snapshot failed — run command "AI Core: Snapshot Cross-Platform IR".'),
						});
					}
				} else {
					await this.saveManifest({
						...loaded,
						finalized: false,
						finalizedAt: undefined,
						previewUrl: pv || loaded.previewUrl,
					});
				}
				const fresh = await this.loadManifest();
				webview.postMessage({ type: 'projectPreviewState', payload: { manifest: fresh } });
				break;
			}
			case 'setTargets': {
				const t = m.payload?.targets as Partial<Record<CrossPlatformTargetId, boolean>> | undefined;
				if (!t) {
					return;
				}
				const loaded = (await this.loadManifest()) ?? createEmptyCrossPlatformManifest(String(m.payload?.previewUrl ?? ''));
				const targets = { ...loaded.targets };
				for (const id of ALL_CROSS_PLATFORM_TARGETS) {
					if (typeof t[id] === 'boolean') {
						targets[id] = t[id]!;
					}
				}
				await this.saveManifest({ ...loaded, targets });
				const fresh = await this.loadManifest();
				webview.postMessage({ type: 'projectPreviewState', payload: { manifest: fresh } });
				break;
			}
			case 'generate': {
				const pv = m.payload?.previewUrl as string | undefined;
				this.generateChain = this.generateChain.then(async () => {
					try {
						await this.runGeneration(webview, pv);
					} catch (e) {
						this.logService.error('[CrossPlatform] generate failed', e);
					}
				});
				await this.generateChain;
				break;
			}
			default:
				break;
		}
	}

	private async runGeneration(webview: IOverlayWebview, previewUrl?: string): Promise<void> {
		const root = this.workspaceRoot;
		if (!root) {
			return;
		}
		let manifest = (await this.loadManifest()) ?? createEmptyCrossPlatformManifest(previewUrl ?? '');
		if (!manifest.finalized) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('crossPlatform.notFinalized', 'Please confirm「定稿」before generating.'),
			});
			webview.postMessage({ type: 'projectPreviewState', payload: { manifest, generateError: 'not_finalized' } });
			return;
		}

		const selected = ALL_CROSS_PLATFORM_TARGETS.filter(id => manifest.targets[id]);
		if (selected.length === 0) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('crossPlatform.noTargets', 'Select at least one target platform.'),
			});
			return;
		}

		const pv = previewUrl ?? manifest.previewUrl;
		this.notificationService.info(localize('crossPlatform.generating', 'Generating cross-platform artifacts (templates + LLM). This may take several minutes…'));

		let ir: CrossPlatformIrSnapshot;
		try {
			ir = await this.ensureIr(root);
		} catch (e) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('crossPlatform.irFail', 'IR snapshot failed: {0}', String(e)) });
			return;
		}

		const pkgName = ir.packageName || 'app';

		for (const target of selected) {
			manifest.runs = {
				...manifest.runs,
				[target]: { status: 'running', at: new Date().toISOString() },
			};
			await this.saveManifest({ ...manifest, previewUrl: pv });
			webview.postMessage({ type: 'projectPreviewState', payload: { manifest: await this.loadManifest(), progress: { target, phase: 'scaffold' } } });

			const exportTargetRoot = joinPath(root, EXPORTS_ROOT, target);
			await this.fileService.createFolder(joinPath(root, EXPORTS_ROOT)).catch(() => undefined);

			try {
				await this.writeScaffold(exportTargetRoot, target, pkgName, pv, ir.takenAt);

				webview.postMessage({ type: 'projectPreviewState', payload: { manifest: await this.loadManifest(), progress: { target, phase: 'llm' } } });

				const docMd = await this.generateTargetMarkdown(target, manifest, ir, pv);
				const bundle = await this.generateLlmFileBundle(target, ir, docMd);
				let written = 0;
				if (bundle) {
					for (const f of bundle.files) {
						const uri = joinPath(exportTargetRoot, f.path);
						await this.fileService.createFolder(dirname(uri)).catch(() => undefined);
						await this.fileService.writeFile(uri, VSBuffer.fromString(f.content));
						written++;
					}
				}

				const genMd = joinPath(exportTargetRoot, 'GENERATION.md');
				let gate = await runCrossPlatformGate(target, exportTargetRoot, this.fileService);
				if (
					target === 'web' &&
					gate.ok &&
					this.configurationService.getValue<boolean>('aiCore.crossPlatform.runNpmBuildGateOnWebExport')
				) {
					const folder = this.workspaceContext.getWorkspace().folders[0];
					if (folder) {
						const buildOut = await this.npmScriptRunner.runBuildScript(folder);
						if (!buildOut.skipped && buildOut.exitCode !== 0) {
							gate = {
								ok: false,
								detail: `${gate.detail}；npm run build 失败：exit ${buildOut.exitCode}${buildOut.errorMessage ? ` — ${buildOut.errorMessage}` : ''}${buildOut.timedOut ? '（超时）' : ''}`,
							};
						} else {
							gate = {
								ok: gate.ok,
								detail: buildOut.skipped
									? `${gate.detail}；npm build 门禁：已跳过（${buildOut.errorMessage ?? '无 build 脚本'}）`
									: `${gate.detail}；npm run build 通过（${buildOut.scriptName ?? 'build'}）`,
							};
						}
					}
				}
				const footer = `\n\n---\n\n## LLM 文件包\n\n${written > 0 ? `已写入 ${written} 个文件（由模型生成，请审阅）。` : '模型未返回可解析的文件 JSON，请仅依赖模板与上文。'}\n\n## 校验门\n\n${gate.ok ? '✅ ' : '⚠️ '}${gate.detail}\n`;
				await this.fileService.writeFile(genMd, VSBuffer.fromString(docMd + footer));

				manifest.runs = {
					...manifest.runs,
					[target]: {
						status: gate.ok ? 'done' : 'error',
						at: new Date().toISOString(),
						summary: localize('crossPlatform.wroteExport', 'exports/{0}/project + GENERATION.md', target),
						...(gate.ok ? {} : { error: gate.detail }),
					},
				};
				void this.harnessAuditLogService.append('cross_platform_export', {
					target,
					written,
					gateOk: gate.ok,
					status: gate.ok ? 'done' : 'error',
				});
			} catch (e) {
				const err = String(e);
				this.logService.error(`[CrossPlatform] ${target}`, e);
				await this.fileService.del(exportTargetRoot, { recursive: true }).catch(delErr =>
					this.logService.warn(`[CrossPlatform] rollback delete failed for ${target}: ${delErr}`),
				);
				manifest.runs = {
					...manifest.runs,
					[target]: {
						status: 'error',
						at: new Date().toISOString(),
						error: `Generation failed; removed exports/${target}: ${err}`,
					},
				};
			}
			await this.saveManifest({ ...manifest, previewUrl: pv });
			const reloaded = await this.loadManifest();
			if (reloaded) {
				manifest = reloaded;
			}
		}

		webview.postMessage({ type: 'projectPreviewState', payload: { manifest, generateDone: true } });
		this.notificationService.info(localize('crossPlatform.done', 'Cross-platform export finished. Open the `exports/` folder — each target has a `project/` scaffold.'));
	}

	private async writeScaffold(
		exportTargetRoot: URI,
		target: CrossPlatformTargetId,
		packageName: string,
		previewUrl: string,
		snapshotAt: string,
	): Promise<void> {
		const files = getScaffoldFiles(target, packageName, previewUrl, snapshotAt);
		for (const [rel, text] of files) {
			const uri = joinPath(exportTargetRoot, rel);
			await this.fileService.createFolder(dirname(uri)).catch(() => undefined);
			await this.fileService.writeFile(uri, VSBuffer.fromString(text));
		}
	}

	private async generateTargetMarkdown(
		target: CrossPlatformTargetId,
		manifest: CrossPlatformExportManifest,
		ir: CrossPlatformIrSnapshot,
		previewUrl: string,
	): Promise<string> {
		const system = `You are a senior software architect. Output Markdown in Chinese. Be concrete. Do not claim to have run builds.`;

		const targetHint =
			target === 'web'
				? 'Web：生产构建、环境变量与部署检查清单。'
				: target === 'ios'
					? 'iOS：SwiftUI / RN 选型、目录、与 Web 对齐的 API。'
					: target === 'android'
						? 'Android：Kotlin/Compose 或 RN、Gradle 要点。'
						: '微信小程序：页面映射、微信工具导入、审核注意。';

		const user = `【预览 URL】${previewUrl}

【IR 快照 JSON】
${JSON.stringify(ir, null, 2)}

【manifest】
${JSON.stringify(manifest, null, 2)}

【任务】${targetHint}

输出 Markdown：架构要点、目录建议（相对于 exports/${target}/project/）、分步落地顺序、风险。`;

		const res = await this.llmService.chat({
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 8192,
			temperature: 0.25,
		});

		return `# 跨端导出 — ${target}\n\n> 模板已写入 \`project/\`，以下为补充说明（请人工审阅）。\n\n${res.content}`;
	}

	private async generateLlmFileBundle(
		target: CrossPlatformTargetId,
		ir: CrossPlatformIrSnapshot,
		archMarkdown: string,
	): Promise<ReturnType<typeof parseLlmFileBundle>> {
		const system = `You output ONLY valid JSON (no markdown fences). Schema:
{"files":[{"path":"relative/path","content":"file body"}],"notes":"optional"}
Paths must be relative to exports/${target}/, use forward slashes, no "..", max 12 files. UTF-8.`;

		const user = `Target platform: ${target}

IR:
${JSON.stringify(ir, null, 2)}

Architecture notes (excerpt):
${archMarkdown.slice(0, 12000)}

Fill in ADDITIONAL or REPLACEMENT files under \`project/\` only (e.g. project/extra/Note.txt). Do not repeat entire miniprogram if already scaffolded — add deltas or docs. If unsure, return {"files":[],"notes":"no changes"}.`;

		const res = await this.llmService.chat({
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			maxTokens: 8192,
			temperature: 0.2,
		});

		return parseLlmFileBundle(res.content);
	}
}

registerSingleton(ICrossPlatformExportService, CrossPlatformExportService, InstantiationType.Delayed);
