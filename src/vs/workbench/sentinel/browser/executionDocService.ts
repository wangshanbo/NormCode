/*---------------------------------------------------------------------------------------------
 *  Sentinel Execution Doc — 长程任务执行文档（里程碑 + 自动流水）
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';

export const IExecutionDocService = createDecorator<IExecutionDocService>('IExecutionDocService');

export interface ExecutionDocEntry {
	intentId: string;
	intentTitle: string;
	nodeId: string;
	nodeTitle: string;
	nodeType: string;
	/** Worker 原始状态 */
	runStatus: string;
	/** 编排层最终语义 */
	outcome: 'completed' | 'blocked' | 'failed';
	note?: string;
}

export interface IExecutionDocService {
	readonly _serviceBrand: undefined;
	recordNodeCompletion(entry: ExecutionDocEntry): Promise<void>;
}

const RUNBOOK_RELATIVE = ['.sentinel', 'EXECUTION_RUNBOOK.md'];

/** 首次写入工作区时的骨架（里程碑需人工勾选；流水区由本服务追加） */
const RUNBOOK_TEMPLATE = `# Sentinel 长程任务执行文档

本文件位于工作区 **\`.sentinel/EXECUTION_RUNBOOK.md\`**，用于：

1. **里程碑清单**：防止改造/需求遗漏，请随进度将 \`[ ]\` 改为 \`[x]\`。
2. **执行流水**：每个 Sentinel 节点结束时**自动追加一行**，无需手改流水区。

---

## 里程碑清单（手动勾选）

### M1：最小全自动闭环
- [ ] P0-1 短需求 → Intent 模板与结构化 IntentCard
- [ ] P0-2 运行模式：无人值守 / 双闸门（harness.json）
- [ ] P0-3 编排顺序固化（解析 → ADR → DAG → Shadow → 验证 → Promote）
- [ ] P4-1 Promote：Shadow → 工作区合并

### M2：上下文与对抗
- [ ] P1-1 每节点独立 LLM 会话（不携带完整对话史）
- [ ] P1-2 收紧 CSO 与输出链摘要化
- [ ] P1-3 子任务结束强制落盘（task_state / progress）
- [ ] P2-1 实现与审查上下文隔离
- [ ] P2-2 评估器以 LSP/测试为最高优先级

### M3：工具与权限
- [ ] P3-1 工具注册表与配额
- [ ] P3-2 MCP 按需挂载
- [ ] P3-3 目录 ACL 与协议层约束

### M4：工程确定性
- [ ] P4-2 原子提交（git commit 范围限定）
- [ ] P4-3 失败回滚（git / checkpoint）
- [ ] P4-4 Implementation Plan 硬闸门

### M5：验证与零报错
- [ ] P5-1 分级门禁（lint / test / E2E）
- [ ] P5-2 strict 与 Zero-Warning 策略对齐
- [ ] P5-3 修复回路短上下文
- [ ] P5-4 行为快照（可选）

### M6：可观测性
- [ ] P6-1 控制平面展示阶段与阻塞原因
- [ ] P6-2 导出 trace + 验证包复盘

---

## 执行流水（自动生成）

_（尚无记录；运行 Sentinel 节点后将在此追加）_

`;

const LOG_SECTION = '\n## 执行流水（自动生成）\n\n';

export class ExecutionDocService extends Disposable implements IExecutionDocService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async recordNodeCompletion(entry: ExecutionDocEntry): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const uri = URI.joinPath(root, ...RUNBOOK_RELATIVE);
		const sentinelDir = URI.joinPath(root, '.sentinel');

		let text: string;
		try {
			const buf = await this.fileService.readFile(uri);
			text = buf.value.toString();
		} catch {
			try {
				await this.fileService.createFolder(sentinelDir);
			} catch {
				// ignore
			}
			text = RUNBOOK_TEMPLATE;
			await this.fileService.writeFile(uri, VSBuffer.fromString(text));
		}

		if (text.includes('_（尚无记录；运行 Sentinel 节点后将在此追加）_')) {
			text = text.replace('_（尚无记录；运行 Sentinel 节点后将在此追加）_\n', '');
		}

		if (!text.includes('## 执行流水（自动生成）')) {
			text = text.trimEnd() + LOG_SECTION;
		}

		const iso = new Date().toISOString();
		const icon = entry.outcome === 'completed' ? '✅' : (entry.outcome === 'blocked' ? '⛔' : '⚠️');
		const line = `- ${icon} \`${iso}\` | **${this.escapeMd(entry.intentTitle)}** (\`${entry.intentId.slice(0, 8)}…\`) | 节点 **${this.escapeMd(entry.nodeTitle)}** (\`${entry.nodeId}\`) | 类型 \`${entry.nodeType}\` | 结果 **${entry.outcome}** | worker=\`${entry.runStatus}\`${entry.note ? ` | ${this.escapeMd(entry.note.slice(0, 160))}` : ''}`;

		const newText = text.trimEnd() + '\n' + line + '\n';
		try {
			await this.fileService.writeFile(uri, VSBuffer.fromString(newText));
			this.logService.trace(`[Sentinel ExecutionDoc] Appended: ${entry.nodeId} ${entry.outcome}`);
		} catch (e) {
			this.logService.warn('[Sentinel ExecutionDoc] Failed to append runbook', e);
		}
	}

	private escapeMd(s: string): string {
		return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	}
}

registerSingleton(IExecutionDocService, ExecutionDocService, InstantiationType.Delayed);
