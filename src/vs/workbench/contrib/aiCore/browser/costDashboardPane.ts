/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 5 — 成本仪表盘 UI

import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IModelRouterService, ModelTier } from '../../../services/aiCore/browser/modelRouterService.js';
import { $, append } from '../../../../base/browser/dom.js';

export const COST_DASHBOARD_VIEW_ID = 'workbench.view.aicore.costDashboard';

export class CostDashboardPane extends ViewPane {

	private container!: HTMLElement;
	private refreshInterval: ReturnType<typeof setInterval> | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IModelRouterService private readonly modelRouter: IModelRouterService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.container = container;
		this.container.style.padding = '12px';
		this.container.style.overflow = 'auto';

		this.renderDashboard();

		this.refreshInterval = setInterval(() => this.renderDashboard(), 5000);

		this._register(this.modelRouter.onDidRecordCost(() => this.renderDashboard()));
		this._register(this.modelRouter.onDidEscalate(() => this.renderDashboard()));
	}

	private renderDashboard(): void {
		const dashboard = this.modelRouter.getCostDashboard();
		this.container.innerHTML = '';

		// Header
		const header = append(this.container, $('div'));
		header.style.cssText = 'font-weight:bold;font-size:14px;margin-bottom:12px;color:var(--vscode-foreground);';
		header.textContent = 'Cost Dashboard';

		// Summary cards
		const grid = append(this.container, $('div'));
		grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;';

		this.renderCard(grid, 'Total Cost', `$${dashboard.totalCost.toFixed(4)}`);
		this.renderCard(grid, 'Total Tokens', this.formatNumber(dashboard.totalTokens));
		this.renderCard(grid, 'Savings vs All-Tier3', `$${dashboard.savings.toFixed(4)}`);
		this.renderCard(grid, 'Escalations', String(dashboard.escalations));

		// Tier breakdown
		const tierSection = append(this.container, $('div'));
		tierSection.style.cssText = 'margin-bottom:16px;';

		const tierTitle = append(tierSection, $('div'));
		tierTitle.style.cssText = 'font-weight:bold;font-size:12px;margin-bottom:8px;color:var(--vscode-foreground);';
		tierTitle.textContent = 'By Tier';

		const tierNames: Record<number, string> = {
			[ModelTier.Tier1_Fast]: 'Tier 1 (Fast)',
			[ModelTier.Tier2_Balanced]: 'Tier 2 (Balanced)',
			[ModelTier.Tier3_Power]: 'Tier 3 (Power)',
		};

		for (const tier of [ModelTier.Tier1_Fast, ModelTier.Tier2_Balanced, ModelTier.Tier3_Power]) {
			const data = dashboard.byTier[tier];
			if (!data) continue;
			this.renderTierBar(tierSection, tierNames[tier] || `Tier ${tier}`, data, dashboard.totalCost);
		}

		// Model breakdown
		const modelSection = append(this.container, $('div'));
		const modelTitle = append(modelSection, $('div'));
		modelTitle.style.cssText = 'font-weight:bold;font-size:12px;margin-bottom:8px;color:var(--vscode-foreground);';
		modelTitle.textContent = 'By Model';

		for (const [model, data] of Object.entries(dashboard.byModel)) {
			this.renderModelRow(modelSection, model, data);
		}

		// Empty state
		if (dashboard.totalTokens === 0) {
			const empty = append(this.container, $('div'));
			empty.style.cssText = 'text-align:center;padding:24px;color:var(--vscode-descriptionForeground);font-size:12px;';
			empty.textContent = 'No cost data yet. Run tasks to see model routing and cost tracking.';
		}
	}

	private renderCard(parent: HTMLElement, label: string, value: string): void {
		const card = append(parent, $('div'));
		card.style.cssText = 'padding:10px;border-radius:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border, #333);';

		const labelEl = append(card, $('div'));
		labelEl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px;';
		labelEl.textContent = label;

		const valueEl = append(card, $('div'));
		valueEl.style.cssText = 'font-size:16px;font-weight:bold;color:var(--vscode-foreground);';
		valueEl.textContent = value;
	}

	private renderTierBar(
		parent: HTMLElement,
		name: string,
		data: { cost: number; tokens: number; count: number },
		totalCost: number,
	): void {
		const row = append(parent, $('div'));
		row.style.cssText = 'margin-bottom:6px;';

		const label = append(row, $('div'));
		label.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:var(--vscode-foreground);margin-bottom:2px;';
		label.innerHTML = `<span>${name} (${data.count} tasks)</span><span>$${data.cost.toFixed(4)}</span>`;

		const barOuter = append(row, $('div'));
		barOuter.style.cssText = 'height:6px;border-radius:3px;background:var(--vscode-editor-background);overflow:hidden;';

		const barInner = append(barOuter, $('div'));
		const pct = totalCost > 0 ? (data.cost / totalCost * 100) : 0;
		const colors: Record<string, string> = {
			'Tier 1 (Fast)': '#4ec9b0',
			'Tier 2 (Balanced)': '#569cd6',
			'Tier 3 (Power)': '#c586c0',
		};
		barInner.style.cssText = `height:100%;border-radius:3px;background:${colors[name] || '#888'};width:${Math.max(2, pct)}%;transition:width 0.3s;`;
	}

	private renderModelRow(
		parent: HTMLElement,
		model: string,
		data: { cost: number; tokens: number; count: number },
	): void {
		const row = append(parent, $('div'));
		row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:11px;color:var(--vscode-foreground);border-bottom:1px solid var(--vscode-widget-border, #333);';
		row.innerHTML = `<span>${model}</span><span>${data.count} tasks / ${this.formatNumber(data.tokens)} tokens / $${data.cost.toFixed(4)}</span>`;
	}

	private formatNumber(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return String(n);
	}

	override dispose(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
		}
		super.dispose();
	}
}
