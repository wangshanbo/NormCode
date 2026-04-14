/*---------------------------------------------------------------------------------------------
 *  Sentinel — 通过 Tasks（终端任务系统）无头执行 package.json 脚本（lint / test）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { ITaskService } from '../../contrib/tasks/common/taskService.js';
import { TaskRunSource } from '../../contrib/tasks/common/tasks.js';
import type { Task } from '../../contrib/tasks/common/tasks.js';

export const ISentinelNpmScriptRunnerService = createDecorator<ISentinelNpmScriptRunnerService>('ISentinelNpmScriptRunnerService');

export interface NpmScriptRunOutcome {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly errorMessage?: string;
}

export interface ISentinelNpmScriptRunnerService {
	readonly _serviceBrand: undefined;
	/** 解析 package.json 中首选的 lint / test 脚本名并尝试通过 npm Task 执行 */
	runLintAndTestScripts(folder: IWorkspaceFolder, options?: { lintTimeoutMs?: number; testTimeoutMs?: number }): Promise<{
		lint: NpmScriptRunOutcome & { scriptName?: string; skipped: boolean };
		test: NpmScriptRunOutcome & { scriptName?: string; skipped: boolean };
	}>;
	/** 若存在 scripts.build，通过 npm Task 执行（用于实现节点编译门禁） */
	runBuildScript(folder: IWorkspaceFolder, options?: { timeoutMs?: number }): Promise<NpmScriptRunOutcome & { scriptName?: string; skipped: boolean }>;
}

const DEFAULT_LINT_MS = 15 * 60 * 1000;
const DEFAULT_TEST_MS = 30 * 60 * 1000;
const DEFAULT_BUILD_MS = 20 * 60 * 1000;

export class SentinelNpmScriptRunnerService extends Disposable implements ISentinelNpmScriptRunnerService {
	readonly _serviceBrand: undefined;

	/**
	 * 构造期禁止直接注入 ITaskService：会卷入 task → IChat → IAICore → ISentinelProduct → ISentinelKernel
	 * → export → verification → 本服务，形成环，导致 Sentinel 面板等根本无法实例化。
	 * 仅在执行 npm 脚本时再解析 ITaskService，此时内核等单例已就绪。
	 */
	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private getTaskService(): ITaskService {
		return this.instantiationService.invokeFunction(accessor => accessor.get(ITaskService));
	}

	async runLintAndTestScripts(folder: IWorkspaceFolder, options?: { lintTimeoutMs?: number; testTimeoutMs?: number }): Promise<{
		lint: NpmScriptRunOutcome & { scriptName?: string; skipped: boolean };
		test: NpmScriptRunOutcome & { scriptName?: string; skipped: boolean };
	}> {
		const { lintName, testName } = await this.resolveScriptNames(folder.uri);
		const lintTimeout = options?.lintTimeoutMs ?? DEFAULT_LINT_MS;
		const testTimeout = options?.testTimeoutMs ?? DEFAULT_TEST_MS;

		const lint = lintName
			? { ...await this.runOne(folder, lintName, lintTimeout), scriptName: lintName, skipped: false }
			: { exitCode: undefined, timedOut: false, skipped: true, scriptName: undefined, errorMessage: 'no lint-like script in package.json' };

		const test = testName
			? { ...await this.runOne(folder, testName, testTimeout), scriptName: testName, skipped: false }
			: { exitCode: undefined, timedOut: false, skipped: true, scriptName: undefined, errorMessage: 'no test-like script in package.json' };

		return { lint, test };
	}

	async runBuildScript(folder: IWorkspaceFolder, options?: { timeoutMs?: number }): Promise<NpmScriptRunOutcome & { scriptName?: string; skipped: boolean }> {
		const buildName = await this.resolveBuildScriptName(folder.uri);
		const timeout = options?.timeoutMs ?? DEFAULT_BUILD_MS;
		if (!buildName) {
			return {
				exitCode: undefined,
				timedOut: false,
				skipped: true,
				scriptName: undefined,
				errorMessage: 'package.json 中无 scripts.build，跳过构建门禁',
			};
		}
		return { ...await this.runOne(folder, buildName, timeout), scriptName: buildName, skipped: false };
	}

	private async resolveBuildScriptName(root: URI): Promise<string | undefined> {
		try {
			const uri = URI.joinPath(root, 'package.json');
			const data = JSON.parse((await this.fileService.readFile(uri)).value.toString()) as { scripts?: Record<string, string> };
			return data.scripts?.build ? 'build' : undefined;
		} catch {
			return undefined;
		}
	}

	private async resolveScriptNames(root: URI): Promise<{ lintName?: string; testName?: string }> {
		try {
			const uri = URI.joinPath(root, 'package.json');
			const data = JSON.parse((await this.fileService.readFile(uri)).value.toString()) as { scripts?: Record<string, string> };
			const scripts = data.scripts || {};
			const keys = Object.keys(scripts);
			const lintName = scripts['lint'] ? 'lint' : keys.find(k => /lint/i.test(k));
			const testName = scripts['test'] ? 'test' : keys.find(k => /\btest\b/i.test(k));
			return { lintName, testName };
		} catch {
			return {};
		}
	}

	private async runOne(folder: IWorkspaceFolder, scriptName: string, timeoutMs: number): Promise<NpmScriptRunOutcome> {
		try {
			const task = await this.getTaskService().getTask(folder, { type: 'npm', script: scriptName }, false, 'npm');
			if (!task) {
				return { exitCode: undefined, timedOut: false, errorMessage: `未找到 npm 任务: ${scriptName}（需启用 npm 自动检测或已配置 tasks）` };
			}
			return await this.runTaskWithTimeout(task, timeoutMs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.logService.warn(`[Sentinel NPM] ${scriptName}: ${msg}`);
			return { exitCode: undefined, timedOut: false, errorMessage: msg };
		}
	}

	private async runTaskWithTimeout(task: Task, timeoutMs: number): Promise<NpmScriptRunOutcome> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('__SENTINEL_TASK_TIMEOUT__')), timeoutMs);
		});
		try {
			const summary = await Promise.race([
				this.getTaskService().run(task, undefined, TaskRunSource.System),
				timeoutPromise,
			]);
			if (timer) {
				clearTimeout(timer);
			}
			return { exitCode: summary?.exitCode, timedOut: false };
		} catch (e) {
			if (timer) {
				clearTimeout(timer);
			}
			if (e instanceof Error && e.message === '__SENTINEL_TASK_TIMEOUT__') {
				try {
					await this.getTaskService().terminate(task);
				} catch {
					// ignore
				}
				return { exitCode: 124, timedOut: true, errorMessage: `任务超时（>${timeoutMs}ms）` };
			}
			const msg = e instanceof Error ? e.message : String(e);
			return { exitCode: undefined, timedOut: false, errorMessage: msg };
		}
	}
}

registerSingleton(ISentinelNpmScriptRunnerService, SentinelNpmScriptRunnerService, InstantiationType.Delayed);
