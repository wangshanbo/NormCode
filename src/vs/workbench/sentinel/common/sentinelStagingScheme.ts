/*---------------------------------------------------------------------------------------------
 *  Sentinel 影子 VFS Scheme（memfs://staging 语义映射到独立注册的 scheme）
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';

/** 与 IFileService.registerProvider 注册的 scheme 一致 */
export const SENTINEL_STAGING_SCHEME = 'sentinel-staging';

const STAGING_ROOT = '/workspace';

export function getSentinelStagingRootUri(): URI {
	return URI.from({ scheme: SENTINEL_STAGING_SCHEME, path: STAGING_ROOT });
}

export function resolveSentinelStagingFileUri(relativePath: string): URI {
	const clean = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
	const segments = clean.split('/').filter(Boolean);
	let path = STAGING_ROOT;
	for (const seg of segments) {
		path += `/${seg}`;
	}
	return URI.from({ scheme: SENTINEL_STAGING_SCHEME, path });
}
