// Bill surfacing rules: due-window math is calendar arithmetic on money-relevant
// dates, so it gets the same discipline as the engines — deterministic, today as
// an input, flag-don't-guess on bad dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingBills } from '../lib/bills.js';

const T = '2026-07-19';

test('a bill inside the lookahead surfaces with correct daysUntil, sorted soonest-first', () => {
  const { due, flags } = upcomingBills(
    [
      { name: 'Property tax', amountMin: 850, amountMax: 850, nextDue: '2026-07-25', paidInPeriod: false, active: true },
      { name: 'HOA', amountMin: 100, amountMax: 120, nextDue: '2026-07-21', paidInPeriod: false, active: true },
    ],
    { today: T, lookaheadDays: 10 }
  );
  assert.equal(flags.length, 0);
  assert.deepEqual(due.map((d) => d.name), ['HOA', 'Property tax']);
  assert.equal(due[0].daysUntil, 2);
  assert.equal(due[0].amount, 110); // midpoint of the range
  assert.equal(due[1].daysUntil, 6);
  assert.equal(due[1].amount, 850); // min === max is exact
  assert.equal(due[1].overdue, false);
});

test('overdue unpaid bills surface with negative daysUntil; paid and inactive never do', () => {
  const { due } = upcomingBills(
    [
      { name: 'Late thing', amountMin: 50, amountMax: 50, nextDue: '2026-07-15', paidInPeriod: false, active: true },
      { name: 'Paid thing', amountMin: 50, amountMax: 50, nextDue: '2026-07-20', paidInPeriod: true, active: true },
      { name: 'Dead thing', amountMin: 50, amountMax: 50, nextDue: '2026-07-20', paidInPeriod: false, active: false },
    ],
    { today: T, lookaheadDays: 10 }
  );
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'Late thing');
  assert.equal(due[0].daysUntil, -4);
  assert.equal(due[0].overdue, true);
});

test('beyond the lookahead stays silent; a due-today bill is daysUntil 0', () => {
  const { due } = upcomingBills(
    [
      { name: 'Far away', amountMin: 900, amountMax: 900, nextDue: '2026-09-01', paidInPeriod: false, active: true },
      { name: 'Today', amountMin: 25, amountMax: 25, nextDue: '2026-07-19', paidInPeriod: false, active: true },
    ],
    { today: T, lookaheadDays: 10 }
  );
  assert.deepEqual(due.map((d) => [d.name, d.daysUntil, d.overdue]), [['Today', 0, false]]);
});

test('bad dates flag rather than vanish; bad inputs refuse cleanly', () => {
  const r = upcomingBills([{ name: 'Mystery', amountMin: 10, amountMax: 10, nextDue: 'soon', active: true }], { today: T });
  assert.equal(r.due.length, 0);
  assert.equal(r.flags.length, 1);
  assert.match(r.flags[0], /Mystery/);
  assert.equal(upcomingBills([], { today: 'garbage' }).flags.length, 1);
  assert.equal(upcomingBills([], { today: T, lookaheadDays: -1 }).flags.length, 1);
});
