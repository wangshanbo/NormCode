/*---------------------------------------------------------------------------------------------
 *  HGT-002：全链路 traceId（Sentinel 节点 / Agent 工具可 grep 串联）
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const IHarnessTraceService = createDecorator<IHarnessTraceService>('harnessTraceService');

export interface IHarnessTraceService {
	readonly _serviceBrand: undefined;
	/** 开始一段可观测区间，返回 traceId */
	beginTrace(scope: string): string;
	/** 当前活跃 traceId（无则 undefined） */
	getTraceId(): string | undefined;
	/** 结束最近一段 beginTrace */
	endTrace(): void;
}

export class HarnessTraceService implements IHarnessTraceService {
	readonly _serviceBrand: undefined;

	private stack: Array<{ id: string; scope: string }> = [];

	constructor(@ILogService private readonly logService: ILogService) { }

	beginTrace(scope: string): string {
		const id = `hgt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
		this.stack.push({ id, scope });
		this.logService.info(`[trace=${id}] harnessTrace begin ${scope}`);
		return id;
	}

	getTraceId(): string | undefined {
		return this.stack[this.stack.length - 1]?.id;
	}

	endTrace(): void {
		const top = this.stack[this.stack.length - 1];
		if (top) {
			this.logService.info(`[trace=${top.id}] harnessTrace end ${top.scope}`);
		}
		this.stack.pop();
	}
}

registerSingleton(IHarnessTraceService, HarnessTraceService, InstantiationType.Delayed);
