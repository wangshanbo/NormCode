/*---------------------------------------------------------------------------------------------
 *  Sentinel Projection Types
 *--------------------------------------------------------------------------------------------*/

export type ProjectionArtifactKind = 'code' | 'test' | 'config' | 'doc' | 'assertion' | 'patch' | 'design';
export type PatchOperationKind = 'create' | 'update' | 'delete';

export interface ProjectionArtifact {
	id: string;
	intentId: string;
	nodeId?: string;
	kind: ProjectionArtifactKind;
	title: string;
	location?: string;
	summary: string;
	content: string;
	linkedConstraintIds: string[];
	verificationBundleIds: string[];
	createdAt: number;
}

export interface PatchOperation {
	filePath: string;
	kind: PatchOperationKind;
	summary: string;
	diff?: string;
	newContent?: string;
}

export interface PatchPlan {
	id: string;
	intentId: string;
	nodeId?: string;
	operations: PatchOperation[];
	rationale: string;
	createdAt: number;
}

export interface MaterializationResult {
	artifactIds: string[];
	patchPlan?: PatchPlan;
	summary: string;
}
