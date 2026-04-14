/*---------------------------------------------------------------------------------------------
 *  Task Graph Pane — DAG 可视化面板
 *  以 Webview 渲染有向无环图，展示任务依赖关系和执行状态
 *---------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWebviewService, IOverlayWebview } from '../../webview/browser/webview.js';
import { ITaskGraphService } from '../../../services/aiCore/browser/taskGraphService.js';
import { ICheckpointService } from '../../../services/aiCore/browser/checkpointService.js';
import {
	TaskNodeStatus,
	serializeTaskGraph,
} from '../../../services/aiCore/common/taskGraphTypes.js';

export const TASK_GRAPH_VIEW_ID = 'workbench.view.aicore.taskGraph';

export class TaskGraphPane extends ViewPane {

	private _webview: IOverlayWebview | undefined;
	private _container: HTMLElement | undefined;

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
		@ITaskGraphService private readonly taskGraphService: ITaskGraphService,
		@ICheckpointService private readonly checkpointService: ICheckpointService,
	) {
		super(options, keybindingService, contextMenuService, configurationService,
			contextKeyService, viewDescriptorService, instantiationService, openerService,
			themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._container = container;
		container.style.padding = '0';

		this._webview = this.webviewService.createWebviewOverlay({
			providedViewType: 'taskGraphPane',
			title: 'Task Graph',
			options: {
				retainContextWhenHidden: true,
				enableFindWidget: false,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [],
			},
			extension: undefined,
		});

		this._webview.setHtml(this.generateHTML());
		this._webview.layoutWebviewOverElement(container);

		this._register(this._webview.onMessage(e => this.handleMessage(e.message)));

		this._register(this.taskGraphService.onDidUpdateGraph(graph => {
			this._webview?.postMessage({
				type: 'graphUpdated',
				payload: { graph: serializeTaskGraph(graph) },
			});
		}));

		this._register(this.taskGraphService.onDidUpdatePlan(plan => {
			this._webview?.postMessage({
				type: 'planUpdated',
				payload: { plan },
			});
		}));

		this._register(this.taskGraphService.onDidChangeNodeStatus(e => {
			this._webview?.postMessage({
				type: 'nodeStatusChanged',
				payload: e,
			});
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._webview && this._container) {
			this._webview.layoutWebviewOverElement(this._container, new Dimension(width, height));
		}
	}

	private handleMessage(message: unknown): void {
		const msg = message as { type: string; payload?: Record<string, unknown> };

		switch (msg.type) {
			case 'ready': {
				const graph = this.taskGraphService.getGraph();
				const plan = this.taskGraphService.getPlan();
				if (graph && plan) {
					this._webview?.postMessage({
						type: 'init',
						payload: { graph: serializeTaskGraph(graph), plan },
					});
				}
				break;
			}
			case 'startTask':
				if (msg.payload?.nodeId) {
					this.taskGraphService.updateNodeStatus(
						msg.payload.nodeId as string,
						TaskNodeStatus.InProgress,
					);
				}
				break;
			case 'retryTask':
				if (msg.payload?.nodeId) {
					this.taskGraphService.updateNodeStatus(
						msg.payload.nodeId as string,
						TaskNodeStatus.Pending,
					);
				}
				break;
			case 'skipTask':
				if (msg.payload?.nodeId) {
					this.taskGraphService.updateNodeStatus(
						msg.payload.nodeId as string,
						TaskNodeStatus.Skipped,
					);
				}
				break;
			case 'pauseExecution':
				this.taskGraphService.pause();
				break;
			case 'resumeExecution':
				this.taskGraphService.resume();
				break;
			case 'rollbackToCheckpoint':
				if (msg.payload?.checkpointId) {
					this.checkpointService.rollbackTo(msg.payload.checkpointId as string).then(ok => {
						this.logService.info(`[TaskGraphPane] Rollback ${ok ? 'succeeded' : 'failed'}`);
					});
				}
				break;
			case 'editPlan':
				if (msg.payload?.executionOrder) {
					this.taskGraphService.reorderExecution(msg.payload.executionOrder as string[]);
				}
				break;
		}
	}

	private generateHTML(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
	--bg: var(--vscode-editor-background, #1e1e1e);
	--fg: var(--vscode-editor-foreground, #d4d4d4);
	--border: var(--vscode-panel-border, #2d2d2d);
	--accent: var(--vscode-button-background, #0078d4);
	--success: #4caf50;
	--warning: #ff9800;
	--error: #f44336;
	--node-bg: var(--vscode-editorWidget-background, #252526);
	--node-hover: var(--vscode-list-hoverBackground, #2a2d2e);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
	background: var(--bg);
	color: var(--fg);
	font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
	font-size: 13px;
	overflow: hidden;
}

.container {
	display: flex;
	flex-direction: column;
	height: 100vh;
}

/* 顶部工具栏 */
.toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--border);
	background: var(--node-bg);
}
.toolbar .progress-text { flex: 1; font-size: 12px; opacity: 0.8; }
.toolbar button {
	background: var(--accent);
	color: #fff;
	border: none;
	padding: 4px 10px;
	border-radius: 3px;
	cursor: pointer;
	font-size: 12px;
}
.toolbar button:hover { opacity: 0.9; }
.toolbar button.secondary {
	background: transparent;
	color: var(--fg);
	border: 1px solid var(--border);
}
.toolbar button.secondary:hover { background: var(--node-hover); }

