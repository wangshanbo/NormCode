/*---------------------------------------------------------------------------------------------
 *  Sentinel — 合并多次实现节点输出的 package.json，避免依赖被后序节点整文件覆盖丢失
 *--------------------------------------------------------------------------------------------*/

export function mergePackageJsonStrings(existingJson: string, incomingJson: string): string {
	let base: Record<string, unknown>;
	let patch: Record<string, unknown>;
	try {
		base = JSON.parse(existingJson) as Record<string, unknown>;
	} catch {
		return incomingJson;
	}
	try {
		patch = JSON.parse(incomingJson) as Record<string, unknown>;
	} catch {
		return existingJson;
	}

	const out = { ...base, ...patch };

	const mergeDepMaps = (a: unknown, b: unknown): Record<string, string> => {
		const left = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, string>) : {};
		const right = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, string>) : {};
		return { ...left, ...right };
	};

	if (base.dependencies || patch.dependencies) {
		out.dependencies = mergeDepMaps(base.dependencies, patch.dependencies);
	}
	if (base.devDependencies || patch.devDependencies) {
		out.devDependencies = mergeDepMaps(base.devDependencies, patch.devDependencies);
	}
	if (base.peerDependencies || patch.peerDependencies) {
		out.peerDependencies = mergeDepMaps(base.peerDependencies, patch.peerDependencies);
	}
	if (base.optionalDependencies || patch.optionalDependencies) {
		out.optionalDependencies = mergeDepMaps(base.optionalDependencies, patch.optionalDependencies);
	}
	if (base.scripts || patch.scripts) {
		out.scripts = { ...(typeof base.scripts === 'object' && base.scripts ? base.scripts as Record<string, string> : {}), ...(typeof patch.scripts === 'object' && patch.scripts ? patch.scripts as Record<string, string> : {}) };
	}

	return JSON.stringify(out, null, 2) + '\n';
}
