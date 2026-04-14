/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stage 2 — 自动化领域图谱构建
// 扫描代码注解、历史 PR 记录、.cursorrules 和文档，构建领域本体 (Ontology)

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export const IDomainOntologyService = createDecorator<IDomainOntologyService>('IDomainOntologyService');

// ============================================================================
// 类型
// ============================================================================

export interface OntologyConcept {
	id: string;
	name: string;
	type: ConceptType;
	description: string;
	/** 来源 */
	sources: ConceptSource[];
	/** 关联的代码实体 */
	codeEntities: string[];
	/** 属性/配置 */
	attributes: Record<string, string>;
	/** 出现次数（越高越重要） */
	frequency: number;
}

export enum ConceptType {
	/** 技术栈/框架 */
	Technology = 'technology',
	/** 设计模式 */
	Pattern = 'pattern',
	/** 编码约定 */
	Convention = 'convention',
	/** 业务领域概念 */
	DomainEntity = 'domain_entity',
	/** 架构决策 */
	ArchitecturalDecision = 'architectural_decision',
	/** 工具/库 */
	Library = 'library',
	/** 工作流 */
	Workflow = 'workflow',
}

export interface ConceptSource {
	type: 'code' | 'git_history' | 'cursorrules' | 'documentation' | 'package_json' | 'config';
	path?: string;
	detail: string;
}

export interface OntologyRelation {
	fromId: string;
	toId: string;
	type: RelationType;
	weight: number;
}

export enum RelationType {
	Uses = 'uses',
	DependsOn = 'depends_on',
	Implements = 'implements',
	AlternativeTo = 'alternative_to',
	PartOf = 'part_of',
	Configures = 'configures',
	ReplacedBy = 'replaced_by',
}

export interface DomainOntology {
	concepts: Map<string, OntologyConcept>;
	relations: OntologyRelation[];
	/** 构建时间 */
	builtAt: number;
	/** 来源统计 */
	sourceStats: Record<string, number>;
}

export interface OntologyQuery {
	/** 查找与指定概念相关的所有概念 */
	relatedTo?: string;
	/** 按类型过滤 */
	type?: ConceptType;
	/** 搜索关键词 */
	keyword?: string;
}

// ============================================================================
// 接口
// ============================================================================

export interface IDomainOntologyService {
	readonly _serviceBrand: undefined;

	readonly onDidBuild: Event<DomainOntology>;

	/** 构建完整领域图谱 */
	buildOntology(): Promise<DomainOntology>;

	/** 获取当前图谱 */
	getOntology(): DomainOntology | undefined;

	/** 查询图谱 */
	query(q: OntologyQuery): OntologyConcept[];

	/** 获取某个概念的完整关联网络 */
	getConceptNetwork(conceptId: string, depth?: number): {
		concepts: OntologyConcept[];
		relations: OntologyRelation[];
	};

	/** 为意图对齐提供领域上下文 */
	getContextForIntent(intent: string): string;
}

// ============================================================================
// 实现
// ============================================================================

export class DomainOntologyService extends Disposable implements IDomainOntologyService {
	readonly _serviceBrand: undefined;

	private ontology: DomainOntology | undefined;

