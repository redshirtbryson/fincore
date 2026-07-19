// Presentation-money tests: the rules that keep Firefly's long-precision strings
// out of human-facing messages, without ever hiding or fabricating a value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usd, usd0, tidyMoney } from '../lib/format.js';

test('usd renders 2-decimal money with separators from numbers and raw strings', () => {
  assert.equal(usd(1499.9), '$1,499.90');
  assert.equal(usd('150.000000000000'), '$150.00');
  assert.equal(usd('-27056.70'), '-$27,056.70');
  assert.equal(usd(0), '$0.00');
  // Never hide a value, never fabricate one.
  assert.equal(usd('garbage'), 'garbage');
  assert.equal(usd(null), 'n/a');
  assert.equal(usd(''), 'n/a');
});

test('usd0 renders whole dollars for dense lines', () => {
  assert.equal(usd0(27056.7), '$27,057');
  assert.equal(usd0('-91238.97'), '-$91,239');
  assert.equal(usd0(null), 'n/a');
});

test('tidyMoney repairs long-precision dollars in stored text and leaves prose alone', () => {
  assert.equal(tidyMoney('pair $150.000000000000 (tx 931/1134)'), 'pair $150.00 (tx 931/1134)');
  assert.equal(tidyMoney('$1,234.560000 and $50.00 stay right'), '$1,234.56 and $50.00 stay right');
  assert.equal(tidyMoney('version 1.2.3 and 99.9% untouched'), 'version 1.2.3 and 99.9% untouched');
});
