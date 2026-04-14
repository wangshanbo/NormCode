#!/usr/bin/env node
/**
 * HGT-001：内部 Harness Eval（最小集）
 * 用法:
 *   node scripts/harness-eval/run.mjs
 *   node scripts/harness-eval/run.mjs --full
 *   node scripts/harness-eval/run.mjs /path/to/workspace [--full]
 * 默认无参数时：依次跑全部内置夹具（minimal-workspace + tiny-lib + real-app-skeleton）。
 * 环境: Node 18+
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_FIXTURES = [
	join(__dirname, 'fixtures/minimal-workspace'),
	join(__dirname, 'fixtures/tiny-lib'),
	join(__dirname, 'fixtures/real-app-skeleton'),
];
const full = process.argv.includes('--full');
const posArgs = process.argv.slice(2).filter(a => a !== '--full');

function fail(msg) {
	console.error(`[harness-eval] FAIL: ${msg}`);
	process.exit(1);
}

/**
 * tiny-lib 夹具在 build 后应落盘 dist/.sentinel-build-marker（内容 ok）
 */
function assertPostBuildArtifacts(root) {
	const marker = join(root, 'dist', '.sentinel-build-marker');
	if (!existsSync(marker)) {
		return;
	}
	const content = readFileSync(marker, 'utf8').trim();
	if (content !== 'ok') {
		fail(`dist/.sentinel-build-marker 内容异常: ${JSON.stringify(content)} (${root})`);
	}
	console.log(`[harness-eval] OK: post-build marker ${root}`);
}

function runOne(root) {
	if (!existsSync(join(root, 'package.json'))) {
		fail(`缺少 package.json: ${root}`);
	}

	if (full) {
		const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
			cwd: root,
			encoding: 'utf8',
			shell: false,
		});
		if (r.status !== 0) {
			fail(`npm run build exit ${r.status}\n${r.stderr || r.stdout || ''}`);
		}
		assertPostBuildArtifacts(root);
		console.log(`[harness-eval] OK: npm run build in ${root}`);
	} else {
		console.log(`[harness-eval] OK: fixture present ${root} (pass --full to run npm run build)`);
	}
}

const single = posArgs[0] ? join(posArgs[0]) : null;
if (single) {
	runOne(single);
} else {
	for (const f of BUILTIN_FIXTURES) {
		runOne(f);
	}
}
