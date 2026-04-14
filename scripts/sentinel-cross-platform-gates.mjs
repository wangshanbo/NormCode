#!/usr/bin/env node
/**
 * HGT-023～024：跨端导出后的可选本机构建门（Golden / CI）。
 * 用法：node scripts/sentinel-cross-platform-gates.mjs --workspace <dir> --target ios|android|web|wechat_miniprogram
 * 退出码：0 = 通过或未安装工具时跳过；1 = 校验失败。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, def) {
	const i = process.argv.indexOf(name);
	if (i >= 0 && process.argv[i + 1]) {
		return process.argv[i + 1];
	}
	return def;
}

const workspace = resolve(arg('--workspace', process.cwd()));
const target = arg('--target', 'web');

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
	return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

let ok = true;
let detail = '';

if (target === 'ios') {
	const exportsIos = join(workspace, 'exports', 'ios', 'project');
	if (!existsSync(join(exportsIos, 'README.md'))) {
		console.error(JSON.stringify({ ok: false, detail: 'missing exports/ios/project/README.md' }));
		process.exit(1);
	}
	const xcp = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' });
	if (xcp.status === 0) {
		detail = `xcodebuild present: ${xcp.stdout?.split('\n')[0] ?? 'ok'}`;
	} else {
		detail = 'xcodebuild not in PATH — skipped (install Xcode CLI on macOS for full gate)';
	}
}

if (target === 'android') {
	const exportsAnd = join(workspace, 'exports', 'android', 'project');
	if (!existsSync(join(exportsAnd, 'README.md'))) {
		console.error(JSON.stringify({ ok: false, detail: 'missing exports/android/project/README.md' }));
		process.exit(1);
	}
	const gradlew = join(workspace, 'gradlew');
	if (existsSync(gradlew)) {
		const r = run(gradlew, ['-q', 'tasks', '--all'], { cwd: workspace });
		ok = r.code === 0;
		detail = ok ? 'gradlew tasks OK' : `gradlew failed: ${r.out.slice(0, 500)}`;
	} else {
		detail = 'no gradlew at workspace root — stub gate only (see exports/android/project)';
	}
}

if (target === 'web') {
	const pkg = join(workspace, 'package.json');
	if (!existsSync(pkg)) {
		console.error(JSON.stringify({ ok: false, detail: 'no package.json at workspace root' }));
		process.exit(1);
	}
	try {
		const j = JSON.parse(readFileSync(pkg, 'utf8'));
		if (!j.scripts?.build) {
			detail = 'package.json has no scripts.build — gate skipped';
		} else {
			const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: workspace });
			ok = r.code === 0;
			detail = ok ? 'npm run build OK' : `npm run build failed: ${r.out.slice(0, 800)}`;
		}
	} catch (e) {
		ok = false;
		detail = String(e);
	}
}

if (target === 'wechat_miniprogram') {
	const mp = join(workspace, 'exports', 'wechat_miniprogram', 'project', 'miniprogram', 'app.json');
	if (!existsSync(mp)) {
		console.error(JSON.stringify({ ok: false, detail: 'missing wechat miniprogram app.json' }));
		process.exit(1);
	}
	try {
		JSON.parse(readFileSync(mp, 'utf8'));
		detail = 'miniprogram app.json parse OK';
	} catch (e) {
		ok = false;
		detail = String(e);
	}
}

console.log(JSON.stringify({ ok, target, detail: detail || 'gate complete' }, null, 2));
process.exit(ok ? 0 : 1);
