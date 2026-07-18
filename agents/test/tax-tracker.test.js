// Money-grade tests for the tax set-aside tracker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taxOwed, checkpointStatus } from '../lib/tax-tracker.js';

// The hard checkpoint from the playbook.
const CHECKPOINT = '2027-01-15';

// --- taxOwed -----------------------------------------------------------------

test('real fixture: 47000 @ 0.30 with 400 held -> accrued 14100, deficit 13700', () => {
  const r = taxOwed({ redshirtReceivedTotal: 47000, rate: 0.30, savingsBalance: 400 });
  assert.equal(r.accrued, 14100);
  assert.equal(r.held, 400);
  assert.equal(r.deficit, 13700);
  assert.equal(r.flag, undefined);
});

test('rate defaults to 0.30 when omitted', () => {
  const r = taxOwed({ redshirtReceivedTotal: 47000, savingsBalance: 400 });
  assert.equal(r.accrued, 14100);
  assert.equal(r.deficit, 13700);
});

test('over-funded set-aside yields deficit 0, never negative', () => {
  const r = taxOwed({ redshirtReceivedTotal: 10000, rate: 0.30, savingsBalance: 5000 });
  assert.equal(r.accrued, 3000);
  assert.equal(r.held, 5000);
  assert.equal(r.deficit, 0);
});

test('exactly funded yields deficit 0', () => {
  const r = taxOwed({ redshirtReceivedTotal: 10000, rate: 0.30, savingsBalance: 3000 });
  assert.equal(r.deficit, 0);
});

test('accrual rounds to whole cents (no float drift)', () => {
  // 100.10 * 0.30 = 30.03 exactly; guard against 30.029999...
  const r = taxOwed({ redshirtReceivedTotal: 100.10, rate: 0.30, savingsBalance: 0 });
  assert.equal(r.accrued, 30.03);
  assert.equal(r.deficit, 30.03);
});

test('accepts numeric strings with $ and commas', () => {
  const r = taxOwed({ redshirtReceivedTotal: '$47,000', rate: 0.30, savingsBalance: '$400.00' });
  assert.equal(r.accrued, 14100);
  assert.equal(r.deficit, 13700);
});

test('flag: unparseable redshirtReceivedTotal', () => {
  const r = taxOwed({ redshirtReceivedTotal: 'lots', rate: 0.30, savingsBalance: 400 });
  assert.ok(r.flag);
  assert.equal(r.accrued, undefined);
});

test('flag: negative total is not a valid magnitude', () => {
  const r = taxOwed({ redshirtReceivedTotal: -100, rate: 0.30, savingsBalance: 0 });
  assert.ok(r.flag);
});

test('flag: unparseable savingsBalance', () => {
  const r = taxOwed({ redshirtReceivedTotal: 47000, rate: 0.30, savingsBalance: null });
  assert.ok(r.flag);
});

test('flag: rate out of [0,1]', () => {
  assert.ok(taxOwed({ redshirtReceivedTotal: 47000, rate: 1.5, savingsBalance: 0 }).flag);
  assert.ok(taxOwed({ redshirtReceivedTotal: 47000, rate: -0.1, savingsBalance: 0 }).flag);
});

test('flag: rate is NaN', () => {
  assert.ok(taxOwed({ redshirtReceivedTotal: 47000, rate: NaN, savingsBalance: 0 }).flag);
});

test('flag: no arguments at all', () => {
  assert.ok(taxOwed().flag);
});

// --- checkpointStatus --------------------------------------------------------

test('deficit 0 is always ok, even past the checkpoint', () => {
  const before = checkpointStatus({ deficit: 0, today: '2026-10-01', checkpointDate: CHECKPOINT });
  assert.equal(before.level, 'ok');
  const after = checkpointStatus({ deficit: 0, today: '2027-03-01', checkpointDate: CHECKPOINT });
  assert.equal(after.level, 'ok');
});

test('deficit > 0, more than 60 days out -> info (2026-10-01)', () => {
  const r = checkpointStatus({ deficit: 13700, today: '2026-10-01', checkpointDate: CHECKPOINT });
  assert.equal(r.level, 'info');
  assert.ok(r.daysToCheckpoint > 60);
  assert.match(r.message, /\$13,700\.00/);
  assert.match(r.message, /2027-01-15/);
});

test('deficit > 0, within 60 days -> warn (2026-12-01)', () => {
  const r = checkpointStatus({ deficit: 13700, today: '2026-12-01', checkpointDate: CHECKPOINT });
  assert.equal(r.level, 'warn');
  assert.ok(r.daysToCheckpoint > 0 && r.daysToCheckpoint <= 60);
  assert.match(r.message, /WARN/);
  assert.match(r.message, /\$13,700\.00/);
});

test('deficit > 0, on the checkpoint -> critical (2027-01-15)', () => {
  const r = checkpointStatus({ deficit: 13700, today: '2027-01-15', checkpointDate: CHECKPOINT });
  assert.equal(r.level, 'critical');
  assert.equal(r.daysToCheckpoint, 0);
  assert.match(r.message, /CRITICAL/);
  assert.match(r.message, /today/);
});

test('deficit > 0, past the checkpoint -> critical (2027-02-01)', () => {
  const r = checkpointStatus({ deficit: 13700, today: '2027-02-01', checkpointDate: CHECKPOINT });
  assert.equal(r.level, 'critical');
  assert.ok(r.daysToCheckpoint < 0);
  assert.match(r.message, /ago/);
});

test('exactly 60 days out with deficit -> warn (boundary)', () => {
  // 60 days before 2027-01-15 is 2026-11-16.
  const r = checkpointStatus({ deficit: 100, today: '2026-11-16', checkpointDate: CHECKPOINT });
  assert.equal(r.daysToCheckpoint, 60);
  assert.equal(r.level, 'warn');
});

test('61 days out with deficit -> info (boundary)', () => {
  const r = checkpointStatus({ deficit: 100, today: '2026-11-15', checkpointDate: CHECKPOINT });
  assert.equal(r.daysToCheckpoint, 61);
  assert.equal(r.level, 'info');
});

test('flag: unparseable deficit', () => {
  const r = checkpointStatus({ deficit: 'some', today: '2026-10-01', checkpointDate: CHECKPOINT });
  assert.ok(r.flag);
});

test('flag: unparseable today', () => {
  const r = checkpointStatus({ deficit: 100, today: 'soon', checkpointDate: CHECKPOINT });
  assert.ok(r.flag);
});

test('flag: unparseable checkpointDate', () => {
  const r = checkpointStatus({ deficit: 100, today: '2026-10-01', checkpointDate: '2027-13-40' });
  assert.ok(r.flag);
});

test('flag: no arguments at all', () => {
  assert.ok(checkpointStatus().flag);
});
