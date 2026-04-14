#!/usr/bin/env node
/**
 * 模拟多目录构建：读 src、写 dist 标记（供 harness-eval --full 断言）
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'entry.txt');
if (!existsSync(src)) {
	console.error('missing src/entry.txt');
	process.exit(1);
}
readFileSync(src, 'utf8');

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, '.sentinel-build-marker'), 'ok', 'utf8');
console.log('[real-app-skeleton] build ok');
