#!/usr/bin/env node
/**
 * 最小「构建产物」断言：供 harness-eval --full 校验 dist 落盘。
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, '.sentinel-build-marker'), 'ok\n');
