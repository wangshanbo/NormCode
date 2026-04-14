# HGT-026：Playwright + 独立 Evaluator 目录模板

在**工作区根**下创建目录（默认与 `harness.json` 中 `evaluatorPlaywrightDir` 一致，常为 `.sentinel/playwright/`），并至少包含：

1. `package.json`（`devDependencies` 含 `@playwright/test`，`scripts.test` 可指向 `playwright test`）
2. `playwright.config.ts`（或 `.mts` / `.js` / `.mjs`）

## 最小示例 `package.json`

```json
{
  "name": "sentinel-playwright-eval",
  "private": true,
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.42.0"
  }
}
```

## 最小示例 `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:5173' },
});
```

在 `tests/` 下编写 `*.spec.ts`。IDE 在 **verify** 节点且 `evaluatorPipelineEnabled: true` 时，会在该目录执行：

`npx playwright test --reporter=json`

报告会写入工作区 `.sentinel/last_playwright_report.json`，并与 `evaluatorRubricPath` 一并交给 **Tier1 轻量模型**做独立打分（与 Implementer 路由分离）。

## 注意

- 首次请在目录内执行 `npm install` 与 `npx playwright install`（浏览器依赖）。
- 长时间/大规模套件建议在 **CI** 跑；IDE 内执行受单次 shell 超时影响。

---

*版本：2026-03-30*
