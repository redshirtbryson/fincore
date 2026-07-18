// Money-grade tests for the influx cadence watcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cadence, droughtStatus, bufferRunway } from '../lib/influx-watch.js';

// Real-ish WV CSP deposit history: gaps 39, 39, 40, 41 days -> median 39.5.
const HISTORY = ['2026-01-30', '2026-03-10', '2026-04-18', '2026-05-28', '2026-07-08'];

// --- cadence -----------------------------------------------------------------

test('real history: median 39.5, lastDate 2026-07-08, n 5', () => {
  const r = cadence(HISTORY);
  assert.equal(r.medianGapDays, 39.5);
  assert.equal(r.lastDate, '2026-07-08');
  assert.equal(r.n, 5);
  assert.equal(r.flag, undefined);
});

test('even gap count uses average of the two middle values', () => {
  // Gaps 39, 39, 40, 41 -> middle two are 39 and 40 -> avg 39.5.
  const r = cadence(HISTORY);
  assert.equal(r.medianGapDays, 39.5);
});

test('odd gap count returns the true middle', () => {
  // Four dates -> gaps 39, 39, 40 -> median 39.
  const r = cadence(['2026-01-30', '2026-03-10', '2026-04-18', '2026-05-28']);
  assert.equal(r.medianGapDays, 39);
  assert.equal(r.n, 4);
});

test('unsorted input is sorted before gaps are computed', () => {
  const shuffled = ['2026-07-08', '2026-01-30', '2026-05-28', '2026-03-10', '2026-04-18'];
  const r = cadence(shuffled);
  assert.equal(r.medianGapDays, 39.5);
  assert.equal(r.lastDate, '2026-07-08');
});

test('duplicate dates are collapsed (no zero gap injected)', () => {
  const r = cadence(['2026-01-30', '2026-01-30', '2026-03-10', '2026-04-18']);
  assert.equal(r.n, 3);
  // Gaps 39, 39 -> median 39, not dragged toward 0 by a phantom same-day gap.
  assert.equal(r.medianGapDays, 39);
});

test('flag: fewer than 3 dates is insufficient history, but lastDate/median still computed', () => {
  const r = cadence(['2026-01-30', '2026-03-10']);
  assert.match(r.flag, /insufficient history/);
  assert.equal(r.n, 2);
  assert.equal(r.lastDate, '2026-03-10');
  assert.equal(r.medianGapDays, 39); // one gap is still computable
});

test('flag: single date -> insufficient history, no median', () => {
  const r = cadence(['2026-01-30']);
  assert.match(r.flag, /insufficient history/);
  assert.equal(r.n, 1);
  assert.equal(r.lastDate, '2026-01-30');
  assert.equal(r.medianGapDays, null);
});

test('flag: empty history', () => {
  const r = cadence([]);
  assert.match(r.flag, /insufficient history/);
  assert.equal(r.n, 0);
  assert.equal(r.lastDate, null);
  assert.equal(r.medianGapDays, null);
});

test('flag: non-array input', () => {
  const r = cadence(null);
  assert.match(r.flag, /insufficient history/);
  assert.equal(r.n, 0);
});

test('unparseable dates are dropped and flagged', () => {
  const r = cadence(['2026-01-30', 'garbage', '2026-03-10', '2026-04-18']);
  assert.equal(r.n, 3);
  assert.match(r.flag, /1 unparseable/);
});

// --- droughtStatus -----------------------------------------------------------

test('ok: within one median gap of the last deposit', () => {
  // last 2026-07-08, median 39.5 (floor 39). 2026-08-01 is 24d after -> ok.
  const r = droughtStatus({ depositDates: HISTORY, today: '2026-08-01' });
  assert.equal(r.level, 'ok');
  assert.equal(r.daysSinceLast, 24);
  assert.match(r.message, /on schedule/);
});

test('ok at the exact median-gap boundary (39d)', () => {
  // 2026-07-08 + 39 = 2026-08-16.
  const r = droughtStatus({ depositDates: HISTORY, today: '2026-08-16' });
  assert.equal(r.daysSinceLast, 39);
  assert.equal(r.level, 'ok');
});

test('watch: past the median gap, before expectedBy', () => {
  // overdueDays = ceil(39.5 * 1.4) = ceil(55.3) = 56 -> expectedBy 2026-09-02.
  // 2026-08-20 is 43d after 2026-07-08: past 39, before 56.
  const r = droughtStatus({ depositDates: HISTORY, today: '2026-08-20' });
  assert.equal(r.level, 'watch');
  assert.equal(r.daysSinceLast, 43);
  assert.equal(r.expectedBy, '2026-09-02');
  assert.match(r.message, /running late/);
});