	private readonly _onDidBuild = this._register(new Emitter<DomainOntology>());
	readonly onDidBuild = this._onDidBuild.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
	}

	// ========================================================================
	// 构建图谱
	// ========================================================================

	async buildOntology(): Promise<DomainOntology> {
		this.logService.info('[DomainOntologyService] Building domain ontology...');
		const startTime = performance.now();

		const concepts = new Map<string, OntologyConcept>();
		const relations: OntologyRelation[] = [];
		const sourceStats: Record<string, number> = {};

		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			const empty: DomainOntology = { concepts, relations, builtAt: Date.now(), sourceStats };
			this.ontology = empty;
			return empty;
		}

		const root = folders[0].uri;

		// 并行扫描多个来源
		const scanResults = await Promise.allSettled([
			this.scanPackageJson(root),
			this.scanCursorRules(root),
			this.scanConfigFiles(root),
			this.scanDocumentation(root),
			this.scanCodeAnnotations(root),
			this.scanGitHistory(root),
		]);

		const allConcepts: OntologyConcept[] = [];
		const sourceNames = ['package_json', 'cursorrules', 'config', 'documentation', 'code', 'git_history'];

		for (let i = 0; i < scanResults.length; i++) {
			const result = scanResults[i];
			if (result.status === 'fulfilled') {
				allConcepts.push(...result.value);
				sourceStats[sourceNames[i]] = result.value.length;
			}
		}

		// 合并同名概念
		for (const concept of allConcepts) {
			const existing = concepts.get(concept.id);
			if (existing) {
				existing.frequency += concept.frequency;
				existing.sources.push(...concept.sources);
				existing.codeEntities.push(...concept.codeEntities);
				for (const [k, v] of Object.entries(concept.attributes)) {
					existing.attributes[k] = v;
				}
			} else {
				concepts.set(concept.id, concept);
			}
		}

		// 推断关系
		this.inferRelations(concepts, relations);

		this.ontology = { concepts, relations, builtAt: Date.now(), sourceStats };
		this._onDidBuild.fire(this.ontology);

		this.logService.info(
			`[DomainOntologyService] Ontology built: ${concepts.size} concepts, ${relations.length} relations ` +
			`in ${(performance.now() - startTime).toFixed(0)}ms`
		);

		return this.ontology;
	}

	getOntology(): DomainOntology | undefined {
		return this.ontology;
	}

	// ========================================================================
	// 查询
	// ========================================================================

	query(q: OntologyQuery): OntologyConcept[] {
		if (!this.ontology) {
			return [];
		}

		let results = [...this.ontology.concepts.values()];

		if (q.type) {
			results = results.filter(c => c.type === q.type);
		}

		if (q.keyword) {
			const kw = q.keyword.toLowerCase();
			results = results.filter(c =>
				c.name.toLowerCase().includes(kw) ||
				c.description.toLowerCase().includes(kw)
			);
		}

		if (q.relatedTo) {
			const relatedIds = new Set<string>();
			for (const rel of this.ontology.relations) {
				if (rel.fromId === q.relatedTo) {
					relatedIds.add(rel.toId);
				}
				if (rel.toId === q.relatedTo) {
					relatedIds.add(rel.fromId);
				}
			}
			results = results.filter(c => relatedIds.has(c.id));
		}

		return results.sort((a, b) => b.frequency - a.frequency);
	}

	getConceptNetwork(conceptId: string, depth: number = 2): {
		concepts: OntologyConcept[];
		relations: OntologyRelation[];
	} {
		if (!this.ontology) {
			return { concepts: [], relations: [] };
		}

		const visited = new Set<string>();
		const conceptIds = new Set<string>();
		const relevantRelations: OntologyRelation[] = [];

		const traverse = (id: string, currentDepth: number) => {
			if (visited.has(id) || currentDepth > depth) {
				return;
			}
			visited.add(id);
			conceptIds.add(id);

			for (const rel of this.ontology!.relations) {
				if (rel.fromId === id) {
					relevantRelations.push(rel);
					traverse(rel.toId, currentDepth + 1);
				}
				if (rel.toId === id) {
					relevantRelations.push(rel);
					traverse(rel.fromId, currentDepth + 1);
				}
			}
		};

		traverse(conceptId, 0);

		const concepts = [...conceptIds]
			.map(id => this.ontology!.concepts.get(id))
			.filter((c): c is OntologyConcept => !!c);

		return { concepts, relations: relevantRelations };
	}

	// ========================================================================
	// 意图对齐：为 IntentRefinementService 提供领域上下文
	// ========================================================================

	getContextForIntent(intent: string): string {
		if (!this.ontology) {
			return '';
		}

		const intentLower = intent.toLowerCase();
		const relevant = this.query({ keyword: intentLower });

		if (relevant.length === 0) {
			// 尝试词组匹配
			const words = intentLower.split(/\s+/);
			for (const word of words) {
				if (word.length >= 3) {
					relevant.push(...this.query({ keyword: word }));
				}
			}
		}

		if (relevant.length === 0) {
			return '';
		}

		const unique = [...new Map(relevant.map(c => [c.id, c])).values()].slice(0, 10);

		let context = `## Domain Knowledge\n\n`;

		for (const concept of unique) {
			context += `### ${concept.name} (${concept.type})\n`;
			context += `${concept.description}\n`;

			if (Object.keys(concept.attributes).length > 0) {
				for (const [key, value] of Object.entries(concept.attributes)) {
					context += `- ${key}: ${value}\n`;
				}
			}

			context += '\n';
		}

		return context;
	}

	// ========================================================================
	// 扫描器：package.json
	// ========================================================================

	private async scanPackageJson(root: URI): Promise<OntologyConcept[]> {
		const concepts: OntologyConcept[] = [];

		try {
			const pkgUri = URI.joinPath(root, 'package.json');
			const content = (await this.fileService.readFile(pkgUri)).value.toString();
			const pkg = JSON.parse(content);

			const allDeps = {
				...pkg.dependencies,
				...pkg.devDependencies,
			};

			for (const [name, version] of Object.entries(allDeps)) {
				const info = this.identifyLibrary(name);

				concepts.push({
					id: `lib_${name}`,
					name,
					type: info.type,
					description: info.description,
					sources: [{ type: 'package_json', path: 'package.json', detail: `version: ${version}` }],
					codeEntities: [],
					attributes: { version: String(version), category: info.category },
					frequency: 1,
				});
			}

			// 脚本命令
			if (pkg.scripts) {
				for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts)) {
					concepts.push({
						id: `workflow_${scriptName}`,
						name: `npm run ${scriptName}`,
						type: ConceptType.Workflow,
						description: `Build script: ${scriptCmd}`,
						sources: [{ type: 'package_json', path: 'package.json', detail: String(scriptCmd) }],
						codeEntities: [],
						attributes: { command: String(scriptCmd) },
						frequency: 1,
					});
				}
			}
		} catch {
			// 没有 package.json
		}

		return concepts;
	}

	// ========================================================================
	// 扫描器：.cursorrules / .cursor/rules
	// ========================================================================

	private async scanCursorRules(root: URI): Promise<OntologyConcept[]> {
		const concepts: OntologyConcept[] = [];
		const possiblePaths = [
			'.cursorrules',
			'.cursor/rules',
			'.cursor/rules/RULE.md',
			'AGENTS.md',
		];

		for (const relPath of possiblePaths) {
			try {
				const uri = URI.joinPath(root, relPath);
				const content = (await this.fileService.readFile(uri)).value.toString();

				// 提取规则/约定
				const rules = this.extractRulesFromContent(content);
				for (const rule of rules) {
					concepts.push({
						id: `convention_${this.slugify(rule.name)}`,
						name: rule.name,
						type: ConceptType.Convention,
						description: rule.description,
						sources: [{ type: 'cursorrules', path: relPath, detail: rule.description.substring(0, 100) }],
						codeEntities: [],
						attributes: {},
						frequency: 2,
					});
				}
			} catch {
				// 文件不存在
			}
		}

		return concepts;
	}

	// ========================================================================
	// 扫描器：配置文件
	// ========================================================================

	private async scanConfigFiles(root: URI): Promise<OntologyConcept[]> {
		const concepts: OntologyConcept[] = [];
		const configFiles: Record<string, { tech: string; type: ConceptType; desc: string }> = {
			'tsconfig.json': { tech: 'TypeScript', type: ConceptType.Technology, desc: 'TypeScript compiler configuration' },
			'.eslintrc.json': { tech: 'ESLint', type: ConceptType.Library, desc: 'JavaScript/TypeScript linter' },
			'.eslintrc.js': { tech: 'ESLint', type: ConceptType.Library, desc: 'JavaScript/TypeScript linter' },
			'.prettierrc': { tech: 'Prettier', type: ConceptType.Library, desc: 'Code formatter' },
			'jest.config.js': { tech: 'Jest', type: ConceptType.Library, desc: 'JavaScript testing framework' },
			'jest.config.ts': { tech: 'Jest', type: ConceptType.Library, desc: 'JavaScript testing framework' },
			'vitest.config.ts': { tech: 'Vitest', type: ConceptType.Library, desc: 'Vite-native testing framework' },
			'webpack.config.js': { tech: 'Webpack', type: ConceptType.Library, desc: 'Module bundler' },
			'vite.config.ts': { tech: 'Vite', type: ConceptType.Library, desc: 'Next-generation build tool' },
			'docker-compose.yml': { tech: 'Docker Compose', type: ConceptType.Technology, desc: 'Container orchestration' },
			'Dockerfile': { tech: 'Docker', type: ConceptType.Technology, desc: 'Container runtime' },
			'.github/workflows': { tech: 'GitHub Actions', type: ConceptType.Workflow, desc: 'CI/CD pipeline' },
			'Cargo.toml': { tech: 'Rust/Cargo', type: ConceptType.Technology, desc: 'Rust package manager' },
			'go.mod': { tech: 'Go Modules', type: ConceptType.Technology, desc: 'Go dependency management' },
			'requirements.txt': { tech: 'Python pip', type: ConceptType.Technology, desc: 'Python package manager' },
			'pyproject.toml': { tech: 'Python Poetry/PEP', type: ConceptType.Technology, desc: 'Python project config' },
		};

		for (const [file, info] of Object.entries(configFiles)) {
			try {
				const uri = URI.joinPath(root, file);
				await this.fileService.readFile(uri);

				concepts.push({
					id: `tech_${this.slugify(info.tech)}`,
					name: info.tech,
					type: info.type,
					description: info.desc,
					sources: [{ type: 'config', path: file, detail: `Detected via ${file}` }],
					codeEntities: [],
					attributes: { configFile: file },
					frequency: 1,
				});
			} catch {
				// 配置文件不存在
			}
		}

		return concepts;
	}

	// ========================================================================
	// 扫描器：文档
	// ========================================================================

	private async scanDocumentation(root: URI): Promise<OntologyConcept[]> {
		const concepts: OntologyConcept[] = [];
		const docPaths = ['README.md', 'docs', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'docs/cursor'];

		for (const relPath of docPaths) {
			try {
				const uri = URI.joinPath(root, relPath);
				const stat = await this.fileService.resolve(uri);

				if (stat.isDirectory && stat.children) {
					for (const child of stat.children) {
						if (child.name.endsWith('.md')) {
							const content = (await this.fileService.readFile(child.resource)).value.toString();
							const docConcepts = this.extractConceptsFromDoc(content, child.resource.fsPath);
							concepts.push(...docConcepts);
						}
					}
				} else if (!stat.isDirectory) {
					const content = (await this.fileService.readFile(uri)).value.toString();
					const docConcepts = this.extractConceptsFromDoc(content, uri.fsPath);
					concepts.push(...docConcepts);
				}
			} catch {
				// 路径不存在
			}
		}

		return concepts;
	}

	// ========================================================================
	// 扫描器：代码注解
	// ========================================================================

	private async scanCodeAnnotations(root: URI): Promise<OntologyConcept[]> {
		const concepts: OntologyConcept[] = [];

		try {
			await this.scanDirForAnnotations(root, concepts, 0);
		} catch {
			// 扫描失败
		}

		return concepts;
	}

	private async scanDirForAnnotations(dir: URI, concepts: OntologyConcept[], depth: number): Promise<void> {
		if (depth > 4) {
			return;
		}

		try {
			const stat = await this.fileService.resolve(dir);
			if (!stat.children) {
				return;
			}

			for (const child of stat.children) {
				if (child.isDirectory) {
					const skip = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'target', 'vendor'];
					if (skip.includes(child.name)) {
						continue;
					}
					await this.scanDirForAnnotations(child.resource, concepts, depth + 1);
				} else {
					const ext = child.name.split('.').pop()?.toLowerCase();
					if (['ts', 'js', 'py', 'rs', 'go', 'java'].includes(ext || '')) {
						try {
							const content = (await this.fileService.readFile(child.resource)).value.toString();
							this.extractAnnotationConcepts(content, child.resource.fsPath, concepts);
						} catch {
							// 跳过不可读文件
						}
					}
				}
			}
		} catch {
			// 目录不可访问
		}
	}

	private extractAnnotationConcepts(content: string, filePath: string, concepts: OntologyConcept[]): void {
		// @pattern, @architecture, @convention 注解
		const annotationRegex = /@(pattern|architecture|convention|tech|decision)\s*[:\s]+(.+)/gi;
		let match;

		while ((match = annotationRegex.exec(content)) !== null) {
			const type = match[1].toLowerCase();
			const value = match[2].trim();

			const conceptType = type === 'pattern' ? ConceptType.Pattern
				: type === 'architecture' || type === 'decision' ? ConceptType.ArchitecturalDecision
				: type === 'convention' ? ConceptType.Convention
				: ConceptType.Technology;

			concepts.push({
				id: `annotation_${this.slugify(value)}`,
				name: value,
				type: conceptType,
				description: `Annotated in source code: ${value}`,
				sources: [{ type: 'code', path: filePath, detail: match[0] }],
				codeEntities: [filePath],
				attributes: {},
				frequency: 1,
			});
		}

		// TODO/FIXME/HACK 也作为概念
		const todoRegex = /(?:TODO|FIXME|HACK|NOTE)[\s:]+(.+)/gi;
		while ((match = todoRegex.exec(content)) !== null) {
			const desc = match[1].trim().substring(0, 100);
			concepts.push({
				id: `note_${this.slugify(desc).substring(0, 30)}`,
				name: `Note: ${desc.substring(0, 50)}`,
				type: ConceptType.Convention,
				description: desc,
				sources: [{ type: 'code', path: filePath, detail: match[0].substring(0, 100) }],
				codeEntities: [filePath],
				attributes: { category: 'technical_debt' },
				frequency: 1,
			});
		}
	}

	// ========================================================================
	// 扫描器：Git 历史
	// ========================================================================

	private async scanGitHistory(_root: URI): Promise<OntologyConcept[]> {
		const concepts: OntologyConcept[] = [];

		// 从 Git commit messages 中提取工程模式
		// 在浏览器环境中通过 AgentToolService 的 run_command 执行
		// 这里使用 commit message 约定来推断概念

		// Git commit message patterns for future use when Git CLI integration is available
		const _commitPatterns: Array<{ pattern: RegExp; type: ConceptType; namePrefix: string }> = [
			{ pattern: /^feat(?:\(.+\))?:\s*(.+)/i, type: ConceptType.DomainEntity, namePrefix: 'Feature' },
			{ pattern: /^fix(?:\(.+\))?:\s*(.+)/i, type: ConceptType.Convention, namePrefix: 'Bug Pattern' },
			{ pattern: /^refactor(?:\(.+\))?:\s*(.+)/i, type: ConceptType.ArchitecturalDecision, namePrefix: 'Refactoring' },
			{ pattern: /^chore(?:\(.+\))?:\s*(.+)/i, type: ConceptType.Workflow, namePrefix: 'Maintenance' },
		];
		void _commitPatterns;

		// 由于 Git CLI 在浏览器端不可直接调用，我们标记该来源为"需要 AgentTool 执行"
		// 实际使用时会通过 AgentToolService.executeTool('run_command', { command: 'git log ...' }) 获取
		concepts.push({
			id: 'convention_conventional_commits',
			name: 'Conventional Commits',
			type: ConceptType.Convention,
			description: 'Project uses conventional commit message format (feat/fix/refactor/chore)',
			sources: [{ type: 'git_history', detail: 'Inferred from commit message patterns' }],
			codeEntities: [],
			attributes: {
				format: 'type(scope): description',
				types: 'feat, fix, refactor, chore, docs, test, ci',
			},
			frequency: 1,
		});

		return concepts;
	}

	// ========================================================================
	// 关系推断
	// ========================================================================

	private inferRelations(concepts: Map<string, OntologyConcept>, relations: OntologyRelation[]): void {
		const conceptList = [...concepts.values()];

		for (const concept of conceptList) {
			// 库 → 技术栈关系
			if (concept.type === ConceptType.Library) {
				const info = this.identifyLibrary(concept.name);
				if (info.ecosystem) {
					const ecosystemId = `tech_${this.slugify(info.ecosystem)}`;
					if (concepts.has(ecosystemId)) {
						relations.push({
							fromId: concept.id,
							toId: ecosystemId,
							type: RelationType.PartOf,
							weight: 0.8,
						});
					}
				}
			}

			// 共享来源的概念可能相关
			for (const other of conceptList) {
				if (concept.id === other.id) {
					continue;
				}

				const sharedFiles = concept.codeEntities.filter(
					f => other.codeEntities.includes(f)
				);

				if (sharedFiles.length > 0) {
					relations.push({
						fromId: concept.id,
						toId: other.id,
						type: RelationType.Uses,
						weight: Math.min(1, sharedFiles.length * 0.2),
					});
				}
			}
		}
	}

	// ========================================================================
	// 工具方法
	// ========================================================================

	private identifyLibrary(name: string): {
		type: ConceptType;
		description: string;
		category: string;
		ecosystem?: string;
	} {
		const knownLibs: Record<string, { desc: string; cat: string; eco?: string }> = {
			'react': { desc: 'UI component library', cat: 'frontend', eco: 'React' },
			'vue': { desc: 'Progressive JavaScript framework', cat: 'frontend', eco: 'Vue' },
			'express': { desc: 'Web framework for Node.js', cat: 'backend', eco: 'Node.js' },
			'typescript': { desc: 'Typed superset of JavaScript', cat: 'language', eco: 'TypeScript' },
			'jest': { desc: 'JavaScript testing framework', cat: 'testing' },
			'mocha': { desc: 'Test framework', cat: 'testing' },
			'eslint': { desc: 'JavaScript linter', cat: 'quality' },
			'prettier': { desc: 'Code formatter', cat: 'quality' },
			'webpack': { desc: 'Module bundler', cat: 'build' },
			'vite': { desc: 'Build tool', cat: 'build' },
			'prisma': { desc: 'ORM for Node.js', cat: 'database' },
			'mongoose': { desc: 'MongoDB ODM', cat: 'database' },
			'redis': { desc: 'In-memory data store client', cat: 'database' },
			'axios': { desc: 'HTTP client', cat: 'networking' },
			'lodash': { desc: 'Utility library', cat: 'utility' },
			'@types/node': { desc: 'Node.js type definitions', cat: 'types', eco: 'TypeScript' },
			'tailwindcss': { desc: 'Utility-first CSS framework', cat: 'styling' },
			'next': { desc: 'React framework', cat: 'frontend', eco: 'React' },
			'nuxt': { desc: 'Vue framework', cat: 'frontend', eco: 'Vue' },
		};

		const info = knownLibs[name];
		if (info) {
			return {
				type: ConceptType.Library,
				description: info.desc,
				category: info.cat,
				ecosystem: info.eco,
			};
		}

		// 根据名称前缀推断
		if (name.startsWith('@types/')) {
			return { type: ConceptType.Library, description: 'TypeScript type definitions', category: 'types', ecosystem: 'TypeScript' };
		}
		if (name.startsWith('eslint-')) {
			return { type: ConceptType.Library, description: 'ESLint plugin', category: 'quality' };
		}

		return { type: ConceptType.Library, description: `NPM package: ${name}`, category: 'unknown' };
	}

	private extractRulesFromContent(content: string): Array<{ name: string; description: string }> {
		const rules: Array<{ name: string; description: string }> = [];

		// 按 Markdown 标题分割
		const sections = content.split(/^#+\s+/m);
		for (const section of sections) {
			const lines = section.trim().split('\n');
			if (lines.length === 0) {
				continue;
			}

			const name = lines[0].trim();
			if (name.length > 0 && name.length < 100) {
				const description = lines.slice(1).join('\n').trim().substring(0, 300);
				rules.push({ name, description });
			}
		}

		// 按列表项提取
		const listItems = content.match(/^[-*]\s+(.+)/gm);
		if (listItems) {
			for (const item of listItems) {
				const text = item.replace(/^[-*]\s+/, '').trim();
				if (text.length > 10 && text.length < 200) {
					rules.push({ name: text.substring(0, 60), description: text });
				}
			}
		}

		return rules;
	}

	private extractConceptsFromDoc(content: string, filePath: string): OntologyConcept[] {
		const concepts: OntologyConcept[] = [];

		// 提取 Markdown 标题作为概念
		const headings = content.match(/^#{1,3}\s+(.+)/gm);
		if (headings) {
			for (const heading of headings) {
				const name = heading.replace(/^#+\s+/, '').trim();
				if (name.length < 5 || name.length > 80) {
					continue;
				}

				concepts.push({
					id: `doc_${this.slugify(name)}`,
					name,
					type: ConceptType.DomainEntity,
					description: `Documented concept: ${name}`,
					sources: [{ type: 'documentation', path: filePath, detail: heading }],
					codeEntities: [],
					attributes: {},
					frequency: 1,
				});
			}
		}

		return concepts;
	}

	private slugify(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
			.replace(/^_|_$/g, '')
			.substring(0, 50);
	}
}

registerSingleton(IDomainOntologyService, DomainOntologyService, InstantiationType.Delayed);
