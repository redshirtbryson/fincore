// Money-grade tests for the net worth engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNetWorth } from '../lib/networth.js';

const checking = { id: '1', name: 'Checking', type: 'asset', currentBalance: 5000, currencyCode: 'USD' };
const card = { id: '2', name: 'Card', type: 'liability', currentBalance: -1200, currencyCode: 'USD' };

test('sums assets, negative liabilities, and positions', () => {
  const r = computeNetWorth({
    accounts: [checking, card],
    positions: [{ symbol: 'SCHD', marketValue: 10000 }],
  });
  assert.equal(r.netWorth, 5000 - 1200 + 10000);
  assert.equal(r.assetsTotal, 5000);
  assert.equal(r.liabilitiesTotal, -1200);
  assert.equal(r.positionsTotal, 10000);
  assert.equal(r.flags.length, 0);
});

test('respects include_net_worth and active flags', () => {
  const r = computeNetWorth({
    accounts: [
      checking,
      { ...checking, id: '3', name: 'Excluded', includeNetWorth: false, currentBalance: 999999 },
      { ...checking, id: '4', name: 'Closed', active: false, currentBalance: 888888 },
    ],
  });
  assert.equal(r.netWorth, 5000);
  assert.equal(r.counted, 1);
});

test('a missing balance yields null net worth plus a flag, never a partial sum presented as whole', () => {
  const r = computeNetWorth({ accounts: [checking, { ...card, currentBalance: undefined }] });
  assert.equal(r.netWorth, null);
  assert.ok(r.flags.some((f) => f.includes('Card')));
});

test('a non-USD account yields null net worth plus a flag (USD-only per SPEC section 20)', () => {
  const r = computeNetWorth({ accounts: [checking, { ...checking, id: '5', name: 'Euro', currencyCode: 'EUR' }] });
  assert.equal(r.netWorth, null);
  assert.ok(r.flags.some((f) => f.includes('EUR')));
});

test('a positive liability balance is flagged but summed as reported, not silently inverted', () => {
  const r = computeNetWorth({ accounts: [checking, { ...card, currentBalance: 1200 }] });
  assert.equal(r.netWorth, 5000 + 1200);
  assert.ok(r.flags.some((f) => f.includes('positive balance')));
});

test('a position without market value yields null net worth plus a flag', () => {
  const r = computeNetWorth({ accounts: [checking], positions: [{ symbol: 'MYST' }] });
  assert.equal(r.netWorth, null);
  assert.ok(r.flags.some((f) => f.includes('MYST')));
});

test('nothing to sum is a flagged null, not zero', () => {
  const r = computeNetWorth({ accounts: [], positions: [] });
  assert.equal(r.netWorth, null);
  assert.ok(r.flags.length > 0);
});
