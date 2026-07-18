// Money-grade tests for the influx allocation waterfall (playbook v2, 2026-07-18).
// These assert the DEFINITION of the blessed split, not just incidental behavior:
// tax -> buffer -> strike, the influx-index boost table, the ABSOLUTE post-checkpoint
// tax rule, the Roth-window queue jump gated on Discover being dead, penny-exact
// summation, and every flag-do-not-guess path. Amounts are checked to the cent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAllocation, avalanche } from '../lib/allocation.js';

// Sum a tranche list in cents to dodge float drift when asserting the total.
const sumCents = (tranches) => tranches.reduce((a, t) => a + Math.round(t.amount * 100), 0);
// Find one tranche by destination (exact match).
const byDest = (tranches, dest) => tranches.find((t) => t.destination === dest);

// A full, valid Discover-alive scenario used as the base for most cases. Callers
// override the pieces they are testing.
function base(overrides = {}) {
  return {
    deposit: { amount: 9400, date: '2026-08-01' },
    influxIndex: 1,
    bufferBalance: 0,
    bufferTier1Target: 6000,
    taxAccruedTotal: 0,
    taxHeld: 0,
    checkpointDate: '2027-01-15',
    roth: { funded: 0, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [{ name: 'Discover', balance: 27057, apr: 28.49 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The influx boost table: 15/50/35, 15/60/25, 15/70/15.
// ---------------------------------------------------------------------------

test('influx #1 splits 15% tax / 35% buffer / 50% strike on $9,400 (1410/3290/4700)', () => {
  const r = computeAllocation(base({ influxIndex: 1 }));
  assert.equal(r.flags.length, 0);
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)').amount, 1410);
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)').amount, 3290); // 35%
  assert.equal(byDest(r.tranches, 'Discover').amount, 4700); // 50% remainder
  assert.equal(sumCents(r.tranches), 940000);
});

test('influx #2 splits 15% tax / 25% buffer / 60% strike (percentages sum to 100)', () => {
  // Playbook: #2 = 15% tax, 60% strike, 25% buffer. On $9,400: 1410 / 2350 / 5640.
  const r = computeAllocation(base({ influxIndex: 2 }));
  assert.equal(r.flags.length, 0);
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)').amount, 1410); // 15%
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)').amount, 2350); // 25%
  assert.equal(byDest(r.tranches, 'Discover').amount, 5640); // 60% remainder
  assert.equal(1410 + 2350 + 5640, 9400); // the split is exhaustive
  assert.equal(sumCents(r.tranches), 940000);
});

test('influx #3+ splits 15% tax / 15% buffer / 70% strike', () => {
  // On $9,400: 1410 / 1410 / 6580.
  const r3 = computeAllocation(base({ influxIndex: 3 }));
  assert.equal(byDest(r3.tranches, 'Huntington Savings (tax)').amount, 1410);
  assert.equal(byDest(r3.tranches, 'CNB - Joint (buffer)').amount, 1410); // 15%
  assert.equal(byDest(r3.tranches, 'Discover').amount, 6580); // 70%
  assert.equal(sumCents(r3.tranches), 940000);
  // #5 uses the same 15% floor as #3.
  const r5 = computeAllocation(base({ influxIndex: 5 }));
  assert.equal(byDest(r5.tranches, 'CNB - Joint (buffer)').amount, 1410);
});

// ---------------------------------------------------------------------------
// Boost skipped when the buffer is already at/over tier 1.
// ---------------------------------------------------------------------------

test('boost is skipped once the buffer is full: influx #1 uses base 15%, labeled reservoir', () => {
  // Buffer already at $6,000 target, so no 35% boost; the 15% base rate flows to the
  // reservoir label, not the buffer label.
  const r = computeAllocation(base({ influxIndex: 1, bufferBalance: 6000 }));
  assert.equal(r.flags.length, 0);
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)'), undefined); // no buffer tranche
  assert.equal(byDest(r.tranches, 'CNB - Joint (reservoir)').amount, 1410); // 15%
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)').amount, 1410);
  assert.equal(byDest(r.tranches, 'Discover').amount, 6580); // remainder to strike
  assert.equal(sumCents(r.tranches), 940000);
});

