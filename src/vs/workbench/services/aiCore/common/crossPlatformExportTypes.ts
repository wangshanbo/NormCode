/*---------------------------------------------------------------------------------------------
 *  跨端导出中间层（IR）— 定稿状态、目标端、模块占位与生成记录
 *  持久化：工作区 `.sentinel/cross-platform-export.json`
 *--------------------------------------------------------------------------------------------*/

/** 与预览器、生成管线一致的四端 */
export type CrossPlatformTargetId = 'web' | 'ios' | 'android' | 'wechat_miniprogram';

export const ALL_CROSS_PLATFORM_TARGETS: readonly CrossPlatformTargetId[] = [
	'web',
	'ios',
	'android',
	'wechat_miniprogram',
];

/** 用户确认的界面模块（后续可由扫描器填充） */
export interface CrossPlatformModuleRef {
	readonly id: string;
	readonly label: string;
	/** 可选：Web 源码路径 glob 或相对路径 */
	readonly webPath?: string;
}

export type CrossPlatformRunStatus = 'pending' | 'running' | 'done' | 'error';

export interface CrossPlatformTargetRun {
	readonly status: CrossPlatformRunStatus;
	readonly at?: string;
	readonly summary?: string;
	readonly error?: string;
}

export interface CrossPlatformExportManifest {
	readonly version: 1;
	/** 用户是否在预览中确认「定稿」 */
	finalized: boolean;
	finalizedAt?: string;
	/** 打开项目预览时的 URL（便于追溯） */
	previewUrl: string;
	/** 各端是否选中生成 */
	targets: Record<CrossPlatformTargetId, boolean>;
	modules: CrossPlatformModuleRef[];
	/** 每端最近一次生成结果 */
	runs: Partial<Record<CrossPlatformTargetId, CrossPlatformTargetRun>>;
	updatedAt: string;
	/** IR 快照版本（与 `.sentinel/cross-platform-ir.json` 中 irVersion 对齐） */
	irVersion?: number;
	/** 最近一次 IR 快照时间 */
	irSnapshotAt?: string;
	/** IR 文件相对工作区路径 */
	irPath?: string;
}

/**
 * 定稿时写入的结构化 IR（`.sentinel/cross-platform-ir.json`）
 * 供各端模板填空与 LLM 分模块落盘只读消费。
 */
export interface CrossPlatformIrSnapshot {
	readonly irVersion: 1;
	readonly takenAt: string;
	readonly workspaceFolderName: string;
	readonly packageJson: Record<string, unknown> | null;
	readonly packageName: string;
	/** 相对工作区路径，上限由快照服务截断 */
	readonly sourceFiles: readonly string[];
	/** 自源码启发式提取的路由/路径片段 */
	readonly routeHints: readonly string[];
	/** API / 环境变量线索 */
	readonly apiBaseHints: readonly string[];
}

export function createEmptyCrossPlatformManifest(previewUrl: string): CrossPlatformExportManifest {
	const now = new Date().toISOString();
	return {
		version: 1,
		finalized: false,
		previewUrl,
		targets: {
			web: true,
			ios: true,
			android: true,
			wechat_miniprogram: true,
		},
		modules: [],
		runs: {},
		updatedAt: now,
		irPath: '.sentinel/cross-platform-ir.json',
	};
}
