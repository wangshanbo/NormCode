/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatModeSelectionCard } from '../../../common/chatService/chatService.js';
import { IChatProgressRenderableResponseContent } from '../../../common/model/chatModel.js';
import { IChatContentPart } from './chatContentParts.js';

const $ = dom.$;

export class ChatModeSelectionCardContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		private readonly card: IChatModeSelectionCard,
		@ICommandService private readonly commandService: ICommandService
	) {
		super();

		this.domNode = $('.chat-mode-selection-card');
		const header = dom.append(this.domNode, $('.chat-mode-selection-card-header'));
		dom.append(header, $('h2.chat-mode-selection-card-title', undefined, "Let's build"));
		dom.append(header, $('p.chat-mode-selection-card-subtitle', undefined, '同一个对话页完成 Vibe ↔ Spec 全流程'));

		const modeRow = dom.append(this.domNode, $('.chat-mode-selection-card-mode-row'));
		modeRow.appendChild(this.createModeCard(
			'Vibe',
			'先聊后做，快速验证与迭代',
			'aicore.switchToVibeMode',
			this.card.currentMode === 'vibe'
		));
		modeRow.appendChild(this.createModeCard(
			'Spec',
			'先规划后做，结构化推进任务',
			'aicore.switchToSpecMode',
			this.card.currentMode === 'spec'
		));

		if (this.card.session) {
			const sessionMeta = `会话 ${this.card.session.id} · 阶段 ${this.card.session.phase} · 进度 ${this.card.session.completed}/${this.card.session.total}（${this.card.session.progressPercent}%） · 待执行 ${this.card.session.pending}`;
			dom.append(this.domNode, $('div.chat-mode-selection-card-session', undefined, sessionMeta));
		}

		const quickActions = dom.append(this.domNode, $('.chat-mode-selection-card-actions'));
		this.appendActionButton(quickActions, '执行下一个任务', 'aicore.executeNextTask');
		this.appendActionButton(quickActions, '并行执行全部任务', 'aicore.executeAllTasks');
		this.appendActionButton(quickActions, '回写已完成任务', 'aicore.checkCompletedTasks');
	}

	private createModeCard(title: string, description: string, commandId: string, active: boolean): HTMLElement {
		const card = document.createElement('button');
		card.className = 'chat-mode-card';
		card.classList.toggle('active', active);
		card.type = 'button';
		dom.append(card, $('div.chat-mode-card-title', undefined, title));
		dom.append(card, $('div.chat-mode-card-description', undefined, description));
		this._register(dom.addDisposableListener(card, dom.EventType.CLICK, () => {
			void this.commandService.executeCommand(commandId);
		}));
		return card;
	}

	private appendActionButton(container: HTMLElement, label: string, commandId: string): void {
		const actionContainer = dom.append(container, $('.chat-mode-selection-card-action'));
		const actionButton = this._register(new Button(actionContainer, { ...defaultButtonStyles, secondary: true }));
		actionButton.label = label;
		this._register(actionButton.onDidClick(() => {
			void this.commandService.executeCommand(commandId);
		}));
	}

	hasSameContent(other: IChatProgressRenderableResponseContent): boolean {
		if (other.kind !== 'modeSelectionCard') {
			return false;
		}

		const left = this.card.session;
		const right = other.session;
		if (!left && !right) {
			return this.card.currentMode === other.currentMode;
		}
		if (!left || !right) {
			return false;
		}

		return this.card.currentMode === other.currentMode
			&& left.id === right.id
			&& left.phase === right.phase
			&& left.completed === right.completed
			&& left.total === right.total
			&& left.pending === right.pending
			&& left.progressPercent === right.progressPercent;
	}
}
