/*---------------------------------------------------------------------------------------------
 *  HGT-011：Harness 审计日志（追加 JSONL，便于 grep / 外接 SIEM）
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IHarnessTraceService } from './harnessTraceService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const IHarnessAuditLogService = createDecorator<IHarnessAuditLogService>('harnessAuditLogService');

export interface IHarnessAuditLogService {
	readonly _serviceBrand: undefined;
	append(kind: string, detail: Record<string, unknown>): Promise<void>;
}

const REL = '.sentinel/harness-audit.jsonl';

export class HarnessAuditLogService implements IHarnessAuditLogService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IHarnessTraceService private readonly harnessTraceService: IHarnessTraceService,
		@ILogService private readonly logService: ILogService,
	) {}

	async append(kind: string, detail: Record<string, unknown>): Promise<void> {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}
		const line = JSON.stringify({
			t: Date.now(),
			trace: this.harnessTraceService.getTraceId(),
			kind,
			...detail,
		}) + '\n';
		const uri = URI.joinPath(root, REL);
		try {
			await this.fileService.createFolder(URI.joinPath(root, '.sentinel'));
		} catch {
			// ignore
		}
		try {
			let prev = '';
			try {
				prev = (await this.fileService.readFile(uri)).value.toString();
			} catch {
				// new
			}
			await this.fileService.writeFile(uri, VSBuffer.fromString(prev + line));
		} catch (e) {
			this.logService.warn(`[HarnessAudit] append failed: ${String(e)}`);
		}
	}
}

registerSingleton(IHarnessAuditLogService, HarnessAuditLogService, InstantiationType.Delayed);
