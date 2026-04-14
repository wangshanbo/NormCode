/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tryParseVerifierMatchedSuccessCriteria } from '../../common/verificationVerifierCriteriaParse.js';

suite('verificationVerifierCriteriaParse (HGT-004)', () => {
	test('parses fenced json block', () => {
		const text = `## 裁定\n\`\`\`json\n{"matchedSuccessCriteria":["准则A","准则B"]}\n\`\`\``;
		const r = tryParseVerifierMatchedSuccessCriteria(text);
		assert.deepStrictEqual(r, ['准则A', '准则B']);
	});

	test('parses loose json with matchedSuccessCriteria', () => {
		const text = 'prefix {"matchedSuccessCriteria":["仅一条"]} suffix';
		const r = tryParseVerifierMatchedSuccessCriteria(text);
		assert.deepStrictEqual(r, ['仅一条']);
	});

	test('returns undefined when no json', () => {
		assert.strictEqual(tryParseVerifierMatchedSuccessCriteria('无 JSON'), undefined);
	});
});
