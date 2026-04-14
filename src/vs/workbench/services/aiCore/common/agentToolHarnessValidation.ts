/*---------------------------------------------------------------------------------------------
 *  HGT-003：工具结果后置校验（可插拔入口）
 *  在 executeTool 内统一调用；失败时结构化 error，禁止把「结构不完整」当成功继续。
 *--------------------------------------------------------------------------------------------*/

import type { AgentToolResult } from './agentTools.js';
import { AGENT_TOOL_NAMES } from './agentTools.js';

/** Web 等无 INativeHostService 时终端注入路径，无 exitCode */
const LEGACY_TERMINAL = 'legacyTerminal';

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 对工具返回做后置校验。工具内已判失败的不变；成功路径上补一层 schema 式检查。
 */
export function applyHarnessToolValidation(toolName: string, result: AgentToolResult): AgentToolResult {
	if (!result.success) {
		return result;
	}

	switch (toolName) {
		case AGENT_TOOL_NAMES.READ_FILE: {
			if (typeof result.output !== 'string') {
				return { success: false, error: 'read_file：缺少 output 字符串（后置校验）' };
			}
			return result;
		}
		case AGENT_TOOL_NAMES.LIST_DIR: {
			if (!isRecord(result.data) || !Array.isArray((result.data as { items?: unknown }).items)) {
				return {
					success: false,
					error: 'list_dir：成功结果缺少 data.items 数组（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.SEARCH_FILES: {
			if (!isRecord(result.data) || typeof (result.data as { count?: unknown }).count !== 'number') {
				return {
					success: false,
					error: 'search_files：成功结果缺少 data.count（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.GREP_SEARCH: {
			if (!isRecord(result.data) || typeof (result.data as { matchCount?: unknown }).matchCount !== 'number') {
				return {
					success: false,
					error: 'grep_search：成功结果缺少 data.matchCount（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.GET_DIAGNOSTICS: {
			if (!isRecord(result.data) || typeof (result.data as { count?: unknown }).count !== 'number') {
				return {
					success: false,
					error: 'get_diagnostics：成功结果缺少 data.count（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.MCP_CALL: {
			const out = (result.output ?? '').trim();
			if (out === '(empty)') {
				return {
					success: false,
					error: 'mcp_call：工具返回空正文，按失败处理以免静默继续（后置校验）',
					output: result.output,
					data: result.data,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.WRITE_FILE: {
			const fc = (result as { fileChanges?: unknown }).fileChanges;
			if (!Array.isArray(fc) || fc.length === 0) {
				return {
					success: false,
					error: 'write_file：成功结果缺少 fileChanges 数组（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.BROWSE_URL: {
			if (!isRecord(result.data) || typeof (result.data as { url?: unknown }).url !== 'string') {
				return {
					success: false,
					error: 'browse_url：成功结果缺少 data.url（后置校验）',
					output: result.output,
				};
			}
			if (typeof (result.data as { contentLength?: unknown }).contentLength !== 'number') {
				return {
					success: false,
					error: 'browse_url：成功结果缺少 data.contentLength（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.WEB_SEARCH: {
			if (!isRecord(result.data) || typeof (result.data as { query?: unknown }).query !== 'string') {
				return {
					success: false,
					error: 'web_search_deep：成功结果缺少 data.query（后置校验）',
					output: result.output,
				};
			}
			return result;
		}
		case AGENT_TOOL_NAMES.RUN_COMMAND: {
			if (!result.success) {
				return result;
			}
			const data = result.data;
			if (isRecord(data) && data[LEGACY_TERMINAL] === true) {
				return result;
			}
			if (!isRecord(data) || typeof data['exitCode'] !== 'number') {
				return {
					success: false,
					error: 'run_command：成功路径缺少 data.exitCode（桌面 Electron 应走子进程；仅 legacy 终端可豁免）',
					output: result.output,
					data: result.data,
				};
			}
			if ((data['exitCode'] as number) !== 0) {
				return {
					success: false,
					error: `run_command：exitCode=${data['exitCode']}`,
					output: result.output,
					data: result.data,
				};
			}
			return result;
		}
		default:
			return result;
	}
}
