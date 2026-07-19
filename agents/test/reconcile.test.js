// Money-grade tests for the reconciliation engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileNetWorth, reconcilePaystubDeposits } from '../lib/reconcile.js';

// reconcileNetWorth

test('agreement within tolerance passes with zero drift', () => {
  const r = reconcileNetWorth({ computed: 100000, reference: 100000 });
  assert.equal(r.ok, true);
  assert.equal(r.driftDollars, 0);
  assert.equal(r.flags.length, 0);
});

test('a null computed input is flagged, not passed (cannot reconcile is a state)', () => {
  const r = reconcileNetWorth({ computed: null, reference: 100000 });
  assert.equal(r.ok, null);
  assert.equal(r.driftDollars, null);
  assert.ok(r.flags.some((f) => f.includes('computed')));
});

test('a null reference input is flagged, not passed', () => {
  const r = reconcileNetWorth({ computed: 100000, reference: null });
  assert.equal(r.ok, null);
  assert.ok(r.flags.some((f) => f.includes('reference')));
});

test('a non-finite computed input is flagged, not passed', () => {
  const r = reconcileNetWorth({ computed: Infinity, reference: 100000 });
  assert.equal(r.ok, null);
  assert.ok(r.flags.some((f) => f.includes('computed')));
});

test('drift of exactly one dollar with tolerance one passes at the cent boundary', () => {
  const r = reconcileNetWorth({ computed: 100001, reference: 100000, toleranceDollars: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.driftDollars, 1);
  assert.equal(r.flags.length, 0);
});

test('drift of one dollar and one cent fails just past the boundary', () => {
  const r = reconcileNetWorth({ computed: 100001.01, reference: 100000, toleranceDollars: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.driftDollars, 1.01);
  assert.ok(r.flags.some((f) => f.includes('drift')));
});

test('drift sign is preserved: computed below reference reads negative', () => {
  const r = reconcileNetWorth({ computed: 99000, reference: 100000, toleranceDollars: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.driftDollars, -1000);
});

test('cent rounding avoids a spurious drift from floating-point noise', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in floating point; on cents it is exactly 30.
  const r = reconcileNetWorth({ computed: 0.1 + 0.2, reference: 0.3, toleranceDollars: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.driftDollars, 0);
});

// reconcilePaystubDeposits

const template = { source: 'Blenko W-2', net_pay: 2000, pay_cadence: 'biweekly' };

test('a deposit exactly at net pay matches', () => {
  const r = reconcilePaystubDeposits({
    template,
    deposits: [{ amount: 2000, date: '2026-07-01' }],
  });
  assert.equal(r.matched.length, 1);
  assert.equal(r.drifted.length, 0);
  assert.equal(r.flags.length, 0);
});

test('a deposit just inside the percent band matches (net 2000, 1% = 20 governs over 5 floor)', () => {
  const r = reconcilePaystubDeposits({
    template,
    deposits: [{ amount: 2019, date: '2026-07-01' }],
  });
  assert.equal(r.matched.length, 1);
  assert.equal(r.drifted.length, 0);
});

test('a deposit just outside the percent band drifts with signed delta and percent', () => {
  const r = reconcilePaystubDeposits({
    template,
    deposits: [{ amount: 2021, date: '2026-07-01' }],
  });
  assert.equal(r.matched.length, 0);
  assert.equal(r.drifted.length, 1);
  assert.equal(r.drifted[0].deltaDollars, 21);
  assert.ok(Math.abs(r.drifted[0].deltaPercent - 1.05) < 1e-9);
  assert.ok(r.flags.some((f) => f.includes('drifted')));
});

test('for a small paycheck the dollar floor governs (net 300, 1% = 3 < 5 floor)', () => {
  const small = { source: 'Side gig', net_pay: 300, pay_cadence: 'monthly' };
  // 4 dollars off is inside the 5 dollar floor even though it exceeds 1% (3).
  const matches = reconcilePaystubDeposits({ template: small, deposits: [{ amount: 304, date: '2026-07-01' }] });
  assert.equal(matches.matched.length, 1);
  assert.equal(matches.drifted.length, 0);
  // 6 dollars off exceeds the 5 dollar floor and drifts.
  const drifts = reconcilePaystubDeposits({ template: small, deposits: [{ amount: 306, date: '2026-07-01' }] });
  assert.equal(drifts.drifted.length, 1);
  assert.equal(drifts.drifted[0].deltaDollars, 6);
});

test('a null net pay makes everything unverifiable with one flag and empty results', () => {
  const r = reconcilePaystubDeposits({
    template: { source: 'Blenko W-2', net_pay: null, pay_cadence: 'biweekly' },
    deposits: [{ amount: 2000, date: '2026-07-01' }],
  });
  assert.equal(r.matched.length, 0);
  assert.equal(r.drifted.length, 0);
  assert.equal(r.flags.length, 1);
  assert.ok(r.flags[0].includes('net pay'));
});

test('a string amount from Firefly parses and matches', () => {
  const r = reconcilePaystubDeposits({
    template,
    deposits: [{ amount: '2000.00', date: '2026-07-01' }],
  });
  assert.equal(r.matched.length, 1);
  assert.equal(r.drifted.length, 0);
});

test('an unparseable deposit amount goes to flags, not to a bogus comparison', () => {
  const r = reconcilePaystubDeposits({
    template,
    deposits: [{ amount: 'n/a', date: '2026-07-01' }],
  });
  assert.equal(r.matched.length, 0);
  assert.equal(r.drifted.length, 0);
  assert.ok(r.flags.some((f) => f.includes('unparseable')));
});

test('a zero net pay template yields null deltaPercent without dividing by zero', () => {
  const r = reconcilePaystubDeposits({
    template: { source: 'Zeroed', net_pay: 0, pay_cadence: 'monthly' },
    deposits: [{ amount: 50, date: '2026-07-01' }],
  });
  // 50 off exceeds the 5 dollar floor (percent band is 0), so it drifts.
  assert.equal(r.drifted.length, 1);
  assert.equal(r.drifted[0].deltaPercent, null);
});

test('split net pay: same-day deposits are summed before comparing (Blenko $930.08 + $150.00)', () => {
  const template = { source: 'Blenko', net_pay: 1080.08 };
  const good = reconcilePaystubDeposits({
    template,
    deposits: [
      { date: '2026-07-16', amount: '930.08' },
      { date: '2026-07-16', amount: '150.00' },
    ],
  });
  assert.equal(good.matched.length, 2);
  assert.equal(good.drifted.length, 0);
  assert.equal(good.flags.length, 0);

  // A short split must still drift — both legs reported with the day-total delta.
  const short = reconcilePaystubDeposits({
    template,
    deposits: [
      { date: '2026-07-23', amount: '930.08' },
      { date: '2026-07-23', amount: '100.00' },
    ],
  });
  assert.equal(short.matched.length, 0);
  assert.equal(short.drifted.length, 2);
  assert.equal(short.drifted[0].deltaDollars, -50);
});
