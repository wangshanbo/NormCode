/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 2 — 意图对齐层 (Intent Refinement)
// 开发者输入模糊意图时，系统从图谱中提取隐含规范，自动补全任务描述

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ICodeGraphService } from './codeGraphService.js';
import { GraphNodeKind } from '../common/codeGraphTypes.js';
import { IDomainOntologyService } from './domainOntologyService.js';

export const IIntentRefinementService = createDecorator<IIntentRefinementService>('IIntentRefinementService');

// ============================================================================
// 类型
// ============================================================================

export interface RefinedIntent {
	/** 原始用户输入 */
	originalInput: string;
	/** 补全后的意图描述 */
	refinedDescription: string;
	/** 从代码图谱推断出的工程约束 */
	inferredConstraints: InferredConstraint[];
	/** 推荐涉及的文件 */
	suggestedFiles: string[];
	/** 推荐的实现模式（来自历史代码） */
	suggestedPatterns: CodePattern[];
	/** 相关的已有组件/模块 */
	relatedComponents: string[];
	/** 置信度 (0-1) */
	confidence: number;
}

export interface InferredConstraint {
	source: 'code_graph' | 'naming_convention' | 'dependency_pattern' | 'documentation';
	constraint: string;
	evidence: string;
}

export interface CodePattern {
	name: string;
	description: string;
	example: string;
	usageCount: number;
}

// ============================================================================
// 接口
// ============================================================================

export interface IIntentRefinementService {
	readonly _serviceBrand: undefined;

	readonly onDidRefine: Event<RefinedIntent>;

	/** 对模糊意图进行细化 */
	refine(userInput: string): Promise<RefinedIntent>;

	/** 获取代码库中常用的编码模式 */
	discoverPatterns(): CodePattern[];
}

// ============================================================================
// 意图关键词映射表
// ============================================================================

interface IntentMapping {
	keywords: string[];
	constraints: string[];
	patterns: string[];
	relatedNodeKinds: GraphNodeKind[];
}

const INTENT_MAPPINGS: IntentMapping[] = [
	{
		keywords: ['login', 'signin', 'auth', 'authenticate', '登录', '认证', '登陆'],
		constraints: [
			'Likely requires JWT or session-based authentication',
			'Consider password hashing (bcrypt/argon2)',
			'Check for existing auth middleware/guard patterns',
			'CSRF protection may be needed for web forms',
		],
		patterns: ['middleware-guard', 'service-repository', 'token-refresh'],
		relatedNodeKinds: [GraphNodeKind.Class, GraphNodeKind.Interface],
	},
	{
		keywords: ['api', 'endpoint', 'route', 'rest', 'graphql', '接口', '路由'],
		constraints: [
			'Follow existing route naming conventions',
			'Check for existing validation/dto patterns',
			'Error response format should be consistent',
			'Consider rate limiting and auth requirements',
		],
		patterns: ['controller-service', 'dto-validation', 'error-handler'],
		relatedNodeKinds: [GraphNodeKind.Class, GraphNodeKind.Function],
	},
	{
		keywords: ['database', 'db', 'model', 'schema', 'migration', 'table', '数据库', '表', '模型'],
		constraints: [
			'Use existing ORM/query builder patterns',
			'Check for migration strategy',
			'Consider indexes and foreign keys',
			'Soft delete vs hard delete convention',
		],
		patterns: ['repository-pattern', 'migration', 'seed-data'],
		relatedNodeKinds: [GraphNodeKind.Class, GraphNodeKind.Interface],
	},
	{
		keywords: ['test', 'spec', 'unit', 'e2e', 'integration', '测试', '单元'],
		constraints: [
			'Follow existing test file naming convention',
			'Use project testing framework (jest/mocha/pytest)',
			'Include edge cases and error paths',
			'Mock external dependencies',
		],
		patterns: ['arrange-act-assert', 'test-fixture', 'mock-factory'],
		relatedNodeKinds: [GraphNodeKind.Function, GraphNodeKind.Class],
	},
	{
		keywords: ['component', 'widget', 'ui', 'view', 'page', '组件', '页面', '界面'],
		constraints: [
			'Follow existing component structure/naming',
			'Check for existing design system components',
			'Consider responsive design requirements',
			'Accessibility (a11y) compliance',
		],
		patterns: ['composition-api', 'render-props', 'container-presenter'],
		relatedNodeKinds: [GraphNodeKind.Class, GraphNodeKind.Function],
	},
	{
		keywords: ['refactor', 'optimize', 'improve', 'clean', '重构', '优化', '整理'],
		constraints: [
			'Maintain backward compatibility',
			'Update all existing tests',
			'Check for downstream consumers',
			'Document breaking changes',
		],
		patterns: ['extract-method', 'strategy-pattern', 'facade'],
		relatedNodeKinds: [GraphNodeKind.Class, GraphNodeKind.Function, GraphNodeKind.Module],
	},
];

