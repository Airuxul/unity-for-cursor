import * as assert from 'assert';
import { bareSymbolName } from '../../analysis/csharpSymbols';

suite('csharpSymbols.bareSymbolName', () => {
	test('strips a parameter list from a method symbol name', () => {
		assert.strictEqual(bareSymbolName('Awake()'), 'Awake');
		assert.strictEqual(bareSymbolName('SetRaiseOffset(float offset)'), 'SetRaiseOffset');
	});

	test('returns the name unchanged when there is no parameter list', () => {
		assert.strictEqual(bareSymbolName('Awake'), 'Awake');
	});
});