test('overdue: on the expectedBy day', () => {
  // expectedBy 2026-09-02 (56d after 2026-07-08).
  const r = droughtStatus({ depositDates: HISTORY, today: '2026-09-02' });
  assert.equal(r.level, 'overdue');
  assert.equal(r.daysSinceLast, 56);
  assert.equal(r.expectedBy, '2026-09-02');
  assert.match(r.message, /OVERDUE/);
});

test('overdue: past the expectedBy day', () => {
  const r = droughtStatus({ depositDates: HISTORY, today: '2026-09-20' });
  assert.equal(r.level, 'overdue');
  assert.ok(r.daysSinceLast > 56);
});

test('overdueFactor is configurable', () => {
  // factor 1.0 -> overdueDays = ceil(39.5) = 40 -> expectedBy 2026-08-17.
  const r = droughtStatus({ depositDates: HISTORY, today: '2026-08-18', overdueFactor: 1.0 });
  assert.equal(r.expectedBy, '2026-08-17');
  assert.equal(r.level, 'overdue');
});

test('unknown: insufficient history degrades cleanly', () => {
  const r = droughtStatus({ depositDates: ['2026-07-08'], today: '2026-08-01' });
  assert.equal(r.level, 'unknown');
  assert.equal(r.expectedBy, null);
  assert.equal(r.daysSinceLast, 24); // still report days since the one deposit
  assert.ok(r.flag);
});

test('unknown: empty history', () => {
  const r = droughtStatus({ depositDates: [], today: '2026-08-01' });
  assert.equal(r.level, 'unknown');
  assert.equal(r.daysSinceLast, null);
  assert.ok(r.flag);
});

test('flag: unparseable today', () => {
  const r = droughtStatus({ depositDates: HISTORY, today: 'tomorrow' });
  assert.ok(r.flag);
  assert.equal(r.level, undefined);
});

test('flag: unusable overdueFactor', () => {
  assert.ok(droughtStatus({ depositDates: HISTORY, today: '2026-08-01', overdueFactor: 0 }).flag);
  assert.ok(droughtStatus({ depositDates: HISTORY, today: '2026-08-01', overdueFactor: -1 }).flag);
  assert.ok(droughtStatus({ depositDates: HISTORY, today: '2026-08-01', overdueFactor: NaN }).flag);
});

test('dropped-date flag surfaces through droughtStatus', () => {
  const r = droughtStatus({ depositDates: [...HISTORY, 'nope'], today: '2026-08-01' });
  assert.equal(r.level, 'ok');
  assert.match(r.flag, /unparseable/);
});

// --- bufferRunway ------------------------------------------------------------

test('real fixture: 6000 buffer at 2950/mo -> ~8.8 weeks', () => {
  const r = bufferRunway({ bufferBalance: 6000, monthlyGap: 2950 });
  // weeklyBurn = 2950 / 4.345 = 678.94...; 6000 / 678.94 = 8.837... -> 8.8.
  assert.equal(r.weeks, 8.8);
  assert.match(r.message, /8\.8 weeks/);
});

test('monthlyGap defaults to 2950', () => {
  const r = bufferRunway({ bufferBalance: 6000 });
  assert.equal(r.weeks, 8.8);
});

test('zero buffer -> 0 weeks', () => {
  const r = bufferRunway({ bufferBalance: 0, monthlyGap: 2950 });
  assert.equal(r.weeks, 0);
});

test('accepts numeric strings with $ and commas', () => {
  const r = bufferRunway({ bufferBalance: '$6,000', monthlyGap: '$2,950' });
  assert.equal(r.weeks, 8.8);
});

test('flag: unparseable bufferBalance', () => {
  assert.ok(bufferRunway({ bufferBalance: 'plenty', monthlyGap: 2950 }).flag);
});

test('flag: unparseable monthlyGap', () => {
  assert.ok(bufferRunway({ bufferBalance: 6000, monthlyGap: 'some' }).flag);
});

test('flag: zero monthlyGap (division guard)', () => {
  const r = bufferRunway({ bufferBalance: 6000, monthlyGap: 0 });
  assert.match(r.flag, /zero/);
});

test('flag: negative buffer is not a valid magnitude', () => {
  assert.ok(bufferRunway({ bufferBalance: -100, monthlyGap: 2950 }).flag);
});

test('flag: no arguments at all', () => {
  assert.ok(bufferRunway().flag);
});
