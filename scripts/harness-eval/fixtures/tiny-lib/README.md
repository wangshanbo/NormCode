# harness-eval：第二夹具（tiny-lib）

`npm run build` 会创建 `dist/.sentinel-build-marker`，供 `run.mjs --full` 做**文件存在性**断言（与 `minimal-workspace` 仅 exit 0 区分）。
