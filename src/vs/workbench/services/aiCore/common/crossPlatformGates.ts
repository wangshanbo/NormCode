/*---------------------------------------------------------------------------------------------
 *  跨端导出后的轻量校验门（JSON 可解析等）；重构建可配置关闭
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { CrossPlatformTargetId } from './crossPlatformExportTypes.js';

export async function runCrossPlatformGate(
	target: CrossPlatformTargetId,
	exportsTargetRoot: URI,
	fileService: IFileService,
): Promise<{ ok: boolean; detail: string }> {
	const projectRoot = joinPath(exportsTargetRoot, 'project');

	try {
		if (target === 'wechat_miniprogram') {
			const appJson = joinPath(projectRoot, 'miniprogram', 'app.json');
			const pj = joinPath(projectRoot, 'project.config.json');
			for (const u of [appJson, pj]) {
				try {
					const f = await fileService.readFile(u);
					JSON.parse(f.value.toString());
				} catch (e) {
					return { ok: false, detail: `Invalid JSON: ${u.path} — ${String(e)}` };
				}
			}
			return { ok: true, detail: 'miniprogram app.json + project.config.json parse OK' };
		}

		if (target === 'web') {
			const readme = joinPath(projectRoot, 'README.md');
			try {
				await fileService.stat(readme);
				return { ok: true, detail: 'project/README.md present' };
			} catch {
				return { ok: false, detail: 'project/README.md missing' };
			}
		}

		if (target === 'ios') {
			const readme = joinPath(projectRoot, 'README.md');
			const swift = joinPath(projectRoot, 'Sources', 'AppEntry.swift');
			try {
				await fileService.stat(readme);
				await fileService.stat(swift);
				return {
					ok: true,
					detail: 'iOS scaffold: README + Sources/AppEntry.swift (run scripts/sentinel-cross-platform-gates.mjs --target ios for optional xcodebuild)',
				};
			} catch (e) {
				return { ok: false, detail: `iOS scaffold incomplete: ${String(e)}` };
			}
		}

		if (target === 'android') {
			const readme = joinPath(projectRoot, 'README.md');
			const stub = joinPath(projectRoot, 'stub', '.gitkeep');
			try {
				await fileService.stat(readme);
				await fileService.stat(stub);
				return {
					ok: true,
					detail: 'Android scaffold: README + stub/.gitkeep (run scripts/sentinel-cross-platform-gates.mjs --target android for optional gradle check)',
				};
			} catch (e) {
				return { ok: false, detail: `Android scaffold incomplete: ${String(e)}` };
			}
		}
	} catch (e) {
		return { ok: false, detail: String(e) };
	}

	return { ok: true, detail: 'no gate' };
}