test('buffer just below tier 1 still gets the boost and the buffer label', () => {
  const r = computeAllocation(base({ influxIndex: 1, bufferBalance: 5999.99 }));
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)').amount, 3290); // 35% boost
  assert.equal(byDest(r.tranches, 'CNB - Joint (reservoir)'), undefined);
});

// ---------------------------------------------------------------------------
// Pre- vs post-checkpoint tax behavior.
// ---------------------------------------------------------------------------

test('pre-checkpoint tax is a flat 15% accrual', () => {
  const r = computeAllocation(base({ deposit: { amount: 9400, date: '2026-12-31' } }));
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)').amount, 1410);
});

test('post-checkpoint with a deficit consumes the deposit first (deficit > deposit)', () => {
  // Deficit = 30% x 2026 received - held. Accrued 20,000, held 400 -> 19,600 deficit,
  // far more than the $9,400 deposit, so the ENTIRE deposit is tax; buffer and strike
  // get nothing, and that fact is flagged.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-01-20' },
    taxAccruedTotal: 20000,
    taxHeld: 400,
  }));
  assert.equal(r.tranches.length, 1);
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)').amount, 9400);
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)'), undefined);
  assert.equal(byDest(r.tranches, 'Discover'), undefined);
  assert.ok(r.flags.some((f) => f.includes('consumed the entire deposit')));
  assert.equal(sumCents(r.tranches), 940000);
});

test('post-checkpoint with a partial deficit pays the deficit, then buffer+strike from the rest', () => {
  // Deficit = 6,000. Tax tranche = min(9400, 6000) = 6000. Remaining 3400 splits:
  // buffer 35% of the ORIGINAL 9400 = 3290 (capped at 3400), strike = 110.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-01-20' },
    taxAccruedTotal: 6400,
    taxHeld: 400,
  }));
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)').amount, 6000);
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)').amount, 3290);
  assert.equal(byDest(r.tranches, 'Discover').amount, 110);
  assert.equal(sumCents(r.tranches), 940000);
});

test('post-checkpoint with ZERO deficit sets tax to $0 and flags the unconfigured 2027 rate', () => {
  // 2026 obligation fully funded (accrued == held). No further 15% accrues; the deposit
  // is treated as 2027 income whose rate is not yet configured. Tax = $0, the rest
  // splits normally, and the 2027 flag is raised.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    taxAccruedTotal: 5000,
    taxHeld: 5000,
  }));
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)'), undefined); // zero tranche omitted
  // Full 9400 flows to buffer(35%=3290) + strike(6110).
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)').amount, 3290);
  assert.equal(byDest(r.tranches, 'Discover').amount, 6110);
  assert.ok(r.flags.some((f) => f.includes('2027 accrual rate not yet configured')));
  assert.equal(sumCents(r.tranches), 940000);
});

// ---------------------------------------------------------------------------
// The Roth window queue jump.
// ---------------------------------------------------------------------------

test('Roth window redirect: Discover dead -> Roth funded up to target, overflow to Apple', () => {
  // In-window (2027-02-01), Discover balance 0 (dead), Apple/Affirm alive. Roth funded
  // 0 of 7500. Post-checkpoint with a fully-funded 2026 obligation, so tax = $0 (2027
  // rate unconfigured). Full buffer -> 15% reservoir = 1410; strike remainder = 7990.
  // Roth room is 7500, less than the 7990 strike, so the Roth fills to 7500 and the
  // 490 overflow cascades to Apple.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    influxIndex: 5,
    bufferBalance: 6000,
    taxAccruedTotal: 5000, taxHeld: 5000, // zero deficit so tax path is clean; 2027 flag expected
    roth: { funded: 0, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [
      { name: 'Discover', balance: 0, apr: 28.49 },
      { name: 'Apple', balance: 5000, apr: 24.99 },
      { name: 'Affirm', balance: 4486, apr: 15 },
    ],
  }));
  // Tax $0 (fully funded), buffer 15% reservoir = 1410, strike 7990: Roth 7500 + Apple 490.
  assert.equal(byDest(r.tranches, 'Roth IRA 2026').amount, 7500);
  assert.equal(byDest(r.tranches, 'Apple').amount, 490);
  assert.equal(sumCents(r.tranches), 940000);
});

