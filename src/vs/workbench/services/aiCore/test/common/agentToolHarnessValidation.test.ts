/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyHarnessToolValidation } from '../../common/agentToolHarnessValidation.js';
import { AGENT_TOOL_NAMES } from '../../common/agentTools.js';

suite('agentToolHarnessValidation (HGT-003)', () => {
	test('passes through failed results', () => {
		const r = applyHarnessToolValidation(AGENT_TOOL_NAMES.READ_FILE, { success: false, error: 'x' });
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.error, 'x');
	});

	test('read_file requires string output when success', () => {
		const bad = applyHarnessToolValidation(AGENT_TOOL_NAMES.READ_FILE, { success: true, output: undefined as unknown as string });
		assert.strictEqual(bad.success, false);
		const ok = applyHarnessToolValidation(AGENT_TOOL_NAMES.READ_FILE, { success: true, output: '1| hi' });
		assert.strictEqual(ok.success, true);
	});

	test('list_dir requires data.items array', () => {
		const bad = applyHarnessToolValidation(AGENT_TOOL_NAMES.LIST_DIR, { success: true, output: 'x', data: {} });
		assert.strictEqual(bad.success, false);
		const ok = applyHarnessToolValidation(AGENT_TOOL_NAMES.LIST_DIR, {
			success: true,
			output: 'x',
			data: { items: [] },
		});
		assert.strictEqual(ok.success, true);
	});

	test('mcp_call fails on empty placeholder output', () => {
		const bad = applyHarnessToolValidation(AGENT_TOOL_NAMES.MCP_CALL, {
			success: true,
			output: '(empty)',
			data: { server_id: 'a', tool_name: 'b' },
		});
		assert.strictEqual(bad.success, false);
	});

	test('write_file requires fileChanges when success', () => {
		const bad = applyHarnessToolValidation(AGENT_TOOL_NAMES.WRITE_FILE, {
			success: true,
			output: 'x',
		});
		assert.strictEqual(bad.success, false);
		const ok = applyHarnessToolValidation(AGENT_TOOL_NAMES.WRITE_FILE, {
			success: true,
			output: 'x',
			fileChanges: [{ uri: {} as never, originalContent: '', newContent: 'a', description: 'd', applied: false }],
		});
		assert.strictEqual(ok.success, true);
	});

	test('browse_url requires data.url and data.contentLength', () => {
		const bad = applyHarnessToolValidation(AGENT_TOOL_NAMES.BROWSE_URL, {
			success: true,
			output: 'hi',
			data: { url: 'https://a' },
		});
		assert.strictEqual(bad.success, false);
		const ok = applyHarnessToolValidation(AGENT_TOOL_NAMES.BROWSE_URL, {
			success: true,
			output: 'hi',
			data: { url: 'https://a', contentLength: 2 },
		});
		assert.strictEqual(ok.success, true);
	});

	test('run_command requires exitCode 0 when not legacy terminal', () => {
		const bad = applyHarnessToolValidation(AGENT_TOOL_NAMES.RUN_COMMAND, {
			success: true,
			output: 'x',
			data: { exitCode: 1, cwd: '/a', command: 'false' },
		});
		assert.strictEqual(bad.success, false);
		const ok = applyHarnessToolValidation(AGENT_TOOL_NAMES.RUN_COMMAND, {
			success: true,
			output: 'x',
			data: { exitCode: 0, cwd: '/a', command: 'true' },
		});
		assert.strictEqual(ok.success, true);
		const legacy = applyHarnessToolValidation(AGENT_TOOL_NAMES.RUN_COMMAND, {
			success: true,
			output: 'sent to terminal',
			data: { legacyTerminal: true, command: 'x', cwd: '/a' },
		});
		assert.strictEqual(legacy.success, true);
	});
});
