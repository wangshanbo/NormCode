/*---------------------------------------------------------------------------------------------
 *  Sentinel MCP Bridge — 将 .sentinel/mcp_allowlist.json 合并到 .vscode/mcp.json，
 *  并可选将 chat.mcp.access 提升到 Registry，以便 Chat/MCP 宿主侧动态启用。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { mcpAccessConfig, McpAccessValue } from '../../../platform/mcp/common/mcpManagement.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IHarnessConfigService } from './harnessConfigService.js';

export const ISentinelMcpBridgeService = createDecorator<ISentinelMcpBridgeService>('ISentinelMcpBridgeService');

export interface McpAllowlistFileShape {
	servers?: string[] | Record<string, Record<string, unknown>>;
	/** 与 servers 字符串 id 配套的完整 MCP server 定义 */
	definitions?: Record<string, Record<string, unknown>>;
	/** 默认 true：存在可合并定义时，将工作区 chat.mcp.access 设为 registry（若当前为 none） */
	syncChatMcpAccess?: boolean;
}

export interface SentinelMcpSyncResult {
	mergedServerIds: string[];
	wroteMcpJson: boolean;
	updatedChatAccess: boolean;
	detail: string;
}

export interface ISentinelMcpBridgeService {
	readonly _serviceBrand: undefined;
	/** 读取 harness 配置的 allowlist 路径并同步到工作区 MCP 配置 */
	syncAllowlistToWorkspace(): Promise<SentinelMcpSyncResult>;
}

const VSCODE_FOLDER = '.vscode';
const MCP_JSON = 'mcp.json';

export class SentinelMcpBridgeService extends Disposable implements ISentinelMcpBridgeService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHarnessConfigService private readonly harnessConfigService: IHarnessConfigService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async syncAllowlistToWorkspace(): Promise<SentinelMcpSyncResult> {
		const cfg = await this.harnessConfigService.getResolved();
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return { mergedServerIds: [], wroteMcpJson: false, updatedChatAccess: false, detail: 'no workspace folder' };
		}
		let allowUri = root;
		const rel = (cfg.mcpAllowlistFile || '.sentinel/mcp_allowlist.json').replace(/\\/g, '/');
		for (const seg of rel.split('/').filter(s => s.length > 0)) {
			allowUri = URI.joinPath(allowUri, seg);
		}
		let raw: McpAllowlistFileShape;
		try {
			raw = JSON.parse((await this.fileService.readFile(allowUri)).value.toString()) as McpAllowlistFileShape;
		} catch {
			return { mergedServerIds: [], wroteMcpJson: false, updatedChatAccess: false, detail: 'allowlist file missing or invalid' };
		}

		const parsed = this.collectServerEntries(raw);
		if (parsed.allIds.length === 0) {
			return { mergedServerIds: [], wroteMcpJson: false, updatedChatAccess: false, detail: 'allowlist has no server ids' };
		}

		let wroteMcpJson = false;
		if (Object.keys(parsed.mergedDefinitions).length > 0) {
			const mcpUri = URI.joinPath(root, VSCODE_FOLDER, MCP_JSON);
			await this.fileService.createFolder(URI.joinPath(root, VSCODE_FOLDER));

			let existing: { servers?: Record<string, unknown>; inputs?: unknown[] } = {};
			try {
				existing = JSON.parse((await this.fileService.readFile(mcpUri)).value.toString()) as typeof existing;
			} catch {
				existing = { servers: {}, inputs: [] };
			}
			const servers = { ...(existing.servers || {}), ...parsed.mergedDefinitions } as Record<string, unknown>;
			const next = {
				servers,
				inputs: Array.isArray(existing.inputs) ? existing.inputs : [],
			};
			await this.fileService.writeFile(mcpUri, VSBuffer.fromString(JSON.stringify(next, undefined, '\t')));
			wroteMcpJson = true;
		}

		let updatedChatAccess = false;
		const syncAccess = raw.syncChatMcpAccess !== false;
		if (syncAccess) {
			const cur = this.configurationService.inspect(mcpAccessConfig);
			const workspaceVal = cur.workspaceValue ?? cur.workspaceFolderValue;
			if (workspaceVal === undefined || workspaceVal === McpAccessValue.None) {
				await this.configurationService.updateValue(mcpAccessConfig, McpAccessValue.Registry, ConfigurationTarget.WORKSPACE);
				updatedChatAccess = true;
			}
		}

		this.logService.info(`[Sentinel MCP] allowlist ids=${parsed.allIds.length} wroteMcp=${wroteMcpJson} chatAccess=${updatedChatAccess}`);
		return {
			mergedServerIds: parsed.allIds,
			wroteMcpJson,
			updatedChatAccess,
			detail: wroteMcpJson ? `merged ${Object.keys(parsed.mergedDefinitions).join(', ')}` : 'chat/registry sync only (add definitions for mcp.json merge)',
		};
	}

	private collectServerEntries(raw: McpAllowlistFileShape): { allIds: string[]; mergedDefinitions: Record<string, Record<string, unknown>> } {
		const fromDefs = { ...(raw.definitions || {}) } as Record<string, Record<string, unknown>>;
		const allIds: string[] = [];
		const mergedDefinitions: Record<string, Record<string, unknown>> = {};

		if (raw.servers && !Array.isArray(raw.servers)) {
			for (const [id, def] of Object.entries(raw.servers)) {
				allIds.push(id);
				if (def && typeof def === 'object') {
					mergedDefinitions[id] = def as Record<string, unknown>;
				}
			}
		} else if (Array.isArray(raw.servers)) {
			for (const id of raw.servers.map(String)) {
				allIds.push(id);
				if (fromDefs[id]) {
					mergedDefinitions[id] = fromDefs[id];
				}
			}
		}

		for (const [id, def] of Object.entries(fromDefs)) {
			if (!mergedDefinitions[id]) {
				mergedDefinitions[id] = def;
			}
		}
		if (allIds.length === 0 && Object.keys(mergedDefinitions).length > 0) {
			return { allIds: Object.keys(mergedDefinitions), mergedDefinitions };
		}

		return { allIds, mergedDefinitions };
	}
}

registerSingleton(ISentinelMcpBridgeService, SentinelMcpBridgeService, InstantiationType.Delayed);
