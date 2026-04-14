/*---------------------------------------------------------------------------------------------
 *  HGT-004：从 Verifier 输出中解析「已满足的成功准则」JSON（可选，与文本包含互补）
 *--------------------------------------------------------------------------------------------*/

/**
 * 解析 Verifier 摘要中的 JSON：`matchedSuccessCriteria` 字符串数组。
 * 支持 ```json ... ``` 代码块，或含 `"matchedSuccessCriteria"` 的 JSON 对象片段。
 */
export function tryParseVerifierMatchedSuccessCriteria(text: string): string[] | undefined {
	if (!text?.trim()) {
		return undefined;
	}
	const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(text)) !== null) {
		const parsed = parseMatchedCriteriaObject(m[1].trim());
		if (parsed?.length) {
			return parsed;
		}
	}
	const loose = text.match(/\{[\s\S]*"matchedSuccessCriteria"[\s\S]*\}/);
	if (loose) {
		const parsed = parseMatchedCriteriaObject(loose[0]);
		if (parsed?.length) {
			return parsed;
		}
	}
	return undefined;
}

function parseMatchedCriteriaObject(jsonStr: string): string[] | undefined {
	try {
		const o = JSON.parse(jsonStr) as { matchedSuccessCriteria?: unknown };
		if (!o || typeof o !== 'object') {
			return undefined;
		}
		const raw = o.matchedSuccessCriteria;
		if (!Array.isArray(raw)) {
			return undefined;
		}
		const strings = raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
		return strings.length ? strings : undefined;
	} catch {
		return undefined;
	}
}
