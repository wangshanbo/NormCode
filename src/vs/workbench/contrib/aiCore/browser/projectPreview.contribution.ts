/*---------------------------------------------------------------------------------------------
 *  Project Preview — 内置项目预览 + 跨端导出中间层（定稿 / 选端 / 一键生成）
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { webviewGenericCspSource } from '../../webview/common/webview.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { ICrossPlatformExportService } from '../../../services/aiCore/browser/crossPlatformExportService.js';

/** 与 Simple Browser 浮层约定一致：用于 IBrowserElementsService 定位 webview */
export const PROJECT_PREVIEW_VIEW_TYPE = 'aicore.projectPreview';

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;');
}

function buildProjectPreviewHtml(url: string): string {
	const nonce = generateUuid();
	const safeUrl = escapeAttr(url);
	const title = escapeAttr(localize('projectPreview.exportBarTitle', 'Finalize & generate per-platform projects'));
	const finalizedL = escapeAttr(localize('projectPreview.finalizedLabel', 'I confirm the Web preview is finalized'));
	const tw = escapeAttr(localize('projectPreview.targetWeb', 'Web'));
	const ti = escapeAttr(localize('projectPreview.targetIos', 'iOS'));
	const ta = escapeAttr(localize('projectPreview.targetAndroid', 'Android'));
	const tq = escapeAttr(localize('projectPreview.targetWechat', 'WeChat Mini Program'));
	const gen = escapeAttr(localize('projectPreview.generateBtn', 'Generate all selected platforms (exports/…/project)'));
	const hint0 = escapeAttr(localize('projectPreview.selectHint', 'Use the chat overlay (bottom-right) to pick a DOM element and send it to Chat for fixes.'));
	const stIdle = escapeAttr(localize('projectPreview.exportStatusIdle', 'Ready. After finalizing, generate docs under exports/.'));

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src ${webviewGenericCspSource}; script-src 'nonce-${nonce}'; frame-src http: https: data: blob:;">
	<style>
		:root { color-scheme: light dark; }
		body { margin: 0; display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); font-size: 13px; }
		.toolbar { display: flex; gap: 6px; padding: 6px 8px; align-items: center; border-bottom: 1px solid var(--vscode-widget-border, #3333); background: var(--vscode-editor-background); flex-shrink: 0; }
		.toolbar input { flex: 1; min-width: 0; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; }
		.toolbar button { padding: 4px 10px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
		.toolbar button:disabled { opacity: 0.5; cursor: default; }
		.hint { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px; flex-shrink: 0; }
		.export-panel { border-top: 1px solid var(--vscode-widget-border, #3333); padding: 8px; background: var(--vscode-sideBar-background); flex-shrink: 0; font-size: 12px; }
		.export-panel h3 { margin: 0 0 6px 0; font-size: 12px; font-weight: 600; }
		.export-row { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; margin-bottom: 6px; }
		.export-row label { cursor: pointer; user-select: none; }
		.export-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
		#export-status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; max-height: 48px; overflow: auto; }
		.frame-wrap { flex: 1; min-height: 0; position: relative; }
		iframe { width: 100%; height: 100%; border: 0; background: #fff; }
	</style>
</head>
<body>
	<div class="toolbar">
		<button type="button" id="back" title="Back">←</button>
		<button type="button" id="fwd" title="Forward">→</button>
		<button type="button" id="reload" title="Reload">↻</button>
		<input type="text" id="url" value="${safeUrl}" spellcheck="false" />
		<button type="button" id="go">Go</button>
	</div>
	<div class="hint">${hint0}</div>
	<div class="export-panel">
		<h3>${title}</h3>
		<div class="export-row">
			<label><input type="checkbox" id="finalized-chk" /> ${finalizedL}</label>
		</div>
		<div class="export-row" id="targets-row">
			<label><input type="checkbox" id="tgt-web" data-target="web" checked /> ${tw}</label>
			<label><input type="checkbox" id="tgt-ios" data-target="ios" checked /> ${ti}</label>
			<label><input type="checkbox" id="tgt-android" data-target="android" checked /> ${ta}</label>
			<label><input type="checkbox" id="tgt-wechat" data-target="wechat_miniprogram" checked /> ${tq}</label>
		</div>
		<div class="export-actions">
			<button type="button" id="btn-generate">${gen}</button>
		</div>
		<div id="export-status">${stIdle}</div>
	</div>
	<div class="frame-wrap">
		<iframe id="preview-frame" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-popups allow-modals" src="${safeUrl}"></iframe>
	</div>
	<script nonce="${nonce}">
(function () {
	const vscode = acquireVsCodeApi();
	const iframe = document.getElementById('preview-frame');
	const urlInput = document.getElementById('url');
	const INITIAL_PREVIEW_URL = ${JSON.stringify(url)};
	function currentUrl() {
		const v = (urlInput.value || '').trim();
		if (!v) { return INITIAL_PREVIEW_URL; }
		try {
			return new URL(v.startsWith('http') ? v : 'http://' + v).toString();
		} catch (_) {
			return INITIAL_PREVIEW_URL;
		}
	}
	function post(action, payload) {
		vscode.postMessage({ type: 'projectPreview', action: action, payload: payload || {} });
	}
	function readTargets() {
		return {
			web: document.getElementById('tgt-web').checked,
			ios: document.getElementById('tgt-ios').checked,
			android: document.getElementById('tgt-android').checked,
			wechat_miniprogram: document.getElementById('tgt-wechat').checked
		};
	}
	function applyManifest(manifest) {
		const st = document.getElementById('export-status');
		if (!manifest) {
			st.textContent = 'No manifest';
			return;
		}
		document.getElementById('finalized-chk').checked = !!manifest.finalized;
		if (manifest.targets) {
			var t = manifest.targets;
			if (document.getElementById('tgt-web')) document.getElementById('tgt-web').checked = !!t.web;
			if (document.getElementById('tgt-ios')) document.getElementById('tgt-ios').checked = !!t.ios;
			if (document.getElementById('tgt-android')) document.getElementById('tgt-android').checked = !!t.android;
			if (document.getElementById('tgt-wechat')) document.getElementById('tgt-wechat').checked = !!t.wechat_miniprogram;
		}
		var lines = [];
		if (manifest.finalized) {
			lines.push('定稿于: ' + (manifest.finalizedAt || ''));
		}
		if (manifest.runs) {
			Object.keys(manifest.runs).forEach(function (k) {
				var r = manifest.runs[k];
				if (r && r.status) {
					lines.push(k + ': ' + r.status + (r.summary ? ' — ' + r.summary : '') + (r.error ? ' — ' + r.error : ''));
				}
			});
		}
		st.textContent = lines.length ? lines.join(' | ') : ${JSON.stringify(localize('projectPreview.exportStatusIdle', 'Ready. After finalizing, generate docs under exports/.'))};
	}
	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (!msg || msg.type !== 'projectPreviewState') { return; }
		var p = msg.payload || {};
		if (p.error) {
			document.getElementById('export-status').textContent = p.error;
			return;
		}
		if (p.manifest) {
			applyManifest(p.manifest);
		}
		if (p.generateDone) {
			document.getElementById('export-status').textContent += ' | 生成流程已结束，请查看 exports/ 目录';
		}
	});
	function go() {
		var v = (urlInput.value || '').trim();
		if (!v) { return; }
		try {
			var u = new URL(v.startsWith('http') ? v : 'http://' + v);
			iframe.src = u.toString();
			urlInput.value = u.toString();
		} catch (e) {
			console.warn('Invalid URL', e);
		}
	}
	document.getElementById('go').addEventListener('click', go);
	urlInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { go(); } });
	document.getElementById('reload').addEventListener('click', function () {
		try { iframe.src = iframe.src; } catch (_) {}
	});
	document.getElementById('back').addEventListener('click', function () {
		try { iframe.contentWindow.history.back(); } catch (_) {}
	});
	document.getElementById('fwd').addEventListener('click', function () {
		try { iframe.contentWindow.history.forward(); } catch (_) {}
	});
	document.getElementById('finalized-chk').addEventListener('change', function () {
		post('setFinalized', { finalized: document.getElementById('finalized-chk').checked, previewUrl: currentUrl() });
	});
	['tgt-web','tgt-ios','tgt-android','tgt-wechat'].forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener('change', function () {
				post('setTargets', { targets: readTargets(), previewUrl: currentUrl() });
			});
		}
	});
	document.getElementById('btn-generate').addEventListener('click', function () {
		post('generate', { previewUrl: currentUrl() });
	});
	post('getState', { previewUrl: currentUrl() });
})();
	</script>
