#!/usr/bin/env node
/**
 * 消费 `.sentinel/pending_git_commands.jsonl` 中的行并在对应 cwd 执行 git（每行 JSON 需含 cwd、cmd）。
 * 用法（仓库根）：node scripts/sentinel-git-commit.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const root = process.cwd();
const pending = join(root, '.sentinel', 'pending_git_commands.jsonl');
if (!existsSync(pending)) {
	console.log('No pending_git_commands.jsonl');
	process.exit(0);
}

const raw = readFileSync(pending, 'utf8');
const lines = raw.split('\n').filter(Boolean);
const rest = [];
for (const line of lines) {
	try {
		const j = JSON.parse(line);
		if (j.cmd && j.cwd) {
			console.log(`Running in ${j.cwd}: ${j.cmd}`);
			if (process.platform === 'win32') {
				execFileSync('cmd.exe', ['/d', '/s', '/c', j.cmd], { cwd: j.cwd, stdio: 'inherit' });
			} else {
				execFileSync('/bin/sh', ['-c', j.cmd], { cwd: j.cwd, stdio: 'inherit' });
			}
		}
	} catch (e) {
		console.warn('Skip line:', e.message);
		rest.push(line);
	}
}
writeFileSync(pending, rest.length ? rest.join('\n') + '\n' : '');
