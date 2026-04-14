/*---------------------------------------------------------------------------------------------
 *  Sentinel Control Plane — 产品级控制平面 UI
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWebviewElement, IWebviewService } from '../../../contrib/webview/browser/webview.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISentinelPersistenceService } from '../../../sentinel/browser/persistenceService.js';
import { ISentinelKernelService } from '../../../sentinel/common/sentinelKernelService.js';
import { ISentinelProductService } from '../../../sentinel/common/sentinelProductService.js';

export const SENTINEL_CONTROL_PLANE_VIEW_ID = 'workbench.view.sentinel.controlPlane';

export class SentinelControlPlanePane extends ViewPane {
	/**
	 * 内联 iframe。须复制 chatWebviewPane.css 的 flex 规则（本文件用内联 style），否则在 pane-body 的 flex 里 iframe 高度会为 0（黑屏）。
	 * Overlay 方案在 claim 前 layoutWebviewOverElement 会直接 return，且依赖异步布局，易失败。
	 */
	private _webview: IWebviewElement | undefined;
	/** renderBody 收到的 pane-body，用于写入明确宽高（仅 flex/百分比时子项常为 0 高导致「黑屏」） */
	private _bodyRoot: HTMLElement | undefined;
	private _paneWrapper: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _uiRestoreAttempted = false;
	/** 用户曾在本面板可见后切走，再切回时需 reinitialize（避免首次从别 Tab 点进 Sentinel 就误重载） */
	private _sentinelBodyWasHiddenAfterShown = false;
	private _sentinelBodyEverShown = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@ISentinelPersistenceService private readonly persistenceService: ISentinelPersistenceService,
		@ISentinelKernelService private readonly sentinelKernelService: ISentinelKernelService,
		@ISentinelProductService private readonly sentinelProductService: ISentinelProductService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService,
			contextKeyService, viewDescriptorService, instantiationService, openerService,
			themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._bodyRoot = container;
		container.style.padding = '0';
		container.style.overflow = 'hidden';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.minHeight = '0';
		container.style.position = 'relative';
		container.style.backgroundColor = 'var(--vscode-panel-background)';

		// 对齐 contrib/aiCore/browser/chatWebview/chatWebviewPane.css（esbuild 单文件编译不会带 css）
		this._paneWrapper = dom.append(container, dom.$('.sentinel-webview-pane'));
		this._paneWrapper.style.display = 'flex';
		this._paneWrapper.style.flexDirection = 'column';
		this._paneWrapper.style.flex = '1';
		this._paneWrapper.style.minHeight = '0';
		this._paneWrapper.style.height = '100%';
		this._paneWrapper.style.width = '100%';
		this._paneWrapper.style.overflow = 'hidden';

		this._webviewContainer = dom.append(this._paneWrapper, dom.$('.sentinel-webview-container'));
		this._webviewContainer.style.flex = '1';
		this._webviewContainer.style.minHeight = '0';
		this._webviewContainer.style.display = 'flex';
		this._webviewContainer.style.flexDirection = 'column';
		this._webviewContainer.style.overflow = 'hidden';

		this._webview = this.webviewService.createWebviewElement({
			providedViewType: 'sentinelControlPlane',
			title: 'Sentinel Control Plane',
			options: {
				retainContextWhenHidden: true,
				// 避免预加载页卡在「等待 SW controller」导致整片黑
				disableServiceWorker: true,
			},
			contentOptions: {
				allowScripts: true,
			},
			extension: undefined,
		});

		const targetWindow = dom.getWindow(this._webviewContainer);
		this._webview.mountTo(this._webviewContainer, targetWindow);
		this._webview.setHtml(this.generateHTML());
		this.logService.info(`[Sentinel] Webview mounted windowId=${targetWindow.vscodeWindowId}`);
		queueMicrotask(() => {
			const host = this._webviewContainer?.firstElementChild as HTMLElement | undefined;
			if (host) {
				host.style.flex = '1';
				host.style.minHeight = '0';
				host.style.alignSelf = 'stretch';
			}
		});
		// 延迟一帧量 iframe 尺寸（若为 0x0 即布局问题）
		setTimeout(() => {
			const iframe = this._webviewContainer?.querySelector('iframe');
			this.logService.info(`[Sentinel] iframe offset ${iframe?.offsetWidth ?? 'n'}x${iframe?.offsetHeight ?? 'n'} bodyRect=${this._bodyRoot?.getBoundingClientRect().height ?? 'n'}`);
		}, 400);

		this._register(this._webview.onMessage(e => this.handleMessage(e.message)));
		this._register(this._webview.onFatalError(e => {
			this.logService.error('[Sentinel] Webview onFatalError', e.message);
		}));
		this._register(this.sentinelProductService.onDidUpdateSnapshot(snapshot => {
			void this._webview?.postMessage({ type: 'snapshot', payload: snapshot });
		}));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (!this._webview) {
				return;
			}
			if (!visible) {
				if (this._sentinelBodyEverShown) {
					this._sentinelBodyWasHiddenAfterShown = true;
				}
				return;
			}
			this._sentinelBodyEverShown = true;
			// 从其他面板 Tab 切回 Sentinel 时，合成区曾从 DOM 移除，内联 iframe 可能已损坏 → 需重载
			if (this._sentinelBodyWasHiddenAfterShown) {
				this._sentinelBodyWasHiddenAfterShown = false;
				try {
					this._webview.reinitializeAfterDismount();
				} catch (e) {
					this.logService.warn('[Sentinel] reinitializeAfterDismount failed', e);
				}
			}
			queueMicrotask(() => {
				const el = this._bodyRoot;
				if (el) {
					const r = el.getBoundingClientRect();
					if (r.width > 2 && r.height > 2) {
						this.layoutBody(r.height, r.width);
					}
				}
			});
			void this.ensureRestoredFromDisk().then(() => {
				const snap = this.sentinelProductService.getSnapshot();
				void this._webview?.postMessage({ type: 'snapshot', payload: snap });
				void this._webview?.postMessage({ type: 'panelVisible', payload: true });
			});
		}));

		if (this.isBodyVisible()) {
			queueMicrotask(() => void this.ensureRestoredFromDisk());
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const h = Math.max(height, 120);
		const w = Math.max(width, 80);
		this.logService.info(`[Sentinel] layoutBody raw=${width}x${height} use=${w}x${h}`);
		if (this._bodyRoot) {
			this._bodyRoot.style.height = `${h}px`;
			this._bodyRoot.style.width = `${w}px`;
			this._bodyRoot.style.minHeight = `${h}px`;
		}
		const innerH = Math.max(h, 80);
		if (this._paneWrapper) {
			this._paneWrapper.style.flex = '1';
			this._paneWrapper.style.height = `${innerH}px`;
			this._paneWrapper.style.width = `${w}px`;
			this._paneWrapper.style.minHeight = `${innerH}px`;
		}
		if (this._webviewContainer) {
			this._webviewContainer.style.height = `${innerH}px`;
			this._webviewContainer.style.width = `${w}px`;
			this._webviewContainer.style.minHeight = `${innerH}px`;
		}
	}

	override dispose(): void {
		this._webview?.dispose();
		super.dispose();
	}

	/**
	 * 工作区恢复可能比 Webview 更早结束，导致内存仍为空；在 ready / 显示时从磁盘再灌一次。
	 */
	private async ensureRestoredFromDisk(): Promise<void> {
		if (this._uiRestoreAttempted) {
			return;
		}
		try {
			const data = await this.persistenceService.loadState();
			if (!data?.snapshot?.intents?.length) {
				return;
			}
			if (this.sentinelKernelService.getSnapshot().intents.length > 0) {
				this._uiRestoreAttempted = true;
				return;
			}
			await this.sentinelKernelService.restorePersistedState(data);
			this.sentinelProductService.applyRestoredSession(data.snapshot);
			this._uiRestoreAttempted = true;
			this.logService.info('[Sentinel] Restored session from disk in control plane');
		} catch (e) {
			this.logService.warn('[Sentinel] ensureRestoredFromDisk failed', e);
		}
	}

	private async handleMessage(message: unknown): Promise<void> {
		const msg = message as { type: string; payload?: Record<string, unknown> };

		try {
			switch (msg.type) {
				case 'ready':
				case 'requestSnapshot':
					await this.ensureRestoredFromDisk();
					this._webview?.postMessage({ type: 'snapshot', payload: this.sentinelProductService.getSnapshot() });
					break;
				case 'createIntent':
					if (typeof msg.payload?.message === 'string' && msg.payload.message.trim()) {
						this._webview?.postMessage({ type: 'status', payload: { text: '正在创建 Intent...' } });
						await this.sentinelProductService.ingestPrompt({
							message: msg.payload.message,
							source: 'sentinel_ui',
						});
					}
					break;
				case 'seedDemo':
					this._webview?.postMessage({ type: 'status', payload: { text: '正在生成演示数据...' } });
					await this.sentinelProductService.seedDemoState();
					break;
				case 'advanceActiveIntent':
					this._webview?.postMessage({ type: 'status', payload: { text: '正在推进节点...' } });
					await this.sentinelProductService.advanceActiveIntent();
					break;
				case 'confirmAndExecute': {
				this._webview?.postMessage({ type: 'status', payload: { text: '需求已确认，正在规划和执行...' } });
				const userFeedback = msg.payload as {
					refinement?: string;
					acceptedAssumptions?: string[];
					rejectedAssumptions?: string[];
					questionAnswers?: string[];
					adoptedSuggestions?: string[];
				} | undefined;
				const answers: string[] = [];
				if (userFeedback?.refinement) {
					answers.push(`[用户补充] ${userFeedback.refinement}`);
				}
				if (userFeedback?.rejectedAssumptions?.length) {
					answers.push(`[拒绝假设] ${userFeedback.rejectedAssumptions.join('; ')}`);
				}
				if (userFeedback?.questionAnswers?.length) {
					answers.push(...userFeedback.questionAnswers);
				}
				if (userFeedback?.adoptedSuggestions?.length) {
					answers.push(`[采纳建议] ${userFeedback.adoptedSuggestions.join('; ')}`);
				}
				await this.sentinelProductService.confirmAndExecute(answers.length > 0 ? answers : undefined);
				this._webview?.postMessage({ type: 'status', payload: { text: '' } });
				break;
			}
			case 'reanalyze': {
				if (typeof msg.payload?.intentId === 'string') {
					const ctx = typeof msg.payload?.additionalContext === 'string' ? msg.payload.additionalContext : '';
					this._webview?.postMessage({ type: 'status', payload: { text: '正在重新分析需求...' } });
					if (ctx) {
						const snapshot = this.sentinelProductService.getSnapshot();
						const intent = snapshot.intents.find(i => i.id === msg.payload?.intentId);
						if (intent) {
							this.sentinelProductService.updateIntentCard(msg.payload.intentId as string, {
								goal: intent.goal + '\n\n[用户补充] ' + ctx,
							});
						}
					}
					await this.sentinelProductService.reanalyze(msg.payload.intentId as string);
					this._webview?.postMessage({ type: 'status', payload: { text: '' } });
				}
				break;
			}
			case 'runFullPipeline':
				this._webview?.postMessage({ type: 'status', payload: { text: '自动运行启动中...' } });
				await this.sentinelProductService.runFullPipeline();
				this._webview?.postMessage({ type: 'status', payload: { text: '' } });
				break;
				case 'pauseExecution':
					this.sentinelProductService.pauseExecution();
					break;
				case 'resumeExecution':
					this._webview?.postMessage({ type: 'status', payload: { text: '正在恢复执行...' } });
					await this.sentinelProductService.resumeExecution();
					break;
				case 'retryNode':
					if (typeof msg.payload?.nodeId === 'string') {
						this._webview?.postMessage({ type: 'status', payload: { text: '正在重试节点...' } });
						await this.sentinelProductService.retryNode(msg.payload.nodeId);
					}
					break;
				case 'rollbackNode':
					if (typeof msg.payload?.nodeId === 'string') {
						await this.sentinelProductService.rollbackNode(msg.payload.nodeId);
					}
					break;
				case 'addNode':
					if (typeof msg.payload?.title === 'string') {
						this.sentinelProductService.addNode(
							msg.payload.title as string,
							(msg.payload.description as string) || '',
							(msg.payload.nodeType as string) || 'implement',
							msg.payload.afterNodeId as string | undefined,
						);
					}
					break;
				case 'removeNode':
					if (typeof msg.payload?.nodeId === 'string') {
						this.sentinelProductService.removeNode(msg.payload.nodeId);
					}
					break;
				case 'moveNode':
					if (typeof msg.payload?.nodeId === 'string' && typeof msg.payload?.direction === 'string') {
						this.sentinelProductService.moveNode(msg.payload.nodeId as string, msg.payload.direction as 'up' | 'down');
					}
					break;
				case 'selectIntent':
					if (typeof msg.payload?.intentId === 'string') {
						this.sentinelProductService.selectIntent(msg.payload.intentId);
					}
					break;
				case 'deleteIntent':
					if (typeof msg.payload?.intentId === 'string') {
						this.sentinelProductService.deleteIntent(msg.payload.intentId);
					}
					break;
				case 'updateIntentCard':
					if (typeof msg.payload?.intentId === 'string' && msg.payload.card) {
						this.sentinelProductService.updateIntentCard(msg.payload.intentId as string, msg.payload.card as any);
					}
					break;
				case 'openWorkspaceRelative':
					if (typeof msg.payload?.path === 'string') {
						const folder = this.workspaceContextService.getWorkspace().folders[0];
						if (folder) {
							const uri = URI.joinPath(folder.uri, msg.payload.path);
							await this.openerService.open(uri);
						}
					}
					break;
				default:
					this.logService.trace(`[SentinelControlPlane] Unknown message: ${msg.type}`);
			}
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.logService.error(`[SentinelControlPlane] Error handling '${msg.type}': ${errMsg}`);
			this._webview?.postMessage({ type: 'error', payload: { message: `操作失败: ${errMsg}` } });
			this._webview?.postMessage({ type: 'snapshot', payload: this.sentinelProductService.getSnapshot() });
		}
	}

	private generateHTML(): string {
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
	--bg: var(--vscode-editor-background, #1e1e1e);
	--fg: var(--vscode-editor-foreground, #d4d4d4);
	--border: var(--vscode-panel-border, #333);
	--muted: var(--vscode-descriptionForeground, #9da0a6);
	--card: var(--vscode-sideBar-background, #252526);
	--accent: var(--vscode-button-background, #0e639c);
	--accent-hover: var(--vscode-button-hoverBackground, #1177bb);
	--input-bg: var(--vscode-input-background, #3c3c3c);
	--input-border: var(--vscode-input-border, #555);
	--ok: #4caf50;
	--warn: #ff9800;
	--bad: #f44336;
	--info: #2196f3;
	--purple: #9c27b0;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
	font-size: 12px;
	background: var(--bg);
	color: var(--fg);
	line-height: 1.5;
}

/* Layout */
.shell {
	display: grid;
	grid-template-columns: 300px 1fr;
	grid-template-rows: auto 1fr;
	height: 100vh;
}
.header {
	grid-column: 1 / -1;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 16px;
	border-bottom: 1px solid var(--border);
	background: var(--card);
}
.header-left { display: flex; align-items: center; gap: 12px; }
.header-title { font-size: 13px; font-weight: 600; letter-spacing: 0.5px; }
.phase-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 8px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 500;
	text-transform: uppercase;
}
.phase-idle { background: rgba(255,255,255,0.06); color: var(--muted); }
.phase-intent_workspace { background: rgba(33,150,243,0.15); color: var(--info); }
.phase-analyzing { background: rgba(156,39,176,0.15); color: #ba68c8; }
.phase-awaiting_confirmation { background: rgba(255,152,0,0.2); color: var(--warn); }
.phase-planning { background: rgba(255,152,0,0.15); color: var(--warn); }
.phase-execution { background: rgba(76,175,80,0.15); color: var(--ok); }
.phase-verification { background: rgba(156,39,176,0.15); color: #ba68c8; }
.phase-projection { background: rgba(0,188,212,0.15); color: #4dd0e1; }
.phase-blocked { background: rgba(244,67,54,0.15); color: var(--bad); }

.sidebar {
	border-right: 1px solid var(--border);
	overflow-y: auto;
	padding: 12px;
}
.main {
	overflow-y: auto;
	padding: 12px;
}

/* Sections */
.section {
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 6px;
	margin-bottom: 10px;
	overflow: hidden;
}
.section-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 12px;
	border-bottom: 1px solid var(--border);
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: var(--muted);
	cursor: pointer;
	user-select: none;
}
.section-header:hover { color: var(--fg); }
.section-body { padding: 10px 12px; }
.section-body.collapsed { display: none; }

/* Buttons */
button {
	background: var(--accent);
	color: #fff;
	border: none;
	border-radius: 4px;
	padding: 5px 10px;
	cursor: pointer;
	font-size: 11px;
	font-weight: 500;
	transition: background 0.15s;
}
button:hover { background: var(--accent-hover); }
button.secondary {
	background: transparent;
	border: 1px solid var(--border);
	color: var(--fg);
}
button.secondary:hover { background: rgba(255,255,255,0.06); }
button.danger { background: var(--bad); }
button.danger:hover { background: #d32f2f; }
button.success { background: var(--ok); }
button.success:hover { background: #388e3c; }
button:disabled { opacity: 0.4; cursor: not-allowed; }

/* Inputs */
textarea, input[type="text"] {
	width: 100%;
	background: var(--input-bg);
	color: var(--fg);
	border: 1px solid var(--input-border);
	border-radius: 4px;
	padding: 6px 8px;
	font-family: inherit;
	font-size: 12px;
	resize: vertical;
}
textarea:focus, input[type="text"]:focus {
	outline: none;
	border-color: var(--accent);
}

/* Toolbar */
.toolbar { display: flex; gap: 6px; flex-wrap: wrap; }
.toolbar-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }

/* Cards */
.card {
	border: 1px solid var(--border);
	border-radius: 4px;
	padding: 8px 10px;
	margin-bottom: 6px;
	cursor: pointer;
	transition: border-color 0.15s;
}
.card:hover { border-color: rgba(255,255,255,0.2); }
.card.active { border-color: var(--accent); background: rgba(14,99,156,0.08); }
.card-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
.card-meta { color: var(--muted); font-size: 11px; }

/* Pills */
.pill {
	display: inline-block;
	padding: 1px 6px;
	border-radius: 999px;
	font-size: 10px;
	font-weight: 500;
	margin-right: 4px;
}
.pill-ok { background: rgba(76,175,80,0.15); color: var(--ok); }
.pill-warn { background: rgba(255,152,0,0.15); color: var(--warn); }
.pill-bad { background: rgba(244,67,54,0.15); color: var(--bad); }
.pill-info { background: rgba(33,150,243,0.15); color: var(--info); }
.pill-neutral { background: rgba(255,255,255,0.08); color: var(--muted); }

/* Execution nodes */
.exec-node {
	border-left: 3px solid var(--border);
	padding: 6px 10px;
	margin-bottom: 6px;
	border-radius: 0 4px 4px 0;
	background: rgba(255,255,255,0.02);
	cursor: pointer;
	transition: background 0.15s;
}
.exec-node:hover { background: rgba(255,255,255,0.04); }
.exec-node.status-running { border-left-color: var(--info); background: rgba(33,150,243,0.05); }
.exec-node.status-completed { border-left-color: var(--ok); }
.exec-node.status-blocked { border-left-color: var(--bad); background: rgba(244,67,54,0.05); }
.exec-node.status-failed { border-left-color: var(--bad); background: rgba(244,67,54,0.05); }
.exec-node.status-ready { border-left-color: var(--warn); }
.exec-node-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
.exec-node-title { font-weight: 600; font-size: 12px; }
.exec-node-desc { color: var(--muted); font-size: 11px; }
.exec-node-meta { display: flex; gap: 4px; margin-top: 3px; flex-wrap: wrap; }
.exec-node-result {
	margin-top: 4px;
	font-size: 11px;
	background: rgba(255,255,255,0.03);
	padding: 6px 8px;
	border-radius: 4px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 120px;
	overflow-y: auto;
}
.node-detail-overlay {
	position: fixed;
	top: 0; left: 0; right: 0; bottom: 0;
	background: rgba(0,0,0,0.5);
	z-index: 100;
	display: flex;
	justify-content: center;
	align-items: center;
}
.node-detail-panel {
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 8px;
	width: 90%;
	max-width: 700px;
	max-height: 80vh;
	overflow-y: auto;
	padding: 16px;
}
.node-detail-panel h3 { margin-bottom: 12px; font-size: 14px; }
.node-detail-section { margin-bottom: 12px; }
.node-detail-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
.node-detail-kv { display: flex; gap: 8px; margin-bottom: 2px; font-size: 11px; }
.node-detail-kv .k { color: var(--muted); min-width: 100px; }
.add-node-row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.add-node-row input, .add-node-row select { font-size: 11px; padding: 4px 6px; background: var(--input-bg); color: var(--fg); border: 1px solid var(--input-border); border-radius: 4px; }
.add-node-row input { flex: 1; }

/* Grid layouts */
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }

/* Metric */
.metric { margin-bottom: 4px; }
.metric-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
.metric-value { font-size: 14px; font-weight: 600; }

/* Timeline */
.timeline-item {
	display: flex;
	gap: 8px;
	padding: 4px 0;
	border-bottom: 1px solid rgba(255,255,255,0.04);
}
.timeline-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	margin-top: 5px;
	flex-shrink: 0;
}
.timeline-dot.intent { background: var(--info); }
.timeline-dot.execution { background: var(--ok); }
.timeline-dot.verification { background: #ba68c8; }
.timeline-dot.projection { background: #4dd0e1; }
.timeline-dot.system { background: var(--muted); }
.timeline-content { min-width: 0; }
.timeline-title { font-weight: 500; font-size: 11px; }
.timeline-desc { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-item.severity-failure .timeline-title { color: var(--vscode-errorForeground, #f48771); }
.timeline-item.severity-warning .timeline-title { color: var(--vscode-editorWarning-foreground, #cca700); }
.timeline-item.severity-success .timeline-title { color: var(--vscode-testing-iconPassed, #89d185); }

/* Tabs */
.tab-bar { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
.tab-btn {
	background: none;
	border: none;
	color: var(--muted);
	padding: 6px 12px;
	font-size: 11px;
	font-weight: 500;
	cursor: pointer;
	border-bottom: 2px solid transparent;
	transition: all 0.15s;
}
.tab-btn:hover { color: var(--fg); }
.tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

/* Analysis Panel */
.analysis-panel {
	background: var(--card);
	border: 1px solid var(--accent);
	border-radius: 8px;
	padding: 16px;
	margin-bottom: 12px;
	animation: fadeIn 0.3s ease;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
.analysis-title { font-size: 14px; font-weight: 700; margin-bottom: 12px; color: var(--accent); }
.analysis-section { margin-bottom: 10px; }
.analysis-section-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
.analysis-list { list-style: none; padding: 0; }
.analysis-list li { padding: 3px 0; font-size: 12px; display: flex; align-items: start; gap: 6px; }
.analysis-list li::before { content: '•'; color: var(--accent); flex-shrink: 0; margin-top: 1px; }
.analysis-tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; margin: 2px; }
.analysis-tag.tech { background: rgba(33,150,243,0.15); color: var(--info); }
.analysis-tag.ambiguity { background: rgba(255,152,0,0.15); color: var(--warn); }
.analysis-tag.question { background: rgba(156,39,176,0.15); color: #ba68c8; }
.analysis-confirm-bar { display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.analysis-panel textarea, .analysis-panel input[type="text"] {
	width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05); color: var(--fg);
	border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; font-size: 12px;
	font-family: inherit; resize: vertical; outline: none; transition: border-color 0.2s;
}
.analysis-panel textarea:focus, .analysis-panel input[type="text"]:focus {
	border-color: var(--accent);
}
.analysis-panel textarea::placeholder, .analysis-panel input[type="text"]::placeholder {
	color: var(--muted); opacity: 0.7;
}
button.secondary {
	background: rgba(255,255,255,0.08); color: var(--fg); border: 1px solid var(--border);
	border-radius: 4px; cursor: pointer; font-size: 12px; transition: background 0.2s;
}
button.secondary:hover { background: rgba(255,255,255,0.15); }

/* Progress indicator */
.progress-bar-container { background: rgba(255,255,255,0.05); border-radius: 4px; height: 6px; overflow: hidden; margin: 8px 0; }
.progress-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); border-radius: 4px; transition: width 0.5s ease; }

/* Step cards for execution */
.step-card {
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 10px 12px;
	margin-bottom: 8px;
	transition: all 0.2s;
}
.step-card.step-active { border-color: var(--info); background: rgba(33,150,243,0.05); }
.step-card.step-done { border-color: var(--ok); opacity: 0.8; }
.step-card.step-pending { opacity: 0.5; }
.step-status-icon { font-size: 14px; margin-right: 6px; }
</style>
</head>
<body>
<div class="shell">
	<div class="header">
		<div class="header-left">
			<span class="header-title">SENTINEL</span>
			<span id="phaseBadge" class="phase-badge phase-idle">IDLE</span>
		</div>
		<div class="toolbar">
			<button id="runPipelineBtn" class="success" title="自动执行全部节点">▶ 自动运行</button>
			<button id="pauseBtn" class="secondary" title="暂停执行">⏸ 暂停</button>
			<button id="resumeBtn" class="success" title="恢复执行" style="display:none">▶ 恢复</button>
			<button id="advanceBtn" class="secondary" title="推进下一节点">⏭ 单步</button>
		</div>
	</div>

	<div class="sidebar">
		<div class="section">
			<div class="section-header">Intent Workspace</div>
			<div class="section-body">
				<textarea id="intentInput" rows="3" placeholder="描述你的目标、约束和验收标准..."></textarea>
				<div class="toolbar-row">
					<button id="createIntentBtn">创建 Intent</button>
				</div>
			</div>
		</div>

		<div class="section">
			<div class="section-header">
				<span>Intent 列表</span>
				<span id="intentCount" class="pill pill-neutral">0</span>
			</div>
			<div class="section-body" id="intentList">
				<div class="card-meta">暂无意图</div>
			</div>
		</div>

		<div class="section" id="intentCardSection" style="display:none">
			<div class="section-header">IntentCard 编辑</div>
			<div class="section-body">
				<div style="margin-bottom:6px">
					<label class="metric-label">Non-Goals</label>
					<input type="text" id="cardNonGoals" placeholder="逗号分隔，例如：不碰支付, 不改登录" />
				</div>
				<div style="margin-bottom:6px">
					<label class="metric-label">Allowed Files</label>
					<input type="text" id="cardAllowedFiles" placeholder="逗号分隔，例如：checkout, orders" />
				</div>
				<div style="margin-bottom:6px">
					<label class="metric-label">Success Criteria</label>
					<input type="text" id="cardSuccessCriteria" placeholder="逗号分隔" />
				</div>
				<div style="margin-bottom:6px">
					<label class="metric-label">Stop If</label>
					<input type="text" id="cardStopIf" placeholder="逗号分隔" />
				</div>
				<div class="toolbar-row">
					<button id="saveCardBtn" class="success">保存 IntentCard</button>
				</div>
			</div>
		</div>

		<div class="section">
			<div class="section-header">成本追踪</div>
			<div class="section-body" id="costPanel">
				<div class="grid-2">
					<div class="metric">
						<div class="metric-label">总成本</div>
						<div class="metric-value" id="totalCost">¥0.0000</div>
					</div>
					<div class="metric">
						<div class="metric-label">总 Tokens</div>
						<div class="metric-value" id="totalTokens">0</div>
					</div>
				</div>
			</div>
		</div>
	</div>

	<div class="main">
		<div id="analysisContainer" style="display:none"></div>
		<div class="tab-bar">
			<button class="tab-btn active" data-tab="execution">执行控制</button>
			<button class="tab-btn" data-tab="verification">验证门</button>
			<button class="tab-btn" data-tab="artifacts">工件投影</button>
			<button class="tab-btn" data-tab="reasoning">推理链</button>
			<button class="tab-btn" data-tab="timeline">活动流</button>
			<button class="tab-btn" data-tab="insight">P3 洞察</button>
		</div>

		<div id="tab-execution" class="tab-panel active">
			<div class="section">
				<div class="section-header">
					<span>Execution Graph</span>
					<span id="graphProgress" class="pill pill-neutral">0%</span>
				</div>
				<div class="section-body" id="graphView">
					<div class="card-meta">暂无执行图</div>
				</div>
				<div class="section-body" style="border-top:1px solid var(--border)">
					<div class="add-node-row">
						<input type="text" id="addNodeTitle" placeholder="新节点标题" />
						<select id="addNodeType">
							<option value="implement">implement</option>
							<option value="review">review</option>
							<option value="test">test</option>
							<option value="verify">verify</option>
							<option value="project">project</option>
						</select>
						<button id="addNodeBtn" class="secondary" style="font-size:10px;white-space:nowrap">+ 添加节点</button>
					</div>
				</div>
			</div>
		</div>
		<div id="nodeDetailOverlay" class="node-detail-overlay" style="display:none"></div>

		<div id="tab-verification" class="tab-panel">
			<div class="section">
				<div class="section-header">Verification Gate</div>
				<div class="section-body" id="verificationView">
					<div class="card-meta">暂无验证数据</div>
				</div>
			</div>
		</div>

		<div id="tab-artifacts" class="tab-panel">
			<div class="section">
				<div class="section-header">
					<span>Projection Artifacts</span>
					<span id="artifactCount" class="pill pill-neutral">0</span>
				</div>
				<div class="section-body" id="artifactView">
					<div class="card-meta">暂无工件</div>
				</div>
			</div>
		</div>

		<div id="tab-reasoning" class="tab-panel">
			<div class="section">
				<div class="section-header">推理链 (Reasoning Traces)</div>
				<div class="section-body" id="reasoningView">
					<div class="card-meta">暂无推理记录</div>
				</div>
			</div>
		</div>

		<div id="tab-timeline" class="tab-panel">
			<div class="section">
				<div class="section-header">Activity Timeline</div>
				<div class="section-body" id="activityView">
					<div class="card-meta">暂无活动</div>
				</div>
			</div>
		</div>

		<div id="tab-insight" class="tab-panel">
			<div class="section">
				<div class="section-header">物化与耗时</div>
				<div class="section-body" id="insightHarness">
					<div class="card-meta">暂无数据</div>
				</div>
			</div>
			<div class="section">
				<div class="section-header">DAG 拓扑（依赖）</div>
				<div class="section-body" id="insightDag">
					<div class="card-meta">暂无执行图</div>
				</div>
			</div>
			<div class="section">
				<div class="section-header">物化文件</div>
				<div class="section-body" id="insightFiles">
					<div class="card-meta">暂无物化记录</div>
				</div>
			</div>
		</div>
	</div>
</div>
<script>
const vscode = acquireVsCodeApi();
let snapshot = undefined;

function esc(v) {
	return String(v || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}

function pillClass(status) {
	if (['passed','completed','pass'].includes(status)) return 'pill-ok';
	if (['blocked','failed','critical'].includes(status)) return 'pill-bad';
	if (['warning','running','ready'].includes(status)) return 'pill-warn';
	if (['unknown'].includes(status)) return 'pill-neutral';
	return 'pill-info';
}

const phaseText = {
	idle: '就绪', intent_workspace: '接收需求',
	analyzing: '需求分析中...', awaiting_confirmation: '等待确认',
	planning: '任务规划中...', execution: '执行中',
	verification: '验证中', projection: '完成', blocked: '已阻塞'
};

function render() {
	if (!snapshot) return;

	const phase = snapshot.phase || 'idle';
	const badge = document.getElementById('phaseBadge');
	badge.textContent = phaseText[phase] || phase;
	badge.className = 'phase-badge phase-' + phase;

	renderIntents();
	renderCost();
	renderAnalysis();
	renderGraph();
	renderVerification();
	renderArtifacts();
	renderReasoning();
	renderTimeline();
	renderInsight();
	updateIntentCardEditor();
	updateToolbarState();
}

function renderIntents() {
	const intents = snapshot.intents || [];
	const activeId = snapshot.activeIntentId;
	document.getElementById('intentCount').textContent = intents.length;

	const el = document.getElementById('intentList');
	if (!intents.length) { el.innerHTML = '<div class="card-meta">暂无任务</div>'; return; }

	const statusText = { draft: '草稿', planned: '已规划', running: '执行中', projected: '已完成', verified: '已验证' };

	el.innerHTML = intents.map(i => {
		const cls = i.id === activeId ? 'card active' : 'card';
		return '<div class="' + cls + '" data-intent="' + esc(i.id) + '">' +
			'<div style="display:flex;justify-content:space-between;align-items:start">' +
				'<div class="card-title" style="flex:1">' + esc(i.title) + '</div>' +
				'<button class="delete-intent-btn" data-delete-intent="' + esc(i.id) + '" title="删除" style="background:#dc3545;color:#fff;border:none;border-radius:3px;padding:1px 6px;cursor:pointer;font-size:11px;margin-left:6px">✕</button>' +
			'</div>' +
			'<div class="card-meta">' +
				'<span class="pill ' + pillClass(i.status) + '">' + esc(statusText[i.status] || i.status) + '</span>' +
			'</div>' +
		'</div>';
	}).join('');

	el.querySelectorAll('[data-intent]').forEach(card => {
		card.addEventListener('click', (e) => {
			if (e.target.classList.contains('delete-intent-btn')) return;
			vscode.postMessage({ type: 'selectIntent', payload: { intentId: card.getAttribute('data-intent') } });
		});
	});
	el.querySelectorAll('[data-delete-intent]').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'deleteIntent', payload: { intentId: btn.getAttribute('data-delete-intent') } });
		});
	});
}

function renderAnalysis() {
	const container = document.getElementById('analysisContainer');
	const analysis = snapshot.pendingAnalysis;

	if (!analysis || snapshot.phase !== 'awaiting_confirmation') {
		container.style.display = 'none';
		return;
	}

	container.style.display = '';
	let html = '<div class="analysis-panel">';
	html += '<div class="analysis-title">需求分析报告</div>';
	html += '<div class="analysis-section" style="border:1px solid var(--accent);border-radius:6px;padding:10px;margin-bottom:12px;background:rgba(14,99,156,0.06)">';
	html += '<div class="analysis-section-title" style="color:var(--accent)">需求对齐与验收（请核对与您的目标一致）</div>';
	if (analysis.userStatedCore && analysis.userStatedCore.trim()) {
		html += '<div style="margin-bottom:8px"><span style="font-size:10px;color:var(--muted);text-transform:uppercase">您的原意</span><br><span style="font-size:12px">' + esc(analysis.userStatedCore) + '</span></div>';
	}
	if (analysis.systemInterpretation && analysis.systemInterpretation.trim()) {
		html += '<div style="margin-bottom:8px"><span style="font-size:10px;color:var(--muted);text-transform:uppercase">系统理解</span><br><span style="font-size:12px;line-height:1.5">' + esc(analysis.systemInterpretation) + '</span></div>';
	}
	if (analysis.alignmentRisks && analysis.alignmentRisks.length) {
		html += '<div style="margin-bottom:8px"><span style="font-size:10px;color:var(--warn);text-transform:uppercase">对齐风险</span><ul class="analysis-list">' +
			analysis.alignmentRisks.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></div>';
	}
	if (analysis.proposedAcceptanceCriteria && analysis.proposedAcceptanceCriteria.length) {
		html += '<div><span style="font-size:10px;color:var(--ok);text-transform:uppercase">建议验收标准（将用于验证门）</span><ul class="analysis-list">' +
			analysis.proposedAcceptanceCriteria.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul></div>';
	} else {
		html += '<div style="font-size:11px;color:var(--warn)">未解析到验收锚点（ACCEPTANCE_CRITERION），请在下方补充说明或点「重新分析」。</div>';
	}
	html += '</div>';

	if (analysis.brainstormDirectors && analysis.brainstormDirectors.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">资深产品总监头脑风暴（' + analysis.brainstormDirectors.length + ' 人）</div>';
		html += '<ul class="analysis-list" style="max-height:120px;overflow-y:auto">' +
			analysis.brainstormDirectors.map(d => '<li style="font-size:11px">' + esc(d) + '</li>').join('') + '</ul></div>';
	}
	if (analysis.brainstormSynthesis && analysis.brainstormSynthesis.trim()) {
		html += '<div class="analysis-section"><div class="analysis-section-title">头脑风暴整合纪要</div>';
		html += '<div style="font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:140px;overflow-y:auto;color:var(--vscode-descriptionForeground)">' + esc(analysis.brainstormSynthesis) + '</div></div>';
	}
	if (analysis.projectDirectorSummary && analysis.projectDirectorSummary.trim()) {
		html += '<div class="analysis-section" style="border-left:3px solid #9c27b0"><div class="analysis-section-title">项目总监统筹结论（分析阶段虚拟角色）</div>';
		html += '<div style="font-size:12px;line-height:1.6;white-space:pre-wrap;max-height:160px;overflow-y:auto">' + esc(analysis.projectDirectorSummary) + '</div></div>';
	}
	if (analysis.detailedPrdBody && analysis.detailedPrdBody.trim()) {
		html += '<div class="analysis-section"><div class="analysis-section-title">详尽需求说明文档（PRD 草案）</div>';
		html += '<div style="font-size:11px;line-height:1.55;white-space:pre-wrap;max-height:320px;overflow-y:auto;padding:8px;background:rgba(255,255,255,0.03);border-radius:4px;border:1px solid var(--border)">' + esc(analysis.detailedPrdBody) + '</div></div>';
	}

	if (analysis.webResearchSummary && analysis.webResearchSummary.trim()) {
		html += '<div class="analysis-section"><div class="analysis-section-title">联网检索与对标</div>';
		html += '<div style="font-size:12px;line-height:1.6;margin-bottom:8px;white-space:pre-wrap;color:var(--vscode-descriptionForeground)">' + esc(analysis.webResearchSummary) + '</div></div>';
	}

	if (analysis.featureMatrixItems && analysis.featureMatrixItems.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">功能矩阵（详尽）</div>';
		html += '<ul class="analysis-list">' + analysis.featureMatrixItems.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul></div>';
	}

	html += '<div class="analysis-section"><div class="analysis-section-title">需求理解摘要</div>';
	if (analysis.requirementUnderstandingShort && analysis.requirementUnderstandingShort.trim()) {
		html += '<div style="font-size:12px;line-height:1.6;margin-bottom:8px">' + esc(analysis.requirementUnderstandingShort) + '</div></div>';
	} else if (!analysis.detailedPrdBody) {
		html += '<div style="font-size:12px;line-height:1.6;margin-bottom:8px">' + esc(analysis.fullSpec) + '</div></div>';
	} else {
		html += '<div class="card-meta" style="margin-bottom:8px">主规格见上方 PRD；合并全文已写入 Intent 供 Planner/实现使用。</div></div>';
	}

	html += '<div class="analysis-section"><div class="analysis-section-title">补充或修改需求（可选）</div>';
	html += '<textarea id="analysisRefinement" rows="3" placeholder="在此输入你对需求的补充说明、修改或澄清...&#10;例如：数据使用本地JSON、增加搜索功能、不需要登录模块"></textarea></div>';

	if (analysis.techStack && analysis.techStack.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">技术方案</div>';
		html += '<div>' + analysis.techStack.map(t => '<span class="analysis-tag tech">' + esc(t) + '</span>').join('') + '</div></div>';
	}

	const complexity = { simple: '简单', medium: '中等', complex: '复杂' };
	html += '<div class="analysis-section"><div class="analysis-section-title">复杂度评估</div>';
	html += '<span class="pill ' + (analysis.estimatedComplexity === 'complex' ? 'pill-warn' : 'pill-ok') + '">' + (complexity[analysis.estimatedComplexity] || '中等') + '</span></div>';

	if (analysis.ambiguities && analysis.ambiguities.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">识别到的模糊点</div>';
		html += '<ul class="analysis-list">' + analysis.ambiguities.map(a => '<li>' + esc(a) + '</li>').join('') + '</ul></div>';
	}

	if (analysis.assumptions && analysis.assumptions.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">当前假设 <span style="font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">（取消勾选 = 拒绝该假设）</span></div>';
		html += '<div style="margin-top:4px">' + analysis.assumptions.map((a, i) =>
			'<label style="display:flex;align-items:start;gap:6px;margin-bottom:4px;cursor:pointer;font-size:12px">' +
				'<input type="checkbox" class="assumption-check" data-idx="' + i + '" checked style="margin-top:3px;accent-color:var(--ok)">' +
				'<span>' + esc(a) + '</span>' +
			'</label>'
		).join('') + '</div></div>';
	}

	if (analysis.questions && analysis.questions.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">待确认问题 <span style="font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">（可直接回答）</span></div>';
		html += '<div style="margin-top:4px">' + analysis.questions.map((q, i) =>
			'<div style="margin-bottom:8px">' +
				'<div style="font-size:12px;color:var(--warn);margin-bottom:3px">' + esc(q) + '</div>' +
				'<input type="text" class="question-answer" data-idx="' + i + '" placeholder="输入你的回答（留空则由 AI 自行判断）" style="width:100%">' +
			'</div>'
		).join('') + '</div></div>';
	}

	if (analysis.suggestedFeatures && analysis.suggestedFeatures.length) {
		html += '<div class="analysis-section"><div class="analysis-section-title">建议补充的功能 <span style="font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">（勾选 = 采纳）</span></div>';
		html += '<div style="margin-top:4px">' + analysis.suggestedFeatures.map((f, i) =>
			'<label style="display:flex;align-items:start;gap:6px;margin-bottom:4px;cursor:pointer;font-size:12px">' +
				'<input type="checkbox" class="suggestion-check" data-idx="' + i + '" style="margin-top:3px;accent-color:var(--info)">' +
				'<span style="color:var(--info)">' + esc(f) + '</span>' +
			'</label>'
		).join('') + '</div></div>';
	}

	html += '<div class="analysis-confirm-bar">';
	html += '<button id="confirmAnalysisBtn" class="success" style="flex:1;padding:8px;font-size:13px;font-weight:600">确认需求，开始生成</button>';
	html += '<button id="reanalyzeBtn" class="secondary" style="padding:8px">重新分析</button>';
	html += '<button id="cancelAnalysisBtn" class="danger" style="padding:8px">取消</button>';
	html += '</div>';
	html += '</div>';

	container.innerHTML = html;

	document.getElementById('confirmAnalysisBtn').addEventListener('click', () => {
		const refinement = document.getElementById('analysisRefinement').value.trim();

		const acceptedAssumptions = [];
		const rejectedAssumptions = [];
		document.querySelectorAll('.assumption-check').forEach(cb => {
			const idx = parseInt(cb.getAttribute('data-idx'));
			if (analysis.assumptions && analysis.assumptions[idx]) {
				if (cb.checked) { acceptedAssumptions.push(analysis.assumptions[idx]); }
				else { rejectedAssumptions.push(analysis.assumptions[idx]); }
			}
		});

		const questionAnswers = [];
		document.querySelectorAll('.question-answer').forEach(input => {
			const idx = parseInt(input.getAttribute('data-idx'));
			const answer = input.value.trim();
			if (answer && analysis.questions && analysis.questions[idx]) {
				questionAnswers.push(analysis.questions[idx] + ' → ' + answer);
			}
		});

		const adoptedSuggestions = [];
		document.querySelectorAll('.suggestion-check').forEach(cb => {
			const idx = parseInt(cb.getAttribute('data-idx'));
			if (cb.checked && analysis.suggestedFeatures && analysis.suggestedFeatures[idx]) {
				adoptedSuggestions.push(analysis.suggestedFeatures[idx]);
			}
		});

		vscode.postMessage({
			type: 'confirmAndExecute',
			payload: {
				refinement,
				acceptedAssumptions,
				rejectedAssumptions,
				questionAnswers,
				adoptedSuggestions,
			}
		});
	});

	document.getElementById('reanalyzeBtn').addEventListener('click', () => {
		const refinement = document.getElementById('analysisRefinement').value.trim();
		if (refinement && analysis.intentId) {
			vscode.postMessage({
				type: 'reanalyze',
				payload: { intentId: analysis.intentId, additionalContext: refinement }
			});
		} else {
			alert('请先在"补充或修改需求"中输入你的修改，再点击重新分析');
		}
	});

	document.getElementById('cancelAnalysisBtn').addEventListener('click', () => {
		if (analysis.intentId) {
			vscode.postMessage({ type: 'deleteIntent', payload: { intentId: analysis.intentId } });
		}
	});
}

function renderCost() {
	const ledger = snapshot.costLedger || { totalCost: 0, totalTokens: 0 };
	document.getElementById('totalCost').textContent = '¥' + ledger.totalCost.toFixed(4);
	document.getElementById('totalTokens').textContent = ledger.totalTokens.toLocaleString();
}

function renderGraph() {
	const activeId = snapshot.activeIntentId;
	const graph = (snapshot.executionGraphs || []).find(g => g.intentId === activeId) || snapshot.executionGraphs?.[0];
	const el = document.getElementById('graphView');
	const progressEl = document.getElementById('graphProgress');

	if (!graph) { el.innerHTML = '<div class="card-meta">暂无执行任务</div>'; progressEl.textContent = '0%'; return; }

	const percent = graph.progress?.percent || 0;
	progressEl.textContent = percent + '%';
	progressEl.className = 'pill ' + (percent >= 100 ? 'pill-ok' : 'pill-info');

	const statusIcon = { pending: '⏳', ready: '🔵', running: '⚙️', completed: '✅', blocked: '✅', failed: '✅', skipped: '⏭' };
	const statusText = { pending: '等待中', ready: '就绪', running: '执行中', completed: '已完成', blocked: '已完成', failed: '已完成', skipped: '已跳过' };
	const roleText = { analyst: '需求分析', planner: '任务规划', implementer: '代码生成', reviewer: '代码审查', tester: '自动测试', verifier: '质量验证', refiner: '代码优化' };

	el.innerHTML = '<div class="progress-bar-container"><div class="progress-bar-fill" style="width:' + percent + '%"></div></div>' +
		graph.nodes.map(n => {
			const icon = statusIcon[n.status] || '⏳';
			const cls = n.status === 'running' ? 'step-active' : n.status === 'completed' || n.status === 'failed' || n.status === 'blocked' ? 'step-done' : 'step-pending';

			return '<div class="step-card ' + cls + '" data-node-detail="' + esc(n.id) + '">' +
				'<div style="display:flex;align-items:center;gap:8px">' +
					'<span class="step-status-icon">' + icon + '</span>' +
					'<div style="flex:1">' +
						'<div style="font-weight:600;font-size:12px">' + esc(n.title) + '</div>' +
						'<div class="card-meta">' + esc(roleText[n.workerRole] || n.workerRole) + ' · ' + esc(statusText[n.status] || n.status) + '</div>' +
					'</div>' +
				'</div>' +
			'</div>';
		}).join('');

	el.querySelectorAll('[data-node-detail]').forEach(nodeEl => {
		nodeEl.addEventListener('click', () => showNodeDetail(nodeEl.getAttribute('data-node-detail')));
	});
}

function showNodeDetail(nodeId) {
	const overlay = document.getElementById('nodeDetailOverlay');
	if (!snapshot || !nodeId) { overlay.style.display = 'none'; return; }

	const activeId = snapshot.activeIntentId;
	const graph = (snapshot.executionGraphs || []).find(g => g.intentId === activeId);
	const node = graph?.nodes?.find(n => n.id === nodeId);
	if (!node) { overlay.style.display = 'none'; return; }

	const run = (snapshot.workerRuns || []).filter(r => r.nodeId === nodeId).pop();

	const roleText = { analyst: '需求分析师', planner: '任务规划器', implementer: '代码生成器', reviewer: '代码审查器', tester: '自动测试器', verifier: '质量验证器', refiner: '代码优化器' };

	let html = '<div class="node-detail-panel">';
	html += '<div style="display:flex;justify-content:space-between;align-items:center"><h3>' + esc(node.title) + '</h3><button class="secondary" id="closeDetailBtn">✕ 关闭</button></div>';

	html += '<div class="node-detail-section">';
	html += '<div class="node-detail-kv"><span class="k">执行角色</span><span>' + esc(roleText[node.workerRole] || node.workerRole) + '</span></div>';
	html += '</div>';

	if (run) {
		const dur = run.finishedAt ? ((run.finishedAt - run.startedAt)/1000).toFixed(1) + '秒' : '执行中...';
		html += '<div class="node-detail-section"><div class="node-detail-section-title">执行详情</div>';
		html += '<div class="node-detail-kv"><span class="k">AI 模型</span><span style="font-weight:600;color:#4fc3f7">' + esc(run.modelId) + '</span></div>';
		html += '<div class="node-detail-kv"><span class="k">耗时</span><span>' + dur + '</span></div>';
		if (run.outputSummary) {
			html += '<div style="margin-top:8px;font-size:11px;font-weight:600;color:var(--muted)">AI 输出：</div>';
			html += '<div class="exec-node-result" style="max-height:400px;margin-top:4px;white-space:pre-wrap">' + esc(run.outputSummary) + '</div>';
		}
		html += '</div>';
	}

	html += '</div>';
	overlay.innerHTML = html;
	overlay.style.display = 'flex';

	document.getElementById('closeDetailBtn').addEventListener('click', () => { overlay.style.display = 'none'; });
	overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
}

function renderVerification() {
	const activeId = snapshot.activeIntentId;
	const bundles = (snapshot.verificationBundles || []).filter(b => !activeId || b.intentId === activeId);
	const el = document.getElementById('verificationView');

	if (!bundles.length) { el.innerHTML = '<div class="card-meta">暂无验证数据</div>'; return; }

	el.innerHTML = bundles.map(b => {
		const channelNames = { lint: '代码检查', typecheck: '类型检查', tests: '测试', review: '审查', security: '安全', symbolic: '逻辑验证' };
		const sections = ['lint','typecheck','tests','review','security','symbolic'].map(key => {
			const s = b[key];
			if (!s) return '';
			return '<div style="margin-bottom:4px">' +
				'<span class="pill ' + pillClass(s.status) + '">' + esc(channelNames[key] || key) + ': ' + esc(s.status) + '</span> ' +
				'<span class="card-meta">' + esc(s.summary) + '</span>' +
			'</div>';
		}).join('');

		return '<div class="card">' +
			'<div class="card-title"><span class="pill ' + pillClass(b.overallStatus) + '">' + esc(b.overallStatus) + '</span> ' + esc(b.summary) + '</div>' +
			'<div style="margin-top:6px">' + sections + '</div>' +
		'</div>';
	}).join('');
}

function renderArtifacts() {
	const activeId = snapshot.activeIntentId;
	const artifacts = (snapshot.artifacts || []).filter(a => !activeId || a.intentId === activeId);
	document.getElementById('artifactCount').textContent = artifacts.length;
	const el = document.getElementById('artifactView');

	if (!artifacts.length) { el.innerHTML = '<div class="card-meta">暂无生成文件</div>'; return; }

	el.innerHTML = artifacts.map(a =>
		'<div class="card"><div class="card-title">' + esc(a.title) + '</div>' +
		'<div class="card-meta">' + esc(a.summary) + '</div></div>'
	).join('');
}

function renderReasoning() {
	const runs = snapshot.workerRuns || [];
	const el = document.getElementById('reasoningView');
	if (!runs.length) { el.innerHTML = '<div class="card-meta">暂无执行记录</div>'; return; }

	const roleText = { analyst: '需求分析', planner: '任务规划', implementer: '代码生成', reviewer: '代码审查', tester: '自动测试', verifier: '质量验证', refiner: '代码优化' };

	el.innerHTML = runs.map(r => {
		const dur = r.finishedAt ? ((r.finishedAt - r.startedAt) / 1000).toFixed(1) + 's' : '执行中...';
		return '<div class="card">' +
			'<div class="exec-node-header"><span class="card-title">' + esc(roleText[r.role] || r.role) + '</span>' +
			'<span><span class="pill ' + pillClass(r.status) + '">' + esc(r.status) + '</span><span class="pill pill-neutral">' + dur + '</span></span></div>' +
			'<div class="card-meta">' + esc(r.modelId) + '</div>' +
			(r.outputSummary ? '<div class="exec-node-result" style="max-height:200px">' + esc(r.outputSummary) + '</div>' : '') +
		'</div>';
	}).join('');
}

function renderTimeline() {
	const activities = snapshot.activities || [];
	const el = document.getElementById('activityView');
	if (!activities.length) { el.innerHTML = '<div class="card-meta">暂无活动</div>'; return; }

	el.innerHTML = activities.slice(0, 30).map(a => {
		const sev = a.severity === 'failure' ? ' severity-failure' : a.severity === 'warning' ? ' severity-warning' : a.severity === 'success' ? ' severity-success' : '';
		return '<div class="timeline-item' + sev + '"><div class="timeline-dot ' + esc(a.kind) + '"></div>' +
		'<div class="timeline-content"><div class="timeline-title">' + esc(a.title) + '</div>' +
		'<div class="timeline-desc">' + esc(a.description) + '</div></div></div>';
	}).join('');
}

function renderInsight() {
	const h = snapshot.harnessRuntime || {};
	const elH = document.getElementById('insightHarness');
	if (elH) {
		const rootNote = h.lastMaterializeRoot === 'worktree'
			? '<div class="card-meta" style="margin-top:6px">物化根：<strong>worktree</strong>。下列路径为相对路径；文件在 <code>.sentinel/worktrees/&lt;intentId&gt;/</code> 下，「打开」仅适用于已镜像到主仓的路径。</div>'
			: h.lastMaterializeRoot === 'staging'
				? '<div class="card-meta" style="margin-top:6px">物化根：<strong>影子 VFS</strong>（Promote 前不在主仓）。</div>'
				: '';
		elH.innerHTML =
			'<div class="card"><div class="card-title">上一节点</div><div class="card-meta">' + esc(h.lastExecutedNodeTitle || '—') + '</div></div>' +
			'<div class="card" style="margin-top:8px"><div class="card-title">端到端耗时</div><div class="card-meta">' +
			(h.lastNodeExecutionMs != null ? ((h.lastNodeExecutionMs / 1000).toFixed(2) + ' s') : '—') +
			'</div></div>' + rootNote;
	}
	const activeId = snapshot.activeIntentId;
	const graph = (snapshot.executionGraphs || []).find(g => g.intentId === activeId);
	const elD = document.getElementById('insightDag');
	if (elD) {
		if (!graph || !graph.nodes || !graph.nodes.length) {
			elD.innerHTML = '<div class="card-meta">暂无执行图</div>';
		} else {
			elD.innerHTML = graph.nodes.map(n =>
				'<div class="card" style="margin-bottom:6px">' +
				'<div class="card-title">' + esc(n.title) + ' <span class="pill pill-neutral">' + esc(n.status) + '</span></div>' +
				'<div class="card-meta">依赖 → ' + esc((n.dependencies || []).join(', ') || '（根节点）') + '</div>' +
				'</div>'
			).join('');
		}
	}
	const files = activeId && h.materializedFilesByIntent ? h.materializedFilesByIntent[activeId] : [];
	const elF = document.getElementById('insightFiles');
	if (!elF) { return; }
	if (!files || !files.length) {
		elF.innerHTML = '<div class="card-meta">当前意图暂无物化记录（worktree/主仓写入后在此聚合）</div>';
		return;
	}
	elF.innerHTML = files.map(p =>
		'<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px">' +
		'<span class="card-meta" style="word-break:break-all;flex:1">' + esc(p) + '</span>' +
		'<button type="button" class="secondary open-mat-file-btn" data-path="' + esc(p) + '" style="flex-shrink:0;font-size:10px">打开</button>' +
		'</div>'
	).join('');
	elF.querySelectorAll('.open-mat-file-btn').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const path = btn.getAttribute('data-path');
			if (path) { vscode.postMessage({ type: 'openWorkspaceRelative', payload: { path } }); }
		});
	});
}

/* Tab switching */
document.querySelectorAll('.tab-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
		document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
		btn.classList.add('active');
		document.getElementById('tab-' + btn.getAttribute('data-tab')).classList.add('active');
	});
});

/* Section toggle */
document.querySelectorAll('.section-header').forEach(header => {
	header.addEventListener('click', () => {
		const body = header.nextElementSibling;
		if (body) body.classList.toggle('collapsed');
	});
});

/* Button handlers */
document.getElementById('createIntentBtn').addEventListener('click', () => {
	const msg = document.getElementById('intentInput').value.trim();
	if (msg) {
		vscode.postMessage({ type: 'createIntent', payload: { message: msg } });
		document.getElementById('intentInput').value = '';
	}
});
document.getElementById('advanceBtn').addEventListener('click', () => vscode.postMessage({ type: 'advanceActiveIntent' }));
document.getElementById('runPipelineBtn').addEventListener('click', () => vscode.postMessage({ type: 'runFullPipeline' }));
document.getElementById('pauseBtn').addEventListener('click', () => vscode.postMessage({ type: 'pauseExecution' }));
document.getElementById('resumeBtn').addEventListener('click', () => vscode.postMessage({ type: 'resumeExecution' }));

/* Messages from extension */
window.addEventListener('message', event => {
	const msg = event.data;
	if (msg.type === 'snapshot') {
		snapshot = msg.payload;
		render();
		const statusBar = document.getElementById('statusBar');
		if (statusBar) { statusBar.textContent = ''; statusBar.style.display = 'none'; }
	} else if (msg.type === 'status') {
		let statusBar = document.getElementById('statusBar');
		if (!statusBar) {
			statusBar = document.createElement('div');
			statusBar.id = 'statusBar';
			statusBar.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:6px 16px;background:var(--accent);color:#fff;font-size:12px;z-index:9999;text-align:center;';
			document.body.prepend(statusBar);
		}
		if (msg.payload.text) { statusBar.textContent = msg.payload.text; statusBar.style.display = 'block'; }
		else { statusBar.style.display = 'none'; }
	} else if (msg.type === 'panelVisible') {
		document.documentElement.style.height = '100%';
		document.body.style.minHeight = '100%';
		void document.body.offsetHeight;
		if (!snapshot) {
			vscode.postMessage({ type: 'requestSnapshot' });
		} else {
			render();
		}
	} else if (msg.type === 'error') {
		let statusBar = document.getElementById('statusBar');
		if (!statusBar) {
			statusBar = document.createElement('div');
			statusBar.id = 'statusBar';
			statusBar.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:6px 16px;background:var(--bad);color:#fff;font-size:12px;z-index:9999;text-align:center;';
			document.body.prepend(statusBar);
		}
		statusBar.textContent = msg.payload.message;
		statusBar.style.background = 'var(--bad)';
		statusBar.style.display = 'block';
		setTimeout(() => { statusBar.style.display = 'none'; }, 8000);
	}
});

/* IntentCard editor */
document.getElementById('saveCardBtn').addEventListener('click', () => {
	const activeId = snapshot?.activeIntentId;
	if (!activeId) return;
	const parse = v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
	vscode.postMessage({
		type: 'updateIntentCard',
		payload: {
			intentId: activeId,
			card: {
				nonGoals: parse(document.getElementById('cardNonGoals').value),
				allowedFiles: parse(document.getElementById('cardAllowedFiles').value),
				successCriteria: parse(document.getElementById('cardSuccessCriteria').value),
				stopIf: parse(document.getElementById('cardStopIf').value),
			}
		}
	});
});

function updateIntentCardEditor() {
	const section = document.getElementById('intentCardSection');
	if (!snapshot?.activeIntentId) { section.style.display = 'none'; return; }
	section.style.display = '';

	const intent = (snapshot.intents || []).find(i => i.id === snapshot.activeIntentId);
	if (intent && intent.intentCard) {
		const card = intent.intentCard;
		const ng = document.getElementById('cardNonGoals');
		const af = document.getElementById('cardAllowedFiles');
		const sc = document.getElementById('cardSuccessCriteria');
		const si = document.getElementById('cardStopIf');
		if (ng && !ng._userEdited) ng.value = (card.nonGoals || []).join(', ');
		if (af && !af._userEdited) af.value = (card.allowedFiles || []).join(', ');
		if (sc && !sc._userEdited) sc.value = (card.successCriteria || []).join(', ');
		if (si && !si._userEdited) si.value = (card.stopIf || []).join(', ');
	}
}

function updateToolbarState() {
	const pauseBtn = document.getElementById('pauseBtn');
	const resumeBtn = document.getElementById('resumeBtn');
	const runBtn = document.getElementById('runPipelineBtn');
	const advBtn = document.getElementById('advanceBtn');
	if (pauseBtn && resumeBtn) {
		const isRunning = snapshot?.phase === 'execution';
		const isAwaiting = snapshot?.phase === 'awaiting_confirmation';
		pauseBtn.style.display = isRunning ? '' : 'none';
		resumeBtn.style.display = (!isRunning && !isAwaiting && snapshot?.activeIntentId && snapshot?.phase !== 'idle') ? '' : 'none';
		runBtn.style.display = isAwaiting ? 'none' : '';
		advBtn.style.display = isAwaiting ? 'none' : '';
	}
}

['cardNonGoals','cardAllowedFiles','cardSuccessCriteria','cardStopIf'].forEach(id => {
	const el = document.getElementById(id);
	if (el) el.addEventListener('input', () => { el._userEdited = true; });
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}
}