/* 图谱画布 */
.canvas-wrapper {
	flex: 1;
	overflow: auto;
	padding: 20px;
}

.graph-canvas {
	position: relative;
	min-width: 100%;
	min-height: 100%;
}

/* 任务节点 */
.task-node {
	position: absolute;
	width: 180px;
	padding: 10px 12px;
	background: var(--node-bg);
	border: 1px solid var(--border);
	border-radius: 6px;
	cursor: pointer;
	transition: all 0.15s;
}
.task-node:hover { background: var(--node-hover); border-color: var(--accent); }
.task-node.critical { border-left: 3px solid var(--accent); }
.task-node.completed { border-color: var(--success); }
.task-node.in_progress { border-color: var(--warning); animation: pulse 1.5s infinite; }
.task-node.failed { border-color: var(--error); }
.task-node.ready { border-color: var(--accent); border-style: dashed; }

@keyframes pulse {
	0%, 100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.2); }
	50% { box-shadow: 0 0 0 4px rgba(255, 152, 0, 0.1); }
}

.node-header {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 4px;
}
.node-status {
	width: 8px; height: 8px;
	border-radius: 50%;
	flex-shrink: 0;
}
.node-status.pending { background: #666; }
.node-status.ready { background: var(--accent); }
.node-status.in_progress { background: var(--warning); }
.node-status.completed { background: var(--success); }
.node-status.failed { background: var(--error); }
.node-status.skipped { background: #999; }
.node-status.blocked { background: #888; }

.node-title {
	font-size: 12px;
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex: 1;
}
.node-type {
	font-size: 10px;
	opacity: 0.6;
	margin-top: 2px;
}
.node-actions {
	display: none;
	margin-top: 6px;
	gap: 4px;
}
.task-node:hover .node-actions { display: flex; }
.node-actions button {
	font-size: 11px;
	padding: 2px 6px;
	background: var(--accent);
	color: #fff;
	border: none;
	border-radius: 3px;
	cursor: pointer;
}

/* SVG 边线 */
svg.edges {
	position: absolute;
	top: 0;
	left: 0;
	pointer-events: none;
}
svg.edges line {
	stroke: var(--border);
	stroke-width: 1.5;
}
svg.edges line.critical {
	stroke: var(--accent);
	stroke-width: 2;
	stroke-dasharray: 6 3;
}
svg.edges polygon { fill: var(--border); }
svg.edges polygon.critical { fill: var(--accent); }

/* 空状态 */
.empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	height: 100%;
	gap: 12px;
	opacity: 0.6;
}
.empty-state .icon { font-size: 48px; }
.empty-state .text { font-size: 14px; }
.empty-state .hint { font-size: 12px; opacity: 0.7; }
</style>
</head>
<body>
<div class="container">
	<div class="toolbar">
		<span class="progress-text" id="progressText">No active task graph</span>
		<button class="secondary" id="btnPause" style="display:none;">⏸ Pause</button>
		<button id="btnResume" style="display:none;">▶ Resume</button>
	</div>
	<div class="canvas-wrapper" id="canvasWrapper">
		<div class="empty-state" id="emptyState">
			<div class="icon">📊</div>
			<div class="text">No Task Graph</div>
			<div class="hint">Start a Spec session to generate a task graph</div>
		</div>
		<div class="graph-canvas" id="graphCanvas" style="display:none;"></div>
	</div>
</div>
<script>
(function() {
	const vscode = acquireVsCodeApi();
	let currentGraph = null;
	let currentPlan = null;

	const NODE_WIDTH = 180;
	const NODE_HEIGHT = 70;
	const COL_GAP = 60;
	const ROW_GAP = 30;
	const PADDING = 40;

	function render() {
		if (!currentGraph || Object.keys(currentGraph.nodes).length === 0) {
			document.getElementById('emptyState').style.display = 'flex';
			document.getElementById('graphCanvas').style.display = 'none';
			return;
		}

		document.getElementById('emptyState').style.display = 'none';
		const canvas = document.getElementById('graphCanvas');
		canvas.style.display = 'block';

		renderProgress();
		renderNodes(canvas);
		renderEdges(canvas);
	}

	function renderProgress() {
		if (!currentPlan) return;
		const el = document.getElementById('progressText');
		el.textContent = currentGraph.name + ' — ' + currentPlan.progress + '% complete';

		document.getElementById('btnPause').style.display = currentPlan.isPaused ? 'none' : 'inline-block';
		document.getElementById('btnResume').style.display = currentPlan.isPaused ? 'inline-block' : 'none';
	}

	function renderNodes(canvas) {
		// 清除旧节点
		canvas.querySelectorAll('.task-node').forEach(n => n.remove());

		const nodes = currentGraph.nodes;
		let maxX = 0, maxY = 0;

		for (const [id, node] of Object.entries(nodes)) {
			const x = PADDING + node.column * (NODE_WIDTH + COL_GAP);
			const y = PADDING + node.row * (NODE_HEIGHT + ROW_GAP);

			maxX = Math.max(maxX, x + NODE_WIDTH);
			maxY = Math.max(maxY, y + NODE_HEIGHT);

			const isCritical = (currentGraph.criticalPath || []).includes(id);

			const el = document.createElement('div');
			el.className = 'task-node ' + node.status + (isCritical ? ' critical' : '');
			el.style.left = x + 'px';
			el.style.top = y + 'px';
			el.dataset.nodeId = id;
			el.title = node.description || node.title;

			const typeIcons = { implementation: '💻', test: '🧪', documentation: '📝', review: '👀', design: '🎨', checkpoint: '📌' };

			el.innerHTML =
				'<div class="node-header">' +
					'<span class="node-status ' + node.status + '"></span>' +
					'<span class="node-title">' + escapeHtml(node.title) + '</span>' +
				'</div>' +
				'<div class="node-type">' + (typeIcons[node.type] || '📋') + ' ' + node.type + '</div>' +
				'<div class="node-actions">' +
					(node.status === 'ready' || node.status === 'pending'
						? '<button onclick="startTask(\\'' + id + '\\')">▶ Start</button>'
						: '') +
					(node.status === 'failed' || node.status === 'blocked'
						? '<button onclick="retryTask(\\'' + id + '\\')">↻ Retry</button>'
						: '') +
				'</div>';

			canvas.appendChild(el);
		}

		canvas.style.width = (maxX + PADDING) + 'px';
		canvas.style.height = (maxY + PADDING) + 'px';
	}

	function renderEdges(canvas) {
		let svg = canvas.querySelector('svg.edges');
		if (svg) svg.remove();

		const edges = currentGraph.edges || [];
		if (edges.length === 0) return;

		const w = parseInt(canvas.style.width) || 800;
		const h = parseInt(canvas.style.height) || 600;

		svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'edges');
		svg.setAttribute('width', w);
		svg.setAttribute('height', h);

		const nodes = currentGraph.nodes;

		for (const edge of edges) {
			const src = nodes[edge.source];
			const tgt = nodes[edge.target];
			if (!src || !tgt) continue;

			const x1 = PADDING + src.column * (NODE_WIDTH + COL_GAP) + NODE_WIDTH;
			const y1 = PADDING + src.row * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2;
			const x2 = PADDING + tgt.column * (NODE_WIDTH + COL_GAP);
			const y2 = PADDING + tgt.row * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2;

			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', x1);
			line.setAttribute('y1', y1);
			line.setAttribute('x2', x2 - 6);
			line.setAttribute('y2', y2);
			if (edge.isCritical) line.setAttribute('class', 'critical');
			svg.appendChild(line);

			// 箭头
			const angle = Math.atan2(y2 - y1, x2 - x1);
			const arrowSize = 6;
			const ax = x2 - 2;
			const ay = y2;
			const p1x = ax - arrowSize * Math.cos(angle - 0.4);
			const p1y = ay - arrowSize * Math.sin(angle - 0.4);
			const p2x = ax - arrowSize * Math.cos(angle + 0.4);
			const p2y = ay - arrowSize * Math.sin(angle + 0.4);

			const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
			arrow.setAttribute('points', ax+','+ay+' '+p1x+','+p1y+' '+p2x+','+p2y);
			if (edge.isCritical) arrow.setAttribute('class', 'critical');
			svg.appendChild(arrow);
		}

		canvas.insertBefore(svg, canvas.firstChild);
	}

	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	// Global actions
	window.startTask = function(nodeId) {
		vscode.postMessage({ type: 'startTask', payload: { nodeId } });
	};
	window.retryTask = function(nodeId) {
		vscode.postMessage({ type: 'retryTask', payload: { nodeId } });
	};

	document.getElementById('btnPause').addEventListener('click', () => {
		vscode.postMessage({ type: 'pauseExecution' });
	});
	document.getElementById('btnResume').addEventListener('click', () => {
		vscode.postMessage({ type: 'resumeExecution' });
	});

	// Message handling
	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.type) {
			case 'init':
				currentGraph = msg.payload.graph;
				currentPlan = msg.payload.plan;
				render();
				break;
			case 'graphUpdated':
				currentGraph = msg.payload.graph;
				render();
				break;
			case 'planUpdated':
				currentPlan = msg.payload.plan;
				renderProgress();
				break;
			case 'nodeStatusChanged':
				if (currentGraph && currentGraph.nodes[msg.payload.nodeId]) {
					currentGraph.nodes[msg.payload.nodeId].status = msg.payload.status;
					render();
				}
				break;
		}
	});

	// Ready
	vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
	}
}
