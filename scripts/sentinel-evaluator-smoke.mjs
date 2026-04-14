#!/usr/bin/env node
/**
 * HGT-026：Evaluator rubric 占位与健康检查（IDE 内完整流水线见 sentinelEvaluatorPipelineService）
 * 用法：node scripts/sentinel-evaluator-smoke.mjs [工作区根，默认 cwd]
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const root = process.argv[2] ? process.argv[2] : process.cwd();
const rubric = join(root, '.sentinel', 'evaluator_rubric.md');

console.log('[HGT-026] evaluator rubric smoke');
console.log(`  root: ${root}`);
if (!existsSync(rubric)) {
	console.warn(`  WARN: missing ${rubric} — 可从 harness 默认路径复制或自建`);
}
else {
	const head = readFileSync(rubric, 'utf8').split('\n').slice(0, 12).join('\n');
	console.log('  rubric (first lines):\n---\n' + head + '\n---');
}
console.log('  全自动 Playwright 打分流水线未在仓库内联实现；请在业务侧接 CI + 独立 Playwright 项目。');
process.exit(0);
