/*---------------------------------------------------------------------------------------------
 *  Harness GateKeeper — ADR 签收闸门 + 路径白名单
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { SecurityHarnessException } from '../common/harnessErrors.js';
import { Intent } from '../common/intentTypes.js';
import { IHarnessConfigService } from './harnessConfigService.js';

export const IHarnessGateService = createDecorator<IHarnessGateService>('IHarnessGateService');

export interface IHarnessGateService {
	readonly _serviceBrand: undefined;
	assertAdrSignedOff(intent: Intent): Promise<void>;
	isRelativePathInScope(filePath: string, allowedPrefixes: string[]): boolean;
}

export class HarnessGateService extends Disposable implements IHarnessGateService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IHarnessConfigService private readonly harnessConfigService: IHarnessConfigService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async assertAdrSignedOff(intent: Intent): Promise<void> {
		const cfg = await this.harnessConfigService.getResolved();
		if (!cfg.enabled || !cfg.adrGate) {
			return;
		}
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			throw new SecurityHarnessException('Harness ADR 闸门：未打开工作区，禁止物化。');
		}
		const adrUri = URI.joinPath(root, '.sentinel', 'ARCH_DECISION_RECORD.md');
		const signUri = URI.joinPath(root, '.sentinel', 'adr_signoff.json');

		let adrOk = false;
		try {
			const adr = await this.fileService.readFile(adrUri);
			adrOk = adr.value.toString().includes('```json') && adr.value.toString().includes('logic_path');
		} catch {
			adrOk = false;
		}
		if (!adrOk) {
			throw new SecurityHarnessException(
				'缺少有效的 .sentinel/ARCH_DECISION_RECORD.md（需含 ADR JSON）。',
				'intent=' + intent.id,
			);
		}

		try {
			const sign = await this.fileService.readFile(signUri);
			const o = JSON.parse(sign.value.toString()) as { approved?: boolean };
			if (o.approved !== true) {
				throw new SecurityHarnessException('ADR 尚未通过 adr_signoff.json 签收（approved: true）。');
			}
		} catch (e) {
			if (e instanceof SecurityHarnessException) {
				throw e;
			}
			throw new SecurityHarnessException('无法读取或解析 .sentinel/adr_signoff.json。');
		}

		this.logService.info('[Sentinel Harness] ADR gate passed for intent ' + intent.id);
	}

	isRelativePathInScope(filePath: string, allowedPrefixes: string[]): boolean {
		if (!allowedPrefixes || allowedPrefixes.length === 0) {
			return true;
		}
		const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
		return allowedPrefixes.some(p => {
			const pre = p.replace(/\\/g, '/').replace(/\/$/, '');
			return norm === pre || norm.startsWith(pre + '/');
		});
	}
}

registerSingleton(IHarnessGateService, HarnessGateService, InstantiationType.Delayed);
