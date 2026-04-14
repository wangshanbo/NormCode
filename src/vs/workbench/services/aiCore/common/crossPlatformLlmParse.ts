/*---------------------------------------------------------------------------------------------
 *  解析 LLM 返回的 JSON 文件包；路径校验，防止路径穿越
 *--------------------------------------------------------------------------------------------*/

export interface LlmFileEntry {
	readonly path: string;
	readonly content: string;
}

export interface LlmFileBundle {
	readonly files: LlmFileEntry[];
	readonly notes?: string;
}

export function isSafeRelativeExportPath(p: string): boolean {
	if (!p || typeof p !== 'string') {
		return false;
	}
	const n = p.replace(/\\/g, '/').trim();
	if (!n || n.startsWith('/') || n.includes('..')) {
		return false;
	}
	return true;
}

/**
 * 从模型输出中提取 JSON：优先整段 JSON，否则从 ```json 块中取。
 */
export function parseLlmFileBundle(raw: string): LlmFileBundle | undefined {
	const trimmed = raw.trim();
	const tryParse = (s: string): LlmFileBundle | undefined => {
		try {
			const o = JSON.parse(s) as { files?: { path: string; content: string }[]; notes?: string };
			if (!o || !Array.isArray(o.files)) {
				return undefined;
			}
			const files: LlmFileEntry[] = [];
			for (const f of o.files) {
				if (!f?.path || typeof f.content !== 'string') {
					continue;
				}
				if (!isSafeRelativeExportPath(f.path)) {
					continue;
				}
				files.push({ path: f.path.replace(/\\/g, '/'), content: f.content });
			}
			if (files.length === 0) {
				return undefined;
			}
			return { files: files.slice(0, 40), notes: typeof o.notes === 'string' ? o.notes : undefined };
		} catch {
			return undefined;
		}
	};

	let r = tryParse(trimmed);
	if (r) {
		return r;
	}
	const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(trimmed);
	if (fence?.[1]) {
		r = tryParse(fence[1].trim());
		if (r) {
			return r;
		}
	}
	const brace = trimmed.indexOf('{');
	const last = trimmed.lastIndexOf('}');
	if (brace >= 0 && last > brace) {
		r = tryParse(trimmed.slice(brace, last + 1));
	}
	return r;
}
