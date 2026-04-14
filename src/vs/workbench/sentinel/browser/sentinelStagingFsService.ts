/*---------------------------------------------------------------------------------------------
 *  Sentinel Staging — InMemoryFileSystemProvider 注册（影子 VFS）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { SENTINEL_STAGING_SCHEME } from '../common/sentinelStagingScheme.js';

export const ISentinelStagingFsService = createDecorator<ISentinelStagingFsService>('ISentinelStagingFsService');

export interface ISentinelStagingFsService {
	readonly _serviceBrand: undefined;
	readonly ready: Promise<void>;
}

export class SentinelStagingFsService extends Disposable implements ISentinelStagingFsService {
	readonly _serviceBrand: undefined;
	readonly ready: Promise<void>;

	constructor(
		@IFileService fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const provider = this._register(new InMemoryFileSystemProvider());
		this._register(fileService.registerProvider(SENTINEL_STAGING_SCHEME, provider));
		this.ready = Promise.resolve();
		this.logService.info(`[Sentinel Harness] Registered ${SENTINEL_STAGING_SCHEME}:// staging provider`);
	}
}

registerSingleton(ISentinelStagingFsService, SentinelStagingFsService, InstantiationType.Eager);
