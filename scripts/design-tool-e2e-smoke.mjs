#!/usr/bin/env node
/**
 * HGT-021：设计类 E2E 前置检查（不启动浏览器）
 * 用法：在业务仓库根执行 node /path/to/vscode/scripts/design-tool-e2e-smoke.mjs
 */
import { existsSync } from 'fs';
import { join } from 'path';

const cwd = process.cwd();
const notes = join(cwd, '.sentinel', 'verifier_e2e_notes.md');
const allow = join(cwd, '.sentinel', 'mcp_allowlist.json');

console.log('[HGT-021] design-tool E2E smoke (checks only)');
console.log(`  workspace: ${cwd}`);
console.log(`  ${notes}: ${existsSync(notes) ? 'OK' : 'MISSING (recommended)'}`);
console.log(`  ${allow}: ${existsSync(allow) ? 'OK' : 'MISSING (for mcp_call)'}`);
console.log('  Verifier 工具环：使用 mcp_call + cursor-ide-browser，断言见 docs/sentinel/templates/design-tool-e2e-assertions.md');
process.exit(0);
