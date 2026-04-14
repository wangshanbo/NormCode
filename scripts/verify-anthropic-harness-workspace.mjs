#!/usr/bin/env node
/**
 * Anthropic 范式 — 工作区侧静态验收（不调用 LLM）。
 * 用法: node scripts/verify-anthropic-harness-workspace.mjs [工作区根目录]
 * 环境变量 STRICT=1 时，缺少 feature_registry / 进度日志也视为失败（适合跑过一轮 Sentinel 后的回归）
 * 退出码: 0 无致命项; 1 存在致命项
 */
import * as fs from 'fs';
import * as path from 'path';

const strict = process.env.STRICT === '1' || process.env.STRICT === 'true';
const root = path.resolve(process.argv[2] || process.cwd());
const sentinel = path.join(root, '.sentinel');

const critical = [];
const warnings = [];

function crit(msg) {
	critical.push(msg);
}
function warn(msg) {
	warnings.push(msg);
}
function ok(msg) {
	console.log(`✓ ${msg}`);
}

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
}

if (!fs.existsSync(sentinel)) {
	crit(`.sentinel 目录不存在: ${sentinel}`);
} else {
	ok('.sentinel 存在');
}

const harnessPath = path.join(sentinel, 'harness.json');
const harness = readJson(harnessPath);
if (!harness) {
	crit(`缺少或无法解析 ${harnessPath}`);
} else {
	if (harness.enabled === true) {
		ok('harness.json enabled=true');
	} else {
		crit('harness.json 中 enabled 应为 true（Anthropic 流水线前提）');
	}
	if (harness.anthropicHarnessParity === true) {
		ok('harness.json anthropicHarnessParity=true');
	} else {
		crit('harness.json 中 anthropicHarnessParity 应为 true');
	}
}

const allowPath = path.join(sentinel, 'mcp_allowlist.json');
const allow = readJson(allowPath);
if (!allow) {
	warn(`未找到 mcp_allowlist.json（Verifier 浏览器 E2E 需配置）: ${allowPath}`);
} else {
	const servers = allow.servers;
	const defs = allow.definitions && typeof allow.definitions === 'object' ? Object.keys(allow.definitions) : [];
	const ids = Array.isArray(servers) ? servers.map(String) : typeof servers === 'object' && servers ? Object.keys(servers) : [];
	const merged = [...new Set([...ids, ...defs])];
	if (merged.some(s => /browser|playwright/i.test(s))) {
		ok(`mcp_allowlist 含浏览器类 server: ${merged.filter(s => /browser|playwright/i.test(s)).join(', ')}`);
	} else {
		warn('mcp_allowlist 建议包含 cursor-ide-browser（或 Playwright MCP）以便 Verifier 工具闭环');
	}
}

const regPath = harness?.featureRegistryPath || '.sentinel/feature_registry.json';
const regAbs = path.join(root, regPath.replace(/^\//, ''));
const reg = readJson(regAbs);
if (!reg || !Array.isArray(reg.features)) {
	const msg = `尚未生成 feature_registry（首次在 IDE 内 planIntent / parity 脚手架后会出现）: ${regAbs}`;
	if (strict) {
		crit(msg);
	} else {
		warn(msg);
	}
} else {
	ok(`feature_registry.json 可读，features=${reg.features.length} 条`);
	const withPasses = reg.features.filter(f => f && typeof f.passes === 'boolean');
	if (withPasses.length === reg.features.length) {
		ok('feature 项均含 passes 字段');
	} else {
		warn('部分 feature 缺少 passes 字段（建议布尔，便于增量验收）');
	}
}

const progPath = harness?.progressLogPath || '.sentinel/sentinel_progress.txt';
const progAbs = path.join(root, progPath.replace(/^\//, ''));
if (fs.existsSync(progAbs)) {
	const st = fs.statSync(progAbs);
	ok(`进度日志存在: ${progAbs} (${st.size} bytes)`);
} else {
	const msg = `进度日志尚未生成（首次 planIntent 后会写入）: ${progAbs}`;
	if (strict) {
		crit(msg);
	} else {
		warn(msg);
	}
}

console.log(`\n工作区: ${root}${strict ? ' (STRICT=1)' : ''}\n`);
for (const w of warnings) {
	console.log(`! ${w}`);
}
if (warnings.length) {
	console.log('');
}

if (critical.length) {
	for (const c of critical) {
		console.log(`✗ ${c}`);
	}
	console.log('\n致命项说明: harness 配置错误；修复后重跑。\n');
	process.exit(1);
}

console.log('无致命项。警告项在「尚未跑过 Sentinel 规划」的工作区为正常现象。\n');
console.log('论文对齐提示: 结构层（注册表/进度/MCP）应稳定；底模弱时更看工具循环与 Evaluator 证据链。\n');
process.exit(0);
