/*---------------------------------------------------------------------------------------------
 *  Sentinel — 工作区 MCP 白名单自动脚手架（用户无需理解 MCP 概念）
 *  在 harness 启用且需要 Verifier/行为验证时，若缺少或空白名单则写入默认条目并供 Bridge 合并。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import type { IFileService } from '../../../platform/files/common/files.js';
import type { ResolvedHarnessConfig } from './harnessConfigService.js';

/** 与 docs/sentinel/mcp_allowlist.anthropic.example.json 一致；definitions 可由后续 Agent 或用户补全 */
const DEFAULT_MCP_ALLOWLIST = {
	_comment:
		'由 NormCode Sentinel 自动生成。server 白名单用于 mcp_call；若 IDE 已内置 cursor-ide-browser 仅需此处声明 id。若需独立进程，请在 definitions 中写入与 .vscode/mcp.json 一致的启动配置。',
	syncChatMcpAccess: true,
	servers: ['cursor-ide-browser'],
	definitions: {} as Record<string, unknown>,
};

function allowlistHasServers(parsed: { servers?: unknown; definitions?: unknown }): boolean {
	if (parsed.definitions && typeof parsed.definitions === 'object') {
		const keys = Object.keys(parsed.definitions as object);
		if (keys.length > 0) {
			return true;
		}
	}
	const s = parsed.servers;
	if (Array.isArray(s)) {
		return s.length > 0;
	}
	if (s && typeof s === 'object') {
		return Object.keys(s as object).length > 0;
	}
	return false;
}

/**
 * 在 harness 需要 MCP 验证路径时，确保白名单文件存在且非空。
 * @returns created | already_ok | skipped
 */
export async function ensureDefaultMcpAllowlistIfNeeded(
	fileService: IFileService,
	workspaceRoot: URI,
	cfg: ResolvedHarnessConfig,
	log?: { info: (s: string) => void },
): Promise<'created' | 'already_ok' | 'skipped'> {
	const needsMcp =
		cfg.enabled &&
		(cfg.anthropicHarnessParity || cfg.verifierAgentToolLoop || cfg.behavioralE2E);
	if (!needsMcp) {
		return 'skipped';
	}

	const rel = (cfg.mcpAllowlistFile || '.sentinel/mcp_allowlist.json').replace(/\\/g, '/').replace(/^\//, '');
	let allowUri = workspaceRoot;
	for (const seg of rel.split('/').filter(x => x.length > 0)) {
		allowUri = URI.joinPath(allowUri, seg);
	}

	const sentinelDir = URI.joinPath(workspaceRoot, '.sentinel');
	try {
		await fileService.createFolder(sentinelDir);
	} catch {
		// ignore
	}

	let shouldWrite = false;
	try {
		const raw = JSON.parse((await fileService.readFile(allowUri)).value.toString()) as {
			servers?: unknown;
			definitions?: unknown;
		};
		if (!allowlistHasServers(raw)) {
			shouldWrite = true;
		}
	} catch {
		shouldWrite = true;
	}

	if (!shouldWrite) {
		return 'already_ok';
	}

	await fileService.writeFile(allowUri, VSBuffer.fromString(JSON.stringify(DEFAULT_MCP_ALLOWLIST, null, '\t')));
	log?.info(`[Sentinel MCP] Auto-created default allowlist: ${rel}`);
	return 'created';
}
