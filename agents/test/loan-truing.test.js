// Money-grade tests for loan balance truing (baseline audit 2026-07-18). The
// load-bearing rules: the truing formula lands the computed balance exactly on the
// feed; equality is judged to the cent; and every unsafe case (unparseable input,
// sign flip, drift beyond the sanity cap) FLAGS instead of writing. A wrong opening
// balance on a $91k mortgage is worse than no write at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLoanTruing } from '../lib/loan-truing.js';

test('exact agreement (to the cent) is a noop', () => {
  assert.deepEqual(
    computeLoanTruing({ feedBalance: -91238.97, computedBalance: -91238.97, opening: -91238.97 }),
    { action: 'noop' }
  );
  // Sub-cent float noise must not trigger a write.
  assert.deepEqual(
    computeLoanTruing({ feedBalance: -91238.97, computedBalance: -91238.972, opening: -91238.97 }),
    { action: 'noop' }
  );
});

test('normal drift trues the opening so computed lands on the feed', () => {
  // The real case from the audit: mortgage computed -91,273.11, feed -91,238.97
  // (the $34.14 escrow line). opening_new = opening + (feed - computed).
  const r = computeLoanTruing({ feedBalance: -91238.97, computedBalance: -91273.11, opening: -91238.97 });
  assert.equal(r.action, 'true');
  assert.equal(r.drift, 34.14);
  assert.equal(r.openingNew, -91204.83);
  // A monthly auto-loan payment: feed dropped by the principal portion.
  const p = computeLoanTruing({ feedBalance: -13971.31, computedBalance: -14501.51, opening: -14501.51 });
  assert.equal(p.action, 'true');
  assert.equal(p.drift, 530.2);
  assert.equal(p.openingNew, -13971.31);
});

test('string inputs are accepted (feed balances arrive as strings)', () => {
  const r = computeLoanTruing({ feedBalance: '-14,501.51', computedBalance: '-14501.51', opening: '-14501.51' });
  assert.deepEqual(r, { action: 'noop' });
});

test('drift beyond the sanity cap flags, never writes', () => {
  const r = computeLoanTruing({ feedBalance: 0, computedBalance: -14501.51, opening: -14501.51, capDollars: 2500 });
  // A zeroed feed balance on an active loan is a glitch, not a payoff to assume.
  assert.equal(r.action, 'flag');
  assert.match(r.reason, /cap|sign/);
});

test('a liability flipping to a positive feed balance flags', () => {
  const r = computeLoanTruing({ feedBalance: 120.5, computedBalance: -400, opening: -400, capDollars: 5000 });
  assert.equal(r.action, 'flag');
  assert.match(r.reason, /sign/);
});

test('unparseable or missing inputs flag, never coerce to zero', () => {
  for (const bad of [
    { feedBalance: null, computedBalance: -1, opening: -1 },
    { feedBalance: 'abc', computedBalance: -1, opening: -1 },
    { feedBalance: -1, computedBalance: undefined, opening: -1 },
    { feedBalance: -1, computedBalance: -1, opening: NaN },
  ]) {
    assert.equal(computeLoanTruing(bad).action, 'flag', JSON.stringify(bad));
  }
});

test('an invalid cap flags rather than defaulting to unlimited', () => {
  assert.equal(computeLoanTruing({ feedBalance: -1, computedBalance: -2, opening: -2, capDollars: 0 }).action, 'flag');
  assert.equal(computeLoanTruing({ feedBalance: -1, computedBalance: -2, opening: -2, capDollars: -5 }).action, 'flag');
});
