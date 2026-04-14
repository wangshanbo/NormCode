/*---------------------------------------------------------------------------------------------
 *  MCP 工具白名单（M3）— 按需挂载前的协议层约束
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { IHarnessConfigService } from './harnessConfigService.js';

export const IMcpToolRegistryService = createDecorator<IMcpToolRegistryService>('IMcpToolRegistryService');

export interface IMcpToolRegistryService {
	readonly _serviceBrand: undefined;
	/** 允许的 MCP server id；空表示未配置限制（由上层决定是否全量） */
	getAllowedMcpServerIds(): Promise<string[]>;
}

export class McpToolRegistryService extends Disposable implements IMcpToolRegistryService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IHarnessConfigService private readonly harnessConfigService: IHarnessConfigService,
	) {
		super();
	}

	async getAllowedMcpServerIds(): Promise<string[]> {
		const cfg = await this.harnessConfigService.getResolved();
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return [];
		}
		const rel = cfg.mcpAllowlistFile || '.sentinel/mcp_allowlist.json';
		let uri = root;
		for (const seg of rel.replace(/\\/g, '/').split('/').filter(s => s.length > 0)) {
			uri = URI.joinPath(uri, seg);
		}
		try {
			const file = await this.fileService.readFile(uri);
			const data = JSON.parse(file.value.toString()) as { servers?: string[] | Record<string, unknown>; definitions?: Record<string, unknown> };
			if (Array.isArray(data.servers)) {
				return data.servers.map(String);
			}
			if (data.servers && typeof data.servers === 'object') {
				return Object.keys(data.servers);
			}
			if (data.definitions && typeof data.definitions === 'object') {
				return Object.keys(data.definitions);
			}
			return [];
		} catch {
			return [];
		}
	}
}

registerSingleton(IMcpToolRegistryService, McpToolRegistryService, InstantiationType.Delayed);