// ============================================================================
// 实现
// ============================================================================

export class IntentRefinementService extends Disposable implements IIntentRefinementService {
	readonly _serviceBrand: undefined;

	private readonly _onDidRefine = this._register(new Emitter<RefinedIntent>());
	readonly onDidRefine = this._onDidRefine.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICodeGraphService private readonly codeGraph: ICodeGraphService,
		@IDomainOntologyService private readonly domainOntology: IDomainOntologyService,
	) {
		super();
	}

	async refine(userInput: string): Promise<RefinedIntent> {
		this.logService.info(`[IntentRefinementService] Refining intent: "${userInput}"`);

		const input = userInput.toLowerCase();

		// 匹配意图类别
		const matchedMappings = INTENT_MAPPINGS.filter(
			m => m.keywords.some(kw => input.includes(kw))
		);

		// 从代码图谱中查找相关节点
		const graphResults = await this.queryCodeGraph(userInput);
		const relatedComponents = graphResults.map(n => n.qualifiedName || n.name);
		const suggestedFiles = [...new Set(graphResults.map(n => n.uri))];

		// 汇总推断约束
		const inferredConstraints: InferredConstraint[] = [];

		for (const mapping of matchedMappings) {
			for (const constraint of mapping.constraints) {
				inferredConstraints.push({
					source: 'code_graph',
					constraint,
					evidence: `Matched keywords: ${mapping.keywords.filter(kw => input.includes(kw)).join(', ')}`,
				});
			}
		}

		// 从图谱推断命名约定
		const namingConstraints = this.inferNamingConventions(graphResults);
		inferredConstraints.push(...namingConstraints);

		// 从依赖图推断架构模式
		const depConstraints = this.inferDependencyPatterns(graphResults);
		inferredConstraints.push(...depConstraints);

		// 从领域图谱中获取工程约束（package.json / .cursorrules / 配置文件 / 文档）
		const domainContext = this.domainOntology.getContextForIntent(userInput);
		if (domainContext) {
			inferredConstraints.push({
				source: 'documentation',
				constraint: 'Domain ontology provides additional engineering context (see refined description)',
				evidence: `Ontology matched ${userInput}`,
			});
		}

		// 构建补全后的描述
		const refinedDescription = this.buildRefinedDescription(userInput, inferredConstraints, relatedComponents)
			+ (domainContext ? `\n\n${domainContext}` : '');

		// 发现匹配的编码模式
		const suggestedPatterns = this.discoverPatterns().filter(
			p => matchedMappings.some(m => m.patterns.includes(p.name))
		);

		const result: RefinedIntent = {
			originalInput: userInput,
			refinedDescription,
			inferredConstraints,
			suggestedFiles: suggestedFiles.slice(0, 10),
			suggestedPatterns,
			relatedComponents: relatedComponents.slice(0, 15),
			confidence: this.calculateConfidence(matchedMappings.length, graphResults.length),
		};

		this._onDidRefine.fire(result);

		this.logService.info(
			`[IntentRefinementService] Refined: ${inferredConstraints.length} constraints, ` +
			`${suggestedFiles.length} files, confidence=${result.confidence.toFixed(2)}`
		);

		return result;
	}

	discoverPatterns(): CodePattern[] {
		return [
			{
				name: 'middleware-guard',
				description: 'Middleware/Guard pattern for request interception',
				example: 'class AuthGuard { canActivate(ctx) { ... } }',
				usageCount: 0,
			},
			{
				name: 'service-repository',
				description: 'Service-Repository pattern for data access layer',
				example: 'class UserService { constructor(private repo: UserRepo) {} }',
				usageCount: 0,
			},
			{
				name: 'controller-service',
				description: 'Controller delegates business logic to Service',
				example: 'class UserController { getUser(id) { return this.service.find(id); } }',
				usageCount: 0,
			},
			{
				name: 'dto-validation',
				description: 'DTO validation pattern for input sanitization',
				example: 'class CreateUserDto { @IsEmail() email: string; }',
				usageCount: 0,
			},
			{
				name: 'arrange-act-assert',
				description: 'AAA pattern for test organization',
				example: 'it("should...", () => { /* arrange */ /* act */ /* assert */ })',
				usageCount: 0,
			},
			{
				name: 'composition-api',
				description: 'Composition API for component logic reuse',
				example: 'function useAuth() { const user = ref(null); return { user }; }',
				usageCount: 0,
			},
			{
				name: 'extract-method',
				description: 'Extract complex logic into named methods',
				example: 'function validateInput(data) { /* extracted logic */ }',
				usageCount: 0,
			},
			{
				name: 'strategy-pattern',
				description: 'Strategy pattern for interchangeable algorithms',
				example: 'interface IStrategy { execute(data): Result }',
				usageCount: 0,
			},
			{
				name: 'facade',
				description: 'Facade pattern for simplified interface',
				example: 'class ApiFacade { auth() {} users() {} orders() {} }',
				usageCount: 0,
			},
			{
				name: 'token-refresh',
				description: 'Token refresh pattern for auth',
				example: 'async refreshToken(oldToken) { /* validate, issue new */ }',
				usageCount: 0,
			},
		];
	}

	// ========================================================================
	// 私有方法
	// ========================================================================

	private async queryCodeGraph(query: string): Promise<Array<{
		name: string;
		qualifiedName: string;
		uri: string;
		kind: GraphNodeKind;
	}>> {
		try {
			const alignment = await this.codeGraph.semanticAlign(query);
			return [
				...alignment.mentionedEntities.map(node => ({
					name: node.name,
					qualifiedName: node.qualifiedName,
					uri: node.uri.toString(),
					kind: node.kind,
				})),
				...alignment.relatedEntities.map(node => ({
					name: node.name,
					qualifiedName: node.qualifiedName,
					uri: node.uri.toString(),
					kind: node.kind,
				})),
			];
		} catch {
			return [];
		}
	}

	private inferNamingConventions(graphResults: Array<{ name: string; kind: GraphNodeKind }>): InferredConstraint[] {
		const constraints: InferredConstraint[] = [];

		// 检测命名模式
		const classNames = graphResults.filter(n => n.kind === GraphNodeKind.Class).map(n => n.name);

		// Service 后缀
		const serviceNames = classNames.filter(n => n.endsWith('Service'));
		if (serviceNames.length > 2) {
			constraints.push({
				source: 'naming_convention',
				constraint: `Project uses "XxxService" naming convention (found: ${serviceNames.slice(0, 3).join(', ')})`,
				evidence: `${serviceNames.length} classes ending with "Service"`,
			});
		}

		// Controller 后缀
		const controllerNames = classNames.filter(n => n.endsWith('Controller'));
		if (controllerNames.length > 1) {
			constraints.push({
				source: 'naming_convention',
				constraint: `Project uses "XxxController" naming convention`,
				evidence: `${controllerNames.length} classes ending with "Controller"`,
			});
		}

		// I 前缀接口
		const interfaceNames = graphResults.filter(n => n.kind === GraphNodeKind.Interface).map(n => n.name);
		const iPrefixed = interfaceNames.filter(n => /^I[A-Z]/.test(n));
		if (iPrefixed.length > 2) {
			constraints.push({
				source: 'naming_convention',
				constraint: `Project uses "IXxx" interface naming convention`,
				evidence: `${iPrefixed.length} interfaces with "I" prefix`,
			});
		}

		return constraints;
	}

	private inferDependencyPatterns(graphResults: Array<{ name: string; kind: GraphNodeKind }>): InferredConstraint[] {
		const constraints: InferredConstraint[] = [];

		const hasServices = graphResults.some(n => n.name.endsWith('Service'));
		const hasControllers = graphResults.some(n => n.name.endsWith('Controller'));

		if (hasServices && hasControllers) {
			constraints.push({
				source: 'dependency_pattern',
				constraint: 'Project follows Controller → Service layered architecture',
				evidence: 'Both Controller and Service classes detected in codebase',
			});
		}

		const hasRepositories = graphResults.some(n =>
			n.name.endsWith('Repository') || n.name.endsWith('Repo')
		);
		if (hasRepositories) {
			constraints.push({
				source: 'dependency_pattern',
				constraint: 'Project uses Repository pattern for data access',
				evidence: 'Repository classes detected in codebase',
			});
		}

		return constraints;
	}

	private buildRefinedDescription(
		original: string,
		constraints: InferredConstraint[],
		relatedComponents: string[],
	): string {
		let desc = `**Task:** ${original}\n\n`;

		if (constraints.length > 0) {
			desc += `**Inferred Constraints:**\n`;
			for (const c of constraints.slice(0, 5)) {
				desc += `- ${c.constraint}\n`;
			}
			desc += '\n';
		}

		if (relatedComponents.length > 0) {
			desc += `**Related Components:** ${relatedComponents.slice(0, 5).join(', ')}\n`;
		}

		return desc;
	}

	private calculateConfidence(mappingCount: number, graphResultCount: number): number {
		const mappingScore = Math.min(1, mappingCount * 0.3);
		const graphScore = Math.min(1, graphResultCount * 0.1);
		return Math.min(1, (mappingScore + graphScore) / 2 + 0.2);
	}
}

registerSingleton(IIntentRefinementService, IntentRefinementService, InstantiationType.Delayed);