</body>
</html>`;
}

async function resolvePreviewUrl(accessor: ServicesAccessor, explicit?: string): Promise<string | undefined> {
	const config = accessor.get(IConfigurationService);
	const quickInput = accessor.get(IQuickInputService);
	let url = (explicit ?? '').trim();
	if (!url) {
		url = (config.getValue<string>('aiCore.projectPreview.url') || 'http://localhost:5173').trim();
	}
	if (!/^https?:\/\//i.test(url)) {
		url = 'http://' + url;
	}
	try {
		new URL(url);
		return url;
	} catch {
		const picked = await quickInput.input({
			title: localize('projectPreview.inputTitle', 'Project preview URL'),
			placeHolder: localize('projectPreview.placeHolder', 'http://localhost:5173'),
			value: url
		});
		if (!picked) {
			return undefined;
		}
		const t = picked.trim();
		const withScheme = /^https?:\/\//i.test(t) ? t : 'http://' + t;
		try {
			new URL(withScheme);
			return withScheme;
		} catch {
			return undefined;
		}
	}
}

CommandsRegistry.registerCommand('aicore.openProjectPreview', async (accessor, args?: { url?: string } | string) => {
	const webviewWorkbench = accessor.get(IWebviewWorkbenchService);
	const config = accessor.get(IConfigurationService);
	const editorService = accessor.get(IEditorService);
	const crossPlatform = accessor.get(ICrossPlatformExportService);

	const explicit = typeof args === 'string' ? args : args?.url;
	const url = await resolvePreviewUrl(accessor, explicit);
	if (!url) {
		return;
	}

	const openBeside = config.getValue<boolean>('aiCore.projectPreview.openBeside') !== false;
	const title = localize('projectPreview.editorTitle', 'Project Preview');

	const input = webviewWorkbench.openWebview(
		{
			origin: generateUuid(),
			providedViewType: PROJECT_PREVIEW_VIEW_TYPE,
			title,
			options: {
				retainContextWhenHidden: true,
				enableFindWidget: true,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: true,
			},
			extension: undefined,
		},
		PROJECT_PREVIEW_VIEW_TYPE,
		title,
		undefined,
		{
			group: openBeside ? SIDE_GROUP : ACTIVE_GROUP,
			preserveFocus: false,
		}
	);

	input.webview.setHtml(buildProjectPreviewHtml(url));

	const store = new DisposableStore();
	store.add(input.webview.onMessage(e => {
		void crossPlatform.handlePreviewMessage(input.webview, e.message);
	}));
	store.add(input.onWillDispose(() => store.dispose()));

	const pane = editorService.activeEditorPane;
	if (pane) {
		pane.focus();
	}
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: 'aicore.openProjectPreview',
		title: localize2('projectPreview.command', 'AI Core: Open Project Preview'),
	},
});

CommandsRegistry.registerCommand('aicore.snapshotCrossPlatformIR', async (accessor) => {
	const svc = accessor.get(ICrossPlatformExportService);
	await svc.snapshotIrNow();
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: 'aicore.snapshotCrossPlatformIR',
		title: localize2('snapshotIr.command', 'AI Core: Snapshot Cross-Platform IR'),
	},
});
