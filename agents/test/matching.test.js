// Money-grade tests for transfer and reimbursement matching (SPEC section 11).
// These assert the DEFINITION, not just behavior: a transfer is one own-account
// withdrawal paired to one deposit into a different own account within the window;
// a reimbursement is a deposit on or after the outlay netting it back. The load-
// bearing rules are uniqueness (never guess between two candidates), the one-day
// posting-skew allowance, cents-based equality, and flag-do-not-guess on bad input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount,
  centsEqual,
  matchTransfers,
  matchReimbursements,
} from '../lib/matching.js';

test('parseAmount takes number or string dollars, rejects negative and junk', () => {
  assert.equal(parseAmount(1499.99), 1499.99);
  assert.equal(parseAmount('1499.99'), 1499.99);
  assert.equal(parseAmount('$1,499.99'), 1499.99);
  assert.equal(parseAmount('  $ 2,000.00 '), 2000);
  assert.equal(parseAmount(0), 0);
  // Magnitudes only: a negative value is not a valid magnitude here.
  assert.equal(parseAmount(-5), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(NaN), null);
  assert.equal(parseAmount(Infinity), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
});

test('centsEqual compares on rounded cents so float traps do not break equality', () => {
  // The classic 0.1 + 0.2 = 0.30000000000000004 trap must still read equal.
  assert.equal(centsEqual(0.1 + 0.2, 0.3), true);
  // 1499.99 assembled from parts must equal the literal to the cent.
  assert.equal(centsEqual(1400 + 99.99, 1499.99), true);
  assert.equal(centsEqual(100, 100.01), false);
  // Tolerance widens the allowed gap, in dollars.
  assert.equal(centsEqual(100, 100.01, 0.01), true);
  assert.equal(centsEqual(100, 100.02, 0.01), false);
  assert.equal(centsEqual(100, 99.99, 0.01), true);
});

test('exact unique transfer pair matches with the right dateDelta', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: '500.00', date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: '500.00', date: '2026-07-02', account: 'Savings', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].kind, 'transfer');
  assert.equal(r.matches[0].withdrawal.tx_id, 'w1');
  assert.equal(r.matches[0].deposit.tx_id, 'd1');
  assert.equal(r.matches[0].dateDelta, 1);
  assert.equal(r.ambiguous.length, 0);
  assert.equal(r.unmatched.length, 0);
  assert.equal(r.flags.length, 0);
});

test('a deposit one day before the withdrawal is accepted as posting skew', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 750, date: '2026-07-10', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 750, date: '2026-07-09', account: 'Savings', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].dateDelta, -1);
});

test('a deposit two days early is outside the skew allowance and does not match', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 750, date: '2026-07-10', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 750, date: '2026-07-08', account: 'Savings', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 0);
  assert.equal(r.ambiguous.length, 0);
  assert.equal(r.unmatched.length, 2); // both fall through untouched
});

test('a deposit past the forward window is rejected', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 100, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 100, date: '2026-07-05', account: 'Savings', tags: [] },
  ];
  // Default window is 3 days forward; 4 days out is too far.
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatched.length, 2);
});

test('a same-account withdrawal and deposit is a correction, not a transfer', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 200, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 200, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 0);
  assert.equal(r.ambiguous.length, 0);
  assert.equal(r.unmatched.length, 2);
});

test('two same-amount transfers on the same day all go to ambiguous, never guessed', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 300, date: '2026-07-01', account: 'Checking', tags: [] },
    { tx_id: 'w2', amount: 300, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 300, date: '2026-07-01', account: 'Savings', tags: [] },
    { tx_id: 'd2', amount: 300, date: '2026-07-01', account: 'Savings', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 0); // cannot tell w1->d1 from w1->d2
  assert.equal(r.ambiguous.length, 2);
  for (const a of r.ambiguous) {
    assert.equal(a.candidates.length, 2);
    assert.ok(typeof a.reason === 'string' && a.reason.length > 0);
  }
  // No deposit is reported unmatched: both are in play as candidates.
  assert.equal(r.unmatched.length, 0);
});

test('an already transfer-matched side is excluded and passes through untouched', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 500, date: '2026-07-01', account: 'Checking', tags: ['transfer-match:abc'] },
    { tx_id: 'w2', amount: 500, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 500, date: '2026-07-01', account: 'Savings', tags: [] },
  ];
  // w1 is already matched, so it does not contest d1; w2 pairs cleanly with d1.
  const r = matchTransfers(withdrawals, deposits);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].withdrawal.tx_id, 'w2');
  assert.equal(r.ambiguous.length, 0);
  // w1 is returned untouched among the unmatched.
  assert.ok(r.unmatched.some((row) => row.tx_id === 'w1'));
});

test('amount tolerance lets near-equal transfers match; zero tolerance does not', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 1499.99, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 1500.0, date: '2026-07-01', account: 'Savings', tags: [] },
  ];
  // Exact default: one cent apart does not match.
  assert.equal(matchTransfers(withdrawals, deposits).matches.length, 0);
  // With a one-cent tolerance it matches.
  const r = matchTransfers(withdrawals, deposits, { amountTolerance: 0.01 });
  assert.equal(r.matches.length, 1);
});

