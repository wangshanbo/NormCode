/*---------------------------------------------------------------------------------------------
 *  Sentinel Harness — 安全闸门异常
 *--------------------------------------------------------------------------------------------*/

export class SecurityHarnessException extends Error {
	readonly code = 'SECURITY_HARNESS';

	constructor(message: string, readonly detail?: string) {
		super(message);
		this.name = 'SecurityHarnessException';
		Object.setPrototypeOf(this, SecurityHarnessException.prototype);
	}
}
