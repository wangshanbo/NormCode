/*---------------------------------------------------------------------------------------------
 *  Sentinel Intent Graph Service
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { createIntent, CreateIntentOptions, Intent, IntentGraph, IntentLink } from '../common/intentTypes.js';

export const IIntentGraphService = createDecorator<IIntentGraphService>('IIntentGraphService');

export interface IIntentGraphService {
	readonly _serviceBrand: undefined;
	readonly onDidUpdateGraph: Event<IntentGraph>;

	getGraph(): IntentGraph;
	/** 从磁盘恢复的完整图（替换内存） */
	hydrate(graph: IntentGraph): void;
	createIntent(goal: string, options?: CreateIntentOptions): Intent;
	getIntent(intentId: string): Intent | undefined;
	listIntents(): Intent[];
	updateIntent(intentId: string, update: Partial<Intent>): Intent | undefined;
	deleteIntent(intentId: string): boolean;
	linkIntents(sourceIntentId: string, targetIntentId: string, label: string): IntentLink;
}

export class IntentGraphService extends Disposable implements IIntentGraphService {
	readonly _serviceBrand: undefined;

	private readonly _graph: IntentGraph = {
		id: 'sentinel_intent_graph',
		intents: [],
		links: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	private readonly _onDidUpdateGraph = this._register(new Emitter<IntentGraph>());
	readonly onDidUpdateGraph = this._onDidUpdateGraph.event;

	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	getGraph(): IntentGraph {
		return {
			...this._graph,
			intents: [...this._graph.intents],
			links: [...this._graph.links],
		};
	}

	hydrate(graph: IntentGraph): void {
		this._graph.id = graph.id;
		this._graph.intents = graph.intents.map(i => ({ ...i, intentCard: { ...i.intentCard } }));
		this._graph.links = graph.links.map(l => ({ ...l }));
		this._graph.rootIntentId = graph.rootIntentId;
		this._graph.createdAt = graph.createdAt;
		this._graph.updatedAt = graph.updatedAt;
		this.logService.info(`[Sentinel] Intent graph hydrated: ${this._graph.intents.length} intents`);
		this._onDidUpdateGraph.fire(this.getGraph());
	}

	createIntent(goal: string, options?: CreateIntentOptions): Intent {
		const intent = createIntent(goal, options);
		this._graph.intents.push(intent);
		this._graph.rootIntentId = this._graph.rootIntentId || intent.id;
		this.touch();
		this.logService.info(`[Sentinel] Intent created: ${intent.id}`);
		return intent;
	}

	getIntent(intentId: string): Intent | undefined {
		return this._graph.intents.find(item => item.id === intentId);
	}

	listIntents(): Intent[] {
		return [...this._graph.intents];
	}

	updateIntent(intentId: string, update: Partial<Intent>): Intent | undefined {
		const intent = this.getIntent(intentId);
		if (!intent) {
			return undefined;
		}

		Object.assign(intent, update, { updatedAt: Date.now() });
		this.touch();
		return intent;
	}

	deleteIntent(intentId: string): boolean {
		const idx = this._graph.intents.findIndex(item => item.id === intentId);
		if (idx < 0) {
			return false;
		}
		this._graph.intents.splice(idx, 1);
		this._graph.links = this._graph.links.filter(
			l => l.sourceIntentId !== intentId && l.targetIntentId !== intentId
		);
		if (this._graph.rootIntentId === intentId) {
			this._graph.rootIntentId = this._graph.intents[0]?.id;
		}
		this.touch();
		this.logService.info(`[Sentinel] Intent deleted: ${intentId}`);
		return true;
	}

	linkIntents(sourceIntentId: string, targetIntentId: string, label: string): IntentLink {
		const link: IntentLink = {
			id: `intent_link_${Date.now()}_${this._graph.links.length}`,
			sourceIntentId,
			targetIntentId,
			label,
		};
		this._graph.links.push(link);
		this.touch();
		return link;
	}

	private touch(): void {
		this._graph.updatedAt = Date.now();
		this._onDidUpdateGraph.fire(this.getGraph());
	}
}

registerSingleton(IIntentGraphService, IntentGraphService, InstantiationType.Delayed);