test('Roth overflow past the target cascades to the next avalanche debt (Apple)', () => {
  // Roth already funded 5000 of 7500 -> room 2500. Tax $0, buffer 15% reservoir = 1410,
  // strike 7990: Roth takes 2500, the remaining 5490 goes to Apple, which has only 5000
  // of balance, so Apple takes 5000 and the last 490 cascades to Affirm.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    influxIndex: 5,
    bufferBalance: 6000,
    taxAccruedTotal: 5000, taxHeld: 5000,
    roth: { funded: 5000, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [
      { name: 'Discover', balance: 0, apr: 28.49 },
      { name: 'Apple', balance: 5000, apr: 24.99 },
      { name: 'Affirm', balance: 4486, apr: 15 },
    ],
  }));
  assert.equal(byDest(r.tranches, 'Roth IRA 2026').amount, 2500);
  assert.equal(byDest(r.tranches, 'Apple').amount, 5000); // capped at balance
  assert.equal(byDest(r.tranches, 'Affirm').amount, 490); // overflow past Apple
  assert.equal(sumCents(r.tranches), 940000);
});

test('Roth is NOT funded while Discover is alive, even inside the window', () => {
  // Discover alive (balance > 0) beats the Roth always. Strike goes to Discover.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    influxIndex: 5,
    bufferBalance: 6000,
    taxAccruedTotal: 5000, taxHeld: 5000,
    roth: { funded: 0, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [
      { name: 'Discover', balance: 12000, apr: 28.49 },
      { name: 'Apple', balance: 5000, apr: 24.99 },
    ],
  }));
  assert.equal(byDest(r.tranches, 'Roth IRA 2026'), undefined);
  assert.equal(byDest(r.tranches, 'Discover').amount, 7990); // whole strike (tax $0) to Discover
  assert.equal(sumCents(r.tranches), 940000);
});

test('any live debt at/above the 28% floor counts as a Discover-class blocker for the Roth', () => {
  // No debt literally named Discover, but a 29% card is alive: the Roth still yields.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    influxIndex: 5,
    bufferBalance: 6000,
    taxAccruedTotal: 5000, taxHeld: 5000,
    roth: { funded: 0, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [{ name: 'StoreCard', balance: 3000, apr: 29.99 }],
  }));
  assert.equal(byDest(r.tranches, 'Roth IRA 2026'), undefined);
  assert.equal(byDest(r.tranches, 'StoreCard').amount, 3000); // pays it off
  // Tax $0, buffer 15% reservoir = 1410, strike 7990. Overflow past the paid-off card
  // (7990 - 3000 = 4990) also goes to reservoir; both reservoir lines total 6400.
  const reservoirTotal = r.tranches
    .filter((t) => t.destination === 'CNB - Joint (reservoir)')
    .reduce((a, t) => a + t.amount, 0);
  assert.equal(reservoirTotal, 6400); // 1410 buffer-reservoir + 4990 strike-overflow
  assert.equal(sumCents(r.tranches), 940000);
});

test('Roth is skipped outside the [windowStart, deadline] window', () => {
  // Discover dead but the date is before windowStart -> no Roth redirect; strike goes to
  // the next live debt.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2026-12-01' }, // before 2027-01-15 window
    influxIndex: 5,
    bufferBalance: 6000,
    roth: { funded: 0, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [
      { name: 'Discover', balance: 0, apr: 28.49 },
      { name: 'Apple', balance: 20000, apr: 24.99 },
    ],
  }));
  assert.equal(byDest(r.tranches, 'Roth IRA 2026'), undefined);
  assert.equal(byDest(r.tranches, 'Apple').amount, 6580);
});

