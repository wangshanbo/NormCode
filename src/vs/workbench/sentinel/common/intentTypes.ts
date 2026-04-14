/*---------------------------------------------------------------------------------------------
 *  Sentinel Intent Types
 *  终局导向的一等对象：Intent / IntentGraph / IntentCard
 *--------------------------------------------------------------------------------------------*/

export type IntentStatus =
	| 'draft'
	| 'planned'
	| 'running'
	| 'blocked'
	| 'verified'
	| 'projected'
	| 'archived';

export type IntentPriority = 'critical' | 'high' | 'medium' | 'low';

export type IntentConstraintType =
	| 'scope'
	| 'safety'
	| 'architecture'
	| 'validation'
	| 'file_boundary'
	| 'business_rule'
	| 'runtime';

export interface IntentConstraint {
	id: string;
	type: IntentConstraintType;
	label: string;
	description: string;
	blocking: boolean;
}

export interface IntentCard {
	goal: string;
	nonGoals: string[];
	constraints: string[];
	allowedFiles: string[];
	successCriteria: string[];
	stopIf: string[];
}

export type IntentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface Intent {
	id: string;
	title: string;
	goal: string;
	description: string;
	status: IntentStatus;
	priority: IntentPriority;
	riskLevel: IntentRiskLevel;
	intentCard: IntentCard;
	constraints: IntentConstraint[];
	affectedFiles: string[];
	relatedSymbols: string[];
	reasoningTraceIds: string[];
	verificationBundleIds: string[];
	executionGraphIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface IntentLink {
	id: string;
	sourceIntentId: string;
	targetIntentId: string;
	label: string;
}

export interface IntentGraph {
	id: string;
	intents: Intent[];
	links: IntentLink[];
	rootIntentId?: string;
	createdAt: number;
	updatedAt: number;
}

export interface IntentSummary {
	id: string;
	title: string;
	goal: string;
	status: IntentStatus;
	priority: IntentPriority;
	riskLevel: IntentRiskLevel;
	intentCard: IntentCard;
	updatedAt: number;
}

export interface CreateIntentOptions {
	priority?: IntentPriority;
	riskLevel?: IntentRiskLevel;
	description?: string;
	allowedFiles?: string[];
	successCriteria?: string[];
	constraints?: string[];
	nonGoals?: string[];
	stopIf?: string[];
}

export function createIntent(goal: string, options: CreateIntentOptions = {}): Intent {
	const now = Date.now();
	const normalizedGoal = goal.trim();
	const title = normalizedGoal.length > 72 ? `${normalizedGoal.slice(0, 69)}...` : normalizedGoal;

	return {
		id: `intent_${now}`,
		title,
		goal: normalizedGoal,
		description: options.description || normalizedGoal,
		status: 'draft',
		priority: options.priority || 'high',
		riskLevel: options.riskLevel || inferRiskLevel(normalizedGoal, options),
		intentCard: {
			goal: normalizedGoal,
			nonGoals: options.nonGoals || [],
			constraints: options.constraints || [],
			allowedFiles: options.allowedFiles || [],
			successCriteria: options.successCriteria || ['满足目标并通过验证门'],
			stopIf: options.stopIf || ['出现未授权的影响面扩张', '验证门出现阻塞级问题'],
		},
		constraints: (options.constraints || []).map((item, index) => ({
			id: `constraint_${now}_${index}`,
			type: 'scope',
			label: `Constraint ${index + 1}`,
			description: item,
			blocking: true,
		})),
		affectedFiles: options.allowedFiles || [],
		relatedSymbols: [],
		reasoningTraceIds: [],
		verificationBundleIds: [],
		executionGraphIds: [],
		createdAt: now,
		updatedAt: now,
	};
}

function inferRiskLevel(goal: string, options: CreateIntentOptions): IntentRiskLevel {
	const text = goal.toLowerCase();
	const criticalKeywords = ['payment', '支付', 'encrypt', '加密', 'credential', 'secret', 'migration', '迁移'];
	const highKeywords = ['auth', '认证', 'password', '密码', 'token', 'permission', '权限', 'security', '安全', 'database', 'sql', 'rollback'];

	if (criticalKeywords.some(kw => text.includes(kw))) {
		return 'critical';
	}
	if (highKeywords.some(kw => text.includes(kw))) {
		return 'high';
	}
	if ((options.allowedFiles?.length || 0) > 10 || (options.stopIf?.length || 0) > 2) {
		return 'high';
	}
	return 'medium';
}

export function toIntentSummary(intent: Intent): IntentSummary {
	return {
		id: intent.id,
		title: intent.title,
		goal: intent.goal,
		status: intent.status,
		priority: intent.priority,
		riskLevel: intent.riskLevel,
		intentCard: intent.intentCard,
		updatedAt: intent.updatedAt,
	};
}

/** 从快照摘要还原完整 Intent（用于仅有 state.json 时的会话恢复） */
export function intentSummaryToIntent(s: IntentSummary): Intent {
	return {
		id: s.id,
		title: s.title,
		goal: s.goal,
		description: s.goal,
		status: s.status,
		priority: s.priority,
		riskLevel: s.riskLevel,
		intentCard: s.intentCard,
		constraints: [],
		affectedFiles: s.intentCard.allowedFiles || [],
		relatedSymbols: [],
		reasoningTraceIds: [],
		verificationBundleIds: [],
		executionGraphIds: [],
		createdAt: s.updatedAt,
		updatedAt: s.updatedAt,
	};
}

export function intentSummariesToGraph(summaries: IntentSummary[]): IntentGraph {
	const now = Date.now();
	const intents = summaries.map(intentSummaryToIntent);
	const ts = summaries.map(s => s.updatedAt);
	return {
		id: 'sentinel_intent_graph',
		intents,
		links: [],
		rootIntentId: intents[0]?.id,
		createdAt: ts.length ? Math.min(...ts) : now,
		updatedAt: ts.length ? Math.max(...ts) : now,
	};
}
