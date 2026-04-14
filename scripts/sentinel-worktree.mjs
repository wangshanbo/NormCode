#!/usr/bin/env node
/**
 * HGT-005：在仓库根为 Sentinel Intent 创建 git worktree。
 * 用法：node scripts/sentinel-worktree.mjs <intentId>
 * 工作目录：须为 git 仓库根（与 VS Code 打开的工作区一致）。
 */
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const intentId = process.argv[2];
if (!intentId) {
	console.error('Usage: node scripts/sentinel-worktree.mjs <intentId>');
	process.exit(1);
}

const safe = intentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const root = process.cwd();
const rel = join('.sentinel', 'worktrees', safe);
const target = join(root, rel);

if (existsSync(target)) {
	console.log(`Path already exists: ${rel}`);
	process.exit(0);
}

mkdirSync(join(root, '.sentinel', 'worktrees'), { recursive: true });

const branch = `sentinel/${safe}`;
try {
	execFileSync('git', ['worktree', 'add', '-b', branch, target], { cwd: root, stdio: 'inherit' });
	console.log(`OK: ${rel} (branch ${branch})`);
} catch (e) {
	console.error(e);
	process.exit(1);
}
