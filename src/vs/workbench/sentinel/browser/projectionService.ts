/*---------------------------------------------------------------------------------------------
 *  Sentinel Projection Service
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ExecutionNode } from '../common/executionTypes.js';
import { Intent } from '../common/intentTypes.js';
import { ProjectionArtifact } from '../common/projectionTypes.js';
import { VerificationBundle } from '../common/verificationTypes.js';
import { WorkerRun } from '../common/workerTypes.js';

export const IProjectionService = createDecorator<IProjectionService>('IProjectionService');

export interface IProjectionService {
	readonly _serviceBrand: undefined;
	project(intent: Intent, node: ExecutionNode, run: WorkerRun, bundle: VerificationBundle): ProjectionArtifact[];
	getArtifacts(intentId: string): ProjectionArtifact[];
	listArtifacts(): ProjectionArtifact[];
	hydrateArtifacts(artifacts: ProjectionArtifact[]): void;
}

export class ProjectionService extends Disposable implements IProjectionService {
	readonly _serviceBrand: undefined;

	private readonly byIntent = new Map<string, ProjectionArtifact[]>();

	project(intent: Intent, node: ExecutionNode, run: WorkerRun, bundle: VerificationBundle): ProjectionArtifact[] {
		const now = Date.now();
		const artifacts: ProjectionArtifact[] = [
			{
				id: `artifact_${now}_${node.id}`,
				intentId: intent.id,
				nodeId: node.id,
				kind: node.type === 'test' ? 'test' : (node.type === 'project' ? 'patch' : 'code'),
				title: `${intent.title} / ${node.title}`,
				location: intent.intentCard.allowedFiles[0],
				summary: run.outputSummary,
				content: [
					`Goal: ${intent.goal}`,
					`Node: ${node.title}`,
					`Worker Output: ${run.outputSummary}`,
					`Verification: ${bundle.summary}`,
				].join('\n'),
				linkedConstraintIds: intent.constraints.map(item => item.id),
				verificationBundleIds: [bundle.id],
				createdAt: now,
			},
		];

		const list = this.byIntent.get(intent.id) || [];
		list.push(...artifacts);
		this.byIntent.set(intent.id, list);
		return artifacts;
	}

	getArtifacts(intentId: string): ProjectionArtifact[] {
		return [...(this.byIntent.get(intentId) || [])];
	}

	listArtifacts(): ProjectionArtifact[] {
		return Array.from(this.byIntent.values()).flatMap(items => items);
	}

	hydrateArtifacts(artifacts: ProjectionArtifact[]): void {
		this.byIntent.clear();
		for (const a of artifacts) {
			const list = this.byIntent.get(a.intentId) || [];
			list.push({ ...a });
			this.byIntent.set(a.intentId, list);
		}
	}
}

registerSingleton(IProjectionService, ProjectionService, InstantiationType.Delayed);
