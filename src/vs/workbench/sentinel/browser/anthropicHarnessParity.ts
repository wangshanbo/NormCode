/*---------------------------------------------------------------------------------------------
 *  Anthropic Harness Engineering — 与工作区工件、Worker 提示对齐
 *  参考: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
 *        https://www.anthropic.com/engineering/harness-design-long-running-apps
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import type { IFileService } from '../../../platform/files/common/files.js';
import type { IGLMChatService } from '../../services/aiCore/browser/glmChatService.js';
import type { ResolvedHarnessConfig } from './harnessConfigService.js'; // type-only：避免运行时环依赖
import { WorkerRole } from '../common/workerTypes.js';

export function shouldApplyAnthropicParity(cfg: ResolvedHarnessConfig): boolean {
	return cfg.enabled && cfg.anthropicHarnessParity;
}

/**
 * 规划前确保存在 feature 注册表与进度日志（Initializer 脚手架的子集）。
 */
export async function ensureAnthropicHarnessArtifacts(
	fileService: IFileService,
	workspaceRoot: URI,
	goal: string,
	cfg: ResolvedHarnessConfig,
	log?: { info: (s: string) => void },
): Promise<void> {
	if (!shouldApplyAnthropicParity(cfg)) {
		return;
	}
	const regPath = cfg.featureRegistryPath.replace(/\\/g, '/').replace(/^\//, '');
	const progPath = cfg.progressLogPath.replace(/\\/g, '/').replace(/^\//, '');
	const sentinelDir = URI.joinPath(workspaceRoot, '.sentinel');

	try {
		await fileService.createFolder(sentinelDir);
	} catch {
		// 可能已存在
	}

	const regUri = URI.joinPath(workspaceRoot, regPath);
	const progUri = URI.joinPath(workspaceRoot, progPath);

	try {
		await fileService.stat(regUri);
	} catch {
		const safeGoal = goal.slice(0, 4000);
		const registry = {
			schema: 'sentinel.anthropic_feature_registry.v1',
			reference: 'https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents',
			updatedAt: Date.now(),
			goalSummary: safeGoal,
			features: [
				{
					id: 'feat_e2e_smoke',
					category: 'functional',
					description: '应用可通过本地 HTTP 启动，入口页无控制台致命错误，核心交互路径可用',
					acceptanceSteps: [
						'使用 http-server / npm start 等启动后打开入口 URL',
						'完成一条主用户路径（如列表→选择→提交）',
					],
					passes: false,
				},
				{
					id: 'feat_user_goal',
					category: 'functional',
					description: safeGoal.slice(0, 800),
					acceptanceSteps: ['对照用户原始目标逐项可演示'],
					passes: false,
				},
			],
			policies: [
				'仅在端到端验证通过后将 feature.passes 改为 true；禁止删除或弱化验收条目以凑通过。',
				'每一实现回合优先只推进一条 passes:false 的功能（增量交付）。',
			],
		};
		await fileService.writeFile(regUri, VSBuffer.fromString(JSON.stringify(registry, null, 2)));
		log?.info(`[AnthropicHarness] Created ${regPath}`);
	}

	try {
		await fileService.stat(progUri);
	} catch {
		const lines = [
			'# Sentinel Progress Log（Anthropic-style handoff）',
			'# Ref: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents',
			'',
			`Goal: ${goal.slice(0, 800)}`,
			'',
			'## Sessions',
			`- ${new Date().toISOString()} — scaffold created by Sentinel kernel (planIntent)`,
			'',
		];
		await fileService.writeFile(progUri, VSBuffer.fromString(lines.join('\n')));
		log?.info(`[AnthropicHarness] Created ${progPath}`);
	}

	const rubRel = cfg.evaluatorRubricPath.replace(/\\/g, '/').replace(/^\//, '');
	const rubUri = URI.joinPath(workspaceRoot, rubRel);
	try {
		await fileService.stat(rubUri);
	} catch {
		const body = [
			'# Evaluator Rubric（HGT-026）',
			'',
			'Verifier 在工具环中应显式按维度给出证据，而非仅主观「看起来不错」。',
			'',
			'| 维度 | 1 | 5 |',
			'|------|---|---|',
			'| 与 feature_registry 验收对齐 | 明显不符 | 逐条可演示 |',
			'| 可运行 / 构建 | 无法启动 | 本地可构建可访问 |',
			'| 视觉与信息架构 | 混乱或模板堆砌 | 清晰一致 |',
			'',
		].join('\n');
		await fileService.writeFile(rubUri, VSBuffer.fromString(body));
		log?.info(`[AnthropicHarness] Created ${rubRel}`);
	}
}

export function getAnthropicHarnessPromptAugmentation(role: WorkerRole, cfg: ResolvedHarnessConfig): string {
	if (!shouldApplyAnthropicParity(cfg)) {
		return '';
	}
	const reg = cfg.featureRegistryPath;
	const prog = cfg.progressLogPath;
	const init = cfg.initScriptHintPath;

	const baseRefs = [
		'',
		'---',
		'【Anthropic Harness 对齐附言】以下为产品层约束，须与上文角色职责一并遵守：',
		`- 结构化产物路径：功能注册表 ${reg}；进度日志 ${prog}；建议提供可重复启动脚本（如 ${init}）。`,
		'- 参考 Anthropic 长程范式：避免一次性「大而全」导致上下文截断；优先增量、可合并主干状态的交付。',
	].join('\n');

	switch (role) {
		case WorkerRole.Analyst:
			return [
				baseRefs,
				'- 你扮演 **Initializer** 子集：在「功能拆解」中产出可写入 JSON 的细粒度 feature 列表思路（category、description、acceptanceSteps、passes:false）。',
				`- 明确 Web 应用时：须写清 E2E 验证方式（本地服务 + 浏览器路径），与 ${reg} 中 policy 一致。`,
				'- **第一步必须输出「用户能力层级锚点」**：按主系统提示中的 CAP_PRIMARY / CAP_CODE / CAP_LEVELING / CAP_SIGNAL 格式书写；目标是 **抹平差异**——普通人与资深 PM/架构师应获得 **同等深度** 的下游规格，仅表述风格可随 CAP 微调。',
				'- **补全用户未说清的产品与设计**：默认用户可能缺乏审美与产品思维；须主动写出信息架构、关键用户路径、空/加载/错误态、无障碍（焦点、对比度、语义标签）、响应式断点；配图须给出 **可验证** 方案（自托管资源、稳定图床 API、或内联 SVG），并写明如何避免第三方 URL 大面积 404。',
				'- 可简要引用当前主流 Web/App 视觉趋势（留白、字体层级、微交互）作为「建议风格方向」，不必品牌抄袭；后续 Planner/实现应对齐。',
			].join('\n');
		case WorkerRole.Planner:
			return [
				baseRefs,
				'- 规划须可映射到 **单条 feature 的竖切**；步骤描述中点名要触碰的文件与验收方式。',
				`- 勿把「审查/测试」写成人工步骤（系统另有节点），但须为每步留下可验证结果，便于后续更新 ${reg} 的 passes。`,
				'- **设计与资源步**：单独拆出「样式与设计系统 / 配图与外链清单 / 交互状态」等步；每一步须可验收（例如：所有外链经探测可访问，或改为本地/内联资源）。',
				'- **能力锚点**：若 Intent 中含「用户能力锚点」块，仅作背景；**禁止**因判定为外行而减少 STEP 深度，须按资深 PM+架构师评审可接受粒度输出。',
			].join('\n');
		case WorkerRole.Implementer:
			return [
				baseRefs,
				`- 开工前假定已阅读 ${prog} 与 ${reg}；本回合优先完成 **一条** passes:false 的功能的端到端闭环。`,
				'- 输出 ### FILE 时保证可运行；多文件 ESM 必须 export/import 一致。',
				'- **NormCode 多文件闭包**：路由懒加载路径、对话框/子组件 import、Pinia **单文件单 store id**、`package.json` 与源码 import 同步，须与主系统 Implementer 规则一致，禁止幽灵文件与双 store。',
				`- 若无法在沙箱内自测，勿在叙述中宣称「全部完成」；由 Verifier/后续会话更新 passes。`,
				'- **禁止糊弄式外链**：优先稳定可访问的图片来源或项目内 `assets/`；若必须用远程 URL，选用文档完备、长期可用的 CDN/图床，并在注释中说明替换策略。',
			].join('\n');
		case WorkerRole.Reviewer:
		case WorkerRole.Verifier:
			return [
				baseRefs,
				`- 若有 ${cfg.evaluatorRubricPath}，评审时应对照其中维度给出 **可引用证据**（日志/截图/MCP 结果），避免纯主观打分。`,
				'- 你扮演 **Evaluator** 子集：对生成物持怀疑态度；默认生成器会高估完成度（Anthropic 论文结论）。',
				'- 从「可演示 E2E、设计整体性、是否模板/AI 俗套、基础可用性」挑刺；BLOCK/WARN 须有可执行依据。',
				`- 若开启 behavioralE2E / 浏览器 MCP，应优先引用真实交互结果而非仅静态代码阅读。`,
				'- **外链与多媒体**：须质疑所有第三方图片/脚本 URL；要求在验证阶段用工具实测可达性，不得默认「链接有效」。',
			].join('\n');
		default:
			return baseRefs;
	}
}

/**
 * 需求分析完成后，将 Analyst 输出拆解为更多 feature 条目并合并进注册表（按 id 去重）。
 */
export async function expandFeatureRegistryFromAnalystOutput(
	fileService: IFileService,
	glmChatService: IGLMChatService,
	workspaceRoot: URI,
	modelId: string,
	cfg: ResolvedHarnessConfig,
	analystMarkdown: string,
	log?: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
	if (!shouldApplyAnthropicParity(cfg) || !analystMarkdown.trim()) {
		return;
	}
	const regPath = cfg.featureRegistryPath.replace(/\\/g, '/').replace(/^\//, '');
	const regUri = URI.joinPath(workspaceRoot, regPath);
	let existing: { features?: unknown[]; updatedAt?: number; [key: string]: unknown };
	try {
		existing = JSON.parse((await fileService.readFile(regUri)).value.toString()) as typeof existing;
	} catch {
		log?.warn('[AnthropicHarness] feature expand skipped: registry missing');
		return;
	}
	const system = [
		'You expand a software feature registry from an analyst report.',
		'Reply with ONLY one JSON object (no markdown fences) of shape:',
		'{"additionalFeatures":[{"id":"feat_snake_case","category":"functional|quality|ux|ops","description":"string","acceptanceSteps":["string"],"passes":false}]}',
		'Rules: at most 15 items; every id unique prefix feat_; passes must be false; acceptanceSteps 1–6 strings each.',
	].join(' ');
	const user = `Analyst output:\n\n${analystMarkdown.slice(0, 14000)}`;
	let completion;
	try {
		completion = await glmChatService.completeChatTurn(
			[
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			{ files: [] },
			{
				model: modelId,
				temperature: 0.25,
				maxTokens: 8192,
				enableThinking: false,
				enableWebSearch: false,
			},
			CancellationToken.None,
		);
	} catch (e) {
		log?.warn(`[AnthropicHarness] feature expand LLM failed: ${String(e)}`);
		return;
	}
	const text = (completion.content || '').trim();
	const jsonStart = text.indexOf('{');
	const jsonEnd = text.lastIndexOf('}');
	if (jsonStart < 0 || jsonEnd <= jsonStart) {
		log?.warn('[AnthropicHarness] feature expand: no JSON in model output');
		return;
	}
	let parsed: { additionalFeatures?: Array<{ id?: string; category?: string; description?: string; acceptanceSteps?: unknown; passes?: boolean }> };
	try {
		parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as typeof parsed;
	} catch {
		log?.warn('[AnthropicHarness] feature expand: JSON parse failed');
		return;
	}
	const add = parsed.additionalFeatures;
	if (!Array.isArray(add) || add.length === 0) {
		return;
	}
	const feats: Record<string, unknown>[] = Array.isArray(existing.features) ? [...existing.features] as Array<Record<string, unknown>> : [];
	const ids = new Set(feats.map(f => String((f as { id?: string }).id || '')));
	let merged = 0;
	for (const f of add) {
		if (!f?.id || typeof f.id !== 'string' || ids.has(f.id)) {
			continue;
		}
		ids.add(f.id);
		const steps = Array.isArray(f.acceptanceSteps) ? f.acceptanceSteps.map(x => String(x)).filter(s => s.length > 0).slice(0, 20) : [];
		feats.push({
			id: f.id,
			category: typeof f.category === 'string' ? f.category.slice(0, 64) : 'functional',
			description: String(f.description || '').slice(0, 2000),
			acceptanceSteps: steps,
			passes: false,
		});
		merged++;
	}
	if (merged === 0) {
		return;
	}
	existing.features = feats;
	existing.updatedAt = Date.now();
	await fileService.writeFile(regUri, VSBuffer.fromString(JSON.stringify(existing, null, 2)));
	log?.info(`[AnthropicHarness] feature_registry expanded (+${merged} features)`);
}

/**
 * HGT-013：verify 节点且验证门通过时，回写 feature_registry.json 中相关 `passes`（至少 `feat_user_goal`）。
 */
export async function updateFeatureRegistryPassesAfterVerify(
	fileService: IFileService,
	workspaceRoot: URI,
	cfg: ResolvedHarnessConfig,
	node: { type: string },
	bundle: { overallStatus: string; matchedSuccessCriteria?: string[] },
	log?: { info?: (m: string) => void; warn?: (m: string) => void },
): Promise<void> {
	if (!shouldApplyAnthropicParity(cfg) || node.type !== 'verify' || bundle.overallStatus !== 'passed') {
		return;
	}
	const regPath = cfg.featureRegistryPath.replace(/\\/g, '/').replace(/^\//, '');
	const regUri = URI.joinPath(workspaceRoot, regPath);
	let doc: { features?: Array<{ id?: string; passes?: boolean; [key: string]: unknown }>; updatedAt?: number; [key: string]: unknown };
	try {
		doc = JSON.parse((await fileService.readFile(regUri)).value.toString()) as typeof doc;
	} catch (e) {
		log?.warn?.(`[AnthropicHarness] feature_registry passes update skipped: ${String(e)}`);
		return;
	}
	const feats = doc.features;
	if (!Array.isArray(feats)) {
		return;
	}
	const matched = bundle.matchedSuccessCriteria ?? [];
	let changed = false;
	for (const f of feats) {
		const id = typeof f.id === 'string' ? f.id : '';
		if (!id) {
			continue;
		}
		const steps = Array.isArray(f.acceptanceSteps) ? f.acceptanceSteps.filter((s): s is string => typeof s === 'string') : [];
		const stepHit = steps.some(step =>
			matched.some(c => typeof c === 'string' && (c.trim() === step.trim() || c.includes(step) || step.includes(c))),
		);
		if (id === 'feat_user_goal') {
			if (!f.passes) {
				f.passes = true;
				changed = true;
			}
			continue;
		}
		if (matched.some(c => typeof c === 'string' && c.includes(id)) || stepHit) {
			if (!f.passes) {
				f.passes = true;
				changed = true;
			}
		}
	}
	if (!changed) {
		return;
	}
	doc.updatedAt = Date.now();
	await fileService.writeFile(regUri, VSBuffer.fromString(JSON.stringify(doc, null, 2)));
	log?.info?.('[AnthropicHarness] feature_registry passes updated (verify passed)');
}

/**
 * 向进度日志追加一行（Anthropic 式 handoff）；仅 parity 开启时写入。
 */
export async function appendAnthropicProgressLog(
	fileService: IFileService,
	workspaceRoot: URI,
	cfg: ResolvedHarnessConfig,
	line: string,
	log?: { warn: (m: string) => void },
): Promise<void> {
	if (!shouldApplyAnthropicParity(cfg)) {
		return;
	}
	const rel = cfg.progressLogPath.replace(/\\/g, '/').replace(/^\//, '');
	const uri = URI.joinPath(workspaceRoot, rel);
	const stamp = new Date().toISOString();
	const entry = `- ${stamp} — ${line.replace(/\s+/g, ' ').trim()}\n`;
	try {
		let prev = '';
		try {
			prev = (await fileService.readFile(uri)).value.toString();
		} catch {
			// 文件尚未由脚手架创建时可忽略
		}
		const sep = prev.length > 0 && !prev.endsWith('\n') ? '\n' : '';
		await fileService.writeFile(uri, VSBuffer.fromString(prev + sep + entry));
	} catch (e) {
		log?.warn(`[AnthropicHarness] progress append failed: ${String(e)}`);
	}
}