test('Roth already funded to target does not redirect', () => {
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    influxIndex: 5,
    bufferBalance: 6000,
    taxAccruedTotal: 5000, taxHeld: 5000,
    roth: { funded: 7500, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [
      { name: 'Discover', balance: 0, apr: 28.49 },
      { name: 'Apple', balance: 20000, apr: 24.99 },
    ],
  }));
  assert.equal(byDest(r.tranches, 'Roth IRA 2026'), undefined);
  assert.equal(byDest(r.tranches, 'Apple').amount, 7990); // tax $0 post-checkpoint
});

// ---------------------------------------------------------------------------
// All goals done -> reservoir. Avalanche ordering.
// ---------------------------------------------------------------------------

test('all debts dead and Roth funded/out of window: strike flows to the reservoir', () => {
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-06-01' }, // past the Roth deadline
    influxIndex: 5,
    bufferBalance: 6000, // buffer full -> 15% reservoir
    taxAccruedTotal: 5000, taxHeld: 5000, // 2026 funded
    roth: { funded: 7500, target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
    debts: [],
  }));
  // Tax $0, buffer 15% reservoir = 1410, strike 8000 -> reservoir. Two reservoir
  // tranches collapse in the output only if same destination; they are separate lines
  // here (buffer-labeled reservoir vs strike-overflow reservoir) but both go to CNB.
  const reservoirTotal = r.tranches
    .filter((t) => t.destination === 'CNB - Joint (reservoir)')
    .reduce((a, t) => a + t.amount, 0);
  assert.equal(reservoirTotal, 9400);
  assert.equal(byDest(r.tranches, 'Huntington Savings (tax)'), undefined);
  assert.equal(sumCents(r.tranches), 940000);
});

test('avalanche sorts live debts by APR desc and drops dead ones', () => {
  const sorted = avalanche([
    { name: 'Affirm', balance: 4486, apr: 15 },
    { name: 'Discover', balance: 27057, apr: 28.49 },
    { name: 'PaidOff', balance: 0, apr: 99 }, // dead: dropped despite highest APR
    { name: 'Apple', balance: 5000, apr: 24.99 },
  ]);
  assert.deepEqual(sorted.map((d) => d.name), ['Discover', 'Apple', 'Affirm']);
});

test('avalanche breaks APR ties by name for determinism', () => {
  const sorted = avalanche([
    { name: 'Zeta', balance: 100, apr: 20 },
    { name: 'Alpha', balance: 100, apr: 20 },
  ]);
  assert.deepEqual(sorted.map((d) => d.name), ['Alpha', 'Zeta']);
});

// ---------------------------------------------------------------------------
// Penny discipline on awkward amounts.
// ---------------------------------------------------------------------------

test('penny-exact summation on an awkward amount ($9,401.01)', () => {
  const r = computeAllocation(base({
    deposit: { amount: 9401.01, date: '2026-08-01' },
    influxIndex: 1,
  }));
  // Whatever the rounding, the tranches must sum to exactly $9,401.01.
  assert.equal(sumCents(r.tranches), 940101);
  // And no tranche is fractional-cent.
  for (const t of r.tranches) {
    assert.equal(Math.round(t.amount * 100), t.amount * 100);
  }
});

test('penny discipline holds on a string amount with a symbol and separators', () => {
  const r = computeAllocation(base({
    deposit: { amount: '$9,401.01', date: '2026-08-01' },
    influxIndex: 1,
  }));
  assert.equal(sumCents(r.tranches), 940101);
});

test('penny discipline holds across a three-way split with a partial post-checkpoint deficit', () => {
  // An amount and deficit chosen to force rounding on multiple boundaries at once.
  const r = computeAllocation(base({
    deposit: { amount: 7333.33, date: '2027-01-20' },
    influxIndex: 1,
    bufferBalance: 100,
    taxAccruedTotal: 1000.55, taxHeld: 0, // deficit 1000.55
  }));
  assert.equal(sumCents(r.tranches), 733333);
});

// ---------------------------------------------------------------------------
// Flag-do-not-guess: every bad-input path returns empty tranches + a flag.
// ---------------------------------------------------------------------------