test('an unparseable amount lands in flags and is excluded, never guessed into a match', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 'not-a-number', date: '2026-07-01', account: 'Checking', tags: [] },
    { tx_id: 'w2', amount: 500, date: '2026-07-01', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 500, date: '2026-07-01', account: 'Savings', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.ok(r.flags.some((f) => f.includes('w1') && f.includes('amount')));
  // w1 never reaches matching; w2 still pairs with d1.
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].withdrawal.tx_id, 'w2');
  assert.ok(!r.unmatched.some((row) => row.tx_id === 'w1')); // excluded, not unmatched
});

test('an unparseable date lands in flags and is excluded', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 500, date: '2026-13-40', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 500, date: '2026-07-01', account: 'Savings', tags: [] },
  ];
  const r = matchTransfers(withdrawals, deposits);
  assert.ok(r.flags.some((f) => f.includes('w1') && f.includes('date')));
  assert.equal(r.matches.length, 0);
});

test('reimbursement matches a deposit on or after the outlay within the window', () => {
  const outlays = [
    { tx_id: 'w1', amount: 120, date: '2026-05-01', account: 'Checking', tags: ['reimbursable'] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 120, date: '2026-05-20', account: 'Checking', tags: [] },
  ];
  const r = matchReimbursements(outlays, deposits);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].kind, 'reimbursement');
  assert.equal(r.matches[0].dateDelta, 19);
});

test('a repayment dated before the outlay cannot match it', () => {
  const outlays = [
    { tx_id: 'w1', amount: 120, date: '2026-05-10', account: 'Checking', tags: ['reimbursable'] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 120, date: '2026-05-09', account: 'Checking', tags: [] },
  ];
  const r = matchReimbursements(outlays, deposits);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatched.length, 2);
});

test('a repayment on the same day as the outlay is allowed', () => {
  const outlays = [
    { tx_id: 'w1', amount: 80, date: '2026-05-10', account: 'Checking', tags: ['reimbursable'] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 80, date: '2026-05-10', account: 'Checking', tags: [] },
  ];
  const r = matchReimbursements(outlays, deposits);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].dateDelta, 0);
});

test('a repayment past the reimbursement window is rejected', () => {
  const outlays = [
    { tx_id: 'w1', amount: 80, date: '2026-01-01', account: 'Checking', tags: ['reimbursable'] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 80, date: '2026-04-01', account: 'Checking', tags: [] },
  ];
  // 90 days out exceeds the 60-day default window.
  const r = matchReimbursements(outlays, deposits);
  assert.equal(r.matches.length, 0);
});

test('multiple equal repayment candidates make the outlay ambiguous, never guessed', () => {
  const outlays = [
    { tx_id: 'w1', amount: 200, date: '2026-05-01', account: 'Checking', tags: ['reimbursable'] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 200, date: '2026-05-05', account: 'Checking', tags: [] },
    { tx_id: 'd2', amount: 200, date: '2026-05-10', account: 'Checking', tags: [] },
  ];
  const r = matchReimbursements(outlays, deposits);
  assert.equal(r.matches.length, 0);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].candidates.length, 2);
  assert.equal(r.ambiguous[0].item.tx_id, 'w1');
});

test('an outlay already tagged reimbursed passes through untouched', () => {
  const outlays = [
    { tx_id: 'w1', amount: 200, date: '2026-05-01', account: 'Checking', tags: ['reimbursable', 'reimbursed'] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 200, date: '2026-05-05', account: 'Checking', tags: [] },
  ];
  const r = matchReimbursements(outlays, deposits);
  assert.equal(r.matches.length, 0);
  assert.ok(r.unmatched.some((row) => row.tx_id === 'w1'));
  assert.ok(r.unmatched.some((row) => row.tx_id === 'd1'));
});

test('empty inputs return empty shapes, not errors', () => {
  const t = matchTransfers([], []);
  assert.deepEqual(t, { matches: [], ambiguous: [], unmatched: [], flags: [] });
  const r = matchReimbursements([], []);
  assert.deepEqual(r, { matches: [], ambiguous: [], unmatched: [], flags: [] });
  // Missing arrays are tolerated as empty.
  const t2 = matchTransfers(undefined, undefined);
  assert.deepEqual(t2, { matches: [], ambiguous: [], unmatched: [], flags: [] });
});

test('matching is deterministic: same rows in any order give the same matches', () => {
  const withdrawals = [
    { tx_id: 'w1', amount: 500, date: '2026-07-01', account: 'Checking', tags: [] },
    { tx_id: 'w2', amount: 900, date: '2026-07-03', account: 'Checking', tags: [] },
  ];
  const deposits = [
    { tx_id: 'd1', amount: 500, date: '2026-07-02', account: 'Savings', tags: [] },
    { tx_id: 'd2', amount: 900, date: '2026-07-04', account: 'Brokerage', tags: [] },
  ];
  const forward = matchTransfers(withdrawals, deposits);
  const reversed = matchTransfers([...withdrawals].reverse(), [...deposits].reverse());

  const key = (m) => `${m.withdrawal.tx_id}->${m.deposit.tx_id}:${m.dateDelta}`;
  assert.deepEqual(forward.matches.map(key).sort(), reversed.matches.map(key).sort());
  assert.equal(forward.matches.length, 2);
});
