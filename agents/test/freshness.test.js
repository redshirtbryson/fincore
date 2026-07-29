// Money-grade tests for the feed freshness engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFreshness, staleSummaryLine, parseThresholdOverrides } from '../lib/freshness.js';

const now = new Date('2026-07-12T12:00:00Z');

test('a fresh feed lands in fresh, not stale', () => {
  const r = assessFreshness([{ name: 'chase-checking', lastActivity: '2026-07-11' }], { now });
  assert.deepEqual(r.fresh, ['chase-checking']);
  assert.equal(r.stale.length, 0);
  assert.equal(r.flags.length, 0);
});

test('a null lastActivity is stale with reason never seen', () => {
  const r = assessFreshness([{ name: 'schwab-positions', lastActivity: null }], { now });
  assert.equal(r.fresh.length, 0);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].reason, 'never seen');
  assert.equal(r.stale[0].daysSince, null);
});

test('a missing lastActivity is stale with reason never seen', () => {
  const r = assessFreshness([{ name: 'no-marker' }], { now });
  assert.equal(r.stale[0].reason, 'never seen');
});

test('an unparseable lastActivity fails closed: stale and flagged', () => {
  const r = assessFreshness([{ name: 'garbled', lastActivity: 'last tuesday' }], { now });
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].reason, 'unparseable timestamp');
  assert.equal(r.stale[0].daysSince, null);
  assert.ok(r.flags.some((f) => f.includes('garbled')));
});

test('exactly the threshold number of days is still fresh', () => {
  // Default threshold 5. 2026-07-07 is exactly 5 UTC days before 2026-07-12.
  const r = assessFreshness([{ name: 'edge', lastActivity: '2026-07-07' }], { now });
  assert.deepEqual(r.fresh, ['edge']);
  assert.equal(r.stale.length, 0);
});

test('one day past the threshold is stale', () => {
  // 2026-07-06 is 6 UTC days before 2026-07-12, past the default 5.
  const r = assessFreshness([{ name: 'edge', lastActivity: '2026-07-06' }], { now });
  assert.equal(r.fresh.length, 0);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].daysSince, 6);
});

test('a per-feed thresholdDays override beats the default', () => {
  // 4 days since; default 5 would be fresh, but a per-feed threshold of 3 makes it stale.
  const r = assessFreshness([{ name: 'tight', lastActivity: '2026-07-08', thresholdDays: 3 }], { now });
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].daysSince, 4);
});

test('a per-feed thresholdDays override can loosen past the default', () => {
  // 8 days since; default 5 would be stale, but a per-feed threshold of 10 keeps it fresh.
  const r = assessFreshness([{ name: 'loose', lastActivity: '2026-07-04', thresholdDays: 10 }], { now });
  assert.deepEqual(r.fresh, ['loose']);
});

test('a SQLite datetime string parses as UTC', () => {
  const r = assessFreshness([{ name: 'sqlite-feed', lastActivity: '2026-07-11 23:59:59' }], { now });
  assert.deepEqual(r.fresh, ['sqlite-feed']);
  assert.equal(r.stale.length, 0);
});

test('an ISO datetime string parses', () => {
  const r = assessFreshness([{ name: 'iso-feed', lastActivity: '2026-07-11T08:30:00Z' }], { now });
  assert.deepEqual(r.fresh, ['iso-feed']);
});

test('daysSince is measured on UTC-day boundaries regardless of time of day', () => {
  // Same calendar day as now (UTC) reads zero days since, and is fresh.
  const r = assessFreshness([{ name: 'today', lastActivity: '2026-07-12 03:00:00' }], { now });
  assert.deepEqual(r.fresh, ['today']);
});

test('a missing now throws RangeError (purity demands explicit time)', () => {
  assert.throws(() => assessFreshness([{ name: 'x', lastActivity: '2026-07-11' }], {}), RangeError);
});

test('an invalid now Date throws RangeError', () => {
  assert.throws(
    () => assessFreshness([{ name: 'x', lastActivity: '2026-07-11' }], { now: new Date('nope') }),
    RangeError
  );
});

// staleSummaryLine

test('an all-fresh assessment renders an empty summary line', () => {
  const r = assessFreshness([{ name: 'chase-checking', lastActivity: '2026-07-11' }], { now });
  assert.equal(staleSummaryLine(r), '');
});

test('the summary line lists stale feeds in alphabetical order with day counts and never-seen', () => {
  const r = assessFreshness(
    [
      { name: 'schwab-positions', lastActivity: null },
      { name: 'chase-checking', lastActivity: '2026-07-04' },
    ],
    { now }
  );
  assert.equal(staleSummaryLine(r), 'STALE FEEDS: chase-checking (8d), schwab-positions (never seen)');
});

// parseThresholdOverrides

test('overrides parse accountId=days pairs with whitespace tolerance', () => {
  const { overrides, errors } = parseThresholdOverrides(' 3=35 , 12 = 14 ');
  assert.equal(overrides.get('3'), 35);
  assert.equal(overrides.get('12'), 14);
  assert.equal(errors.length, 0);
});

test('empty, unset, and blank-entry override strings yield no overrides and no errors', () => {
  assert.equal(parseThresholdOverrides(undefined).overrides.size, 0);
  assert.equal(parseThresholdOverrides('').overrides.size, 0);
  const r = parseThresholdOverrides('3=35,,');
  assert.equal(r.overrides.size, 1);
  assert.equal(r.errors.length, 0);
});

test('malformed override entries are skipped with an error, valid siblings survive', () => {
  const { overrides, errors } = parseThresholdOverrides('3=35,bogus,4=0,5=-2,6=abc');
  assert.equal(overrides.size, 1);
  assert.equal(overrides.get('3'), 35);
  assert.equal(errors.length, 4);
  for (const e of errors) assert.match(e, /ignored/);
});

test('a per-feed threshold override keeps a slow-cadence account fresh past the default', () => {
  // The Huntington Savings case: 8 days since the monthly interest posting,
  // default threshold 7 would flag it; a 35-day override must not.
  const r = assessFreshness(
    [{ name: 'bank:3:Huntington Bank - Savings', lastActivity: '2026-07-04', thresholdDays: 35 }],
    { now, defaultThresholdDays: 7 }
  );
  assert.deepEqual(r.fresh, ['bank:3:Huntington Bank - Savings']);
  assert.equal(r.stale.length, 0);
});

test('an overridden account still ages out past its own threshold', () => {
  const r = assessFreshness(
    [{ name: 'bank:3:Huntington Bank - Savings', lastActivity: '2026-06-01', thresholdDays: 35 }],
    { now, defaultThresholdDays: 7 }
  );
  assert.equal(r.stale.length, 1);
  assert.match(r.stale[0].reason, /41d since last activity exceeds 35d threshold/);
});