test('unparseable deposit amount returns no tranches and a flag', () => {
  const r = computeAllocation(base({ deposit: { amount: 'not-a-number', date: '2026-08-01' } }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('unparseable deposit amount')));
});

test('negative deposit returns no tranches and a flag', () => {
  const r = computeAllocation(base({ deposit: { amount: -500, date: '2026-08-01' } }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('negative deposit amount')));
});

test('unparseable deposit date returns no tranches and a flag', () => {
  const r = computeAllocation(base({ deposit: { amount: 9400, date: '2026-13-40' } }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('unparseable deposit date')));
});

test('missing debts array returns no tranches and a flag (empty array is fine, missing is not)', () => {
  const r = computeAllocation(base({ debts: undefined }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('missing debts array')));
});

test('missing deposit object returns no tranches and a flag', () => {
  const r = computeAllocation({ influxIndex: 1, debts: [], checkpointDate: '2027-01-15' });
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('missing deposit')));
});

test('unparseable checkpointDate returns no tranches and a flag', () => {
  const r = computeAllocation(base({ checkpointDate: 'nope' }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('unparseable checkpointDate')));
});

test('invalid influxIndex (zero, negative, non-integer) returns no tranches and a flag', () => {
  for (const bad of [0, -1, 1.5, 'x', undefined]) {
    const r = computeAllocation(base({ influxIndex: bad }));
    assert.deepEqual(r.tranches, [], `influxIndex ${bad} should reject`);
    assert.ok(r.flags.some((f) => f.includes('influxIndex')), `influxIndex ${bad} should flag`);
  }
});

test('unparseable bufferBalance returns no tranches and a flag', () => {
  const r = computeAllocation(base({ bufferBalance: 'many dollars' }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('unparseable bufferBalance')));
});

test('post-checkpoint tax missing accrued/held inputs is flagged, not guessed', () => {
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    taxAccruedTotal: undefined,
    taxHeld: undefined,
  }));
  assert.deepEqual(r.tranches, []);
  assert.ok(r.flags.some((f) => f.includes('post-checkpoint tax needs')));
});

test('a malformed Roth block is flagged and does not redirect money', () => {
  // Discover dead, in the window, but the Roth block is missing its deadline: the
  // redirect is skipped and flagged; strike falls through to the next debt/reservoir.
  const r = computeAllocation(base({
    deposit: { amount: 9400, date: '2027-02-01' },
    influxIndex: 5,
    bufferBalance: 6000,
    taxAccruedTotal: 5000, taxHeld: 5000,
    roth: { funded: 0, target: 7500, windowStart: '2027-01-15' }, // no deadline
    debts: [{ name: 'Discover', balance: 0, apr: 28.49 }, { name: 'Apple', balance: 20000, apr: 24.99 }],
  }));
  assert.ok(r.flags.some((f) => f.includes('Roth block present but incomplete')));
  assert.equal(byDest(r.tranches, 'Roth IRA 2026'), undefined);
  assert.equal(byDest(r.tranches, 'Apple').amount, 7990); // tax $0 post-checkpoint
});

test('a $0 deposit allocates nothing without erroring', () => {
  const r = computeAllocation(base({ deposit: { amount: 0, date: '2026-08-01' } }));
  assert.deepEqual(r.tranches, []);
  assert.equal(r.flags.length, 0);
  assert.ok(r.summary.some((s) => s.includes('nothing to allocate')));
});

test('bufferTier1Target defaults to $6,000 when omitted', () => {
  // Omit the target; a $5,999 buffer must still count as below tier 1 (boost applies).
  const r = computeAllocation(base({ bufferTier1Target: undefined, bufferBalance: 5999, influxIndex: 1 }));
  assert.equal(byDest(r.tranches, 'CNB - Joint (buffer)').amount, 3290); // 35% boost
});

test('result is deterministic: identical input yields identical tranches', () => {
  const a = computeAllocation(base());
  const b = computeAllocation(base());
  assert.deepEqual(a.tranches, b.tranches);
});
