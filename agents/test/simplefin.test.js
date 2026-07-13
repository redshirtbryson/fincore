// Tests for the SimpleFIN balance oracle's pure parts and the valuation store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAccessUrl,
  matchesValuationRule,
  parseMatchRules,
  normalizeValuation,
  overlapsFireflyAccount,
} from '../lib/simplefin.js';
import { openStore, upsertValuation, latestValuations } from '../lib/store.js';
import { computeNetWorth } from '../lib/networth.js';
import { partitionValuations } from '../lib/outcomes.js';

test('splitAccessUrl separates credentials into a basic auth header', () => {
  const { base, auth } = splitAccessUrl('https://USER:PASS@beta-bridge.simplefin.org/simplefin');
  assert.equal(base, 'https://beta-bridge.simplefin.org/simplefin');
  assert.equal(Buffer.from(auth, 'base64').toString(), 'USER:PASS');
});

test('splitAccessUrl rejects a URL without credentials (probably the claim URL)', () => {
  assert.throws(() => splitAccessUrl('https://beta-bridge.simplefin.org/simplefin/claim/abc'), /claim URL/);
});

test('overlapsFireflyAccount trips on containment either way, case-insensitive', () => {
  assert.equal(overlapsFireflyAccount('Coinbase Rewards Card', ['Coinbase Rewards Card (Chase)']), 'Coinbase Rewards Card (Chase)');
  assert.equal(overlapsFireflyAccount('Empower Retirement 401(k)', ['Huntington Checking', 'Cash wallet']), null);
  assert.equal(overlapsFireflyAccount('', ['Anything']), null);
});

test('partitionValuations retires marks older than the retire window', () => {
  const now = new Date('2026-07-13T12:00:00Z');
  const { current, retired } = partitionValuations(
    [
      { accountName: 'Fresh', asOf: '2026-07-12' },
      { accountName: 'Old', asOf: '2026-06-01' },
      { accountName: 'Broken', asOf: 'garbage' }, // unparseable retires (fail closed)
    ],
    { now, retireAfterDays: 14 }
  );
  assert.deepEqual(current.map((v) => v.accountName), ['Fresh']);
  assert.deepEqual(retired.map((v) => v.accountName).sort(), ['Broken', 'Old']);
});

test('match rules are opt-in, case-insensitive, on org + account name', () => {
  const rules = parseMatchRules(' Empower , coinbase ,');
  assert.deepEqual(rules, ['empower', 'coinbase']);
  assert.ok(matchesValuationRule({ org: { name: 'Empower Retirement' }, name: '401(k)' }, rules));
  assert.ok(matchesValuationRule({ org: { name: 'Coinbase' }, name: 'BTC Wallet' }, rules));
  // The importer-mapped checking account must never match.
  assert.equal(matchesValuationRule({ org: { name: 'Huntington Bank' }, name: 'Checking' }, rules), false);
  assert.equal(matchesValuationRule({}, rules), false);
  assert.equal(matchesValuationRule({ org: { name: 'Empower' }, name: 'x' }, []), false);
});

test('normalizeValuation converts balance-date epoch to NY calendar days and flags unusable balances', () => {
  // 2026-07-15T00:00:00Z is still 2026-07-14 in America/New_York: day boundaries
  // follow the project-wide NY convention, not UTC.
  const good = normalizeValuation({
    id: 'ACT-1',
    name: '401(k)',
    org: { name: 'Empower Retirement' },
    currency: 'USD',
    balance: '54210.33',
    'balance-date': Date.UTC(2026, 6, 15) / 1000,
  });
  assert.equal(good.valuation.balance, 54210.33);
  assert.equal(good.valuation.asOf, '2026-07-14');
  assert.equal(good.valuation.accountName, 'Empower Retirement 401(k)');
  assert.equal(good.valuation.source, 'simplefin');

  // No balance date: falls back to the caller-provided now (as an NY day), never
  // the wall clock. 2026-07-13T16:00Z is 2026-07-13 in NY.
  const fallback = normalizeValuation({ id: 'x', name: 'y', balance: 10 }, { nowMs: Date.UTC(2026, 6, 13, 16) });
  assert.equal(fallback.valuation.asOf, '2026-07-13');
  assert.ok(normalizeValuation({ id: 'x', name: 'y', balance: 10 }).error); // no date at all

  // A broken balance is an error, never a $0 valuation.
  assert.ok(normalizeValuation({ id: 'x', name: 'y', balance: 'lots' }, { nowMs: 1 }).error);
  assert.ok(normalizeValuation({ id: 'x', name: 'y' }, { nowMs: 1 }).error);
  // A legitimate $0 balance is valid.
  assert.equal(normalizeValuation({ id: 'x', name: 'y', balance: 0 }, { nowMs: 1 }).valuation.balance, 0);
});

test('valuation store upserts per (source, account, day) and returns the latest per account', () => {
  const db = openStore(':memory:');
  upsertValuation(db, { source: 'simplefin', accountId: 'A', accountName: 'Empower 401k', currency: 'USD', balance: 100, asOf: '2026-07-12' });
  upsertValuation(db, { source: 'simplefin', accountId: 'A', accountName: 'Empower 401k', currency: 'USD', balance: 110, asOf: '2026-07-13' });
  upsertValuation(db, { source: 'simplefin', accountId: 'A', accountName: 'Empower 401k', currency: 'USD', balance: 111, asOf: '2026-07-13' }); // same-day correction
  upsertValuation(db, { source: 'simplefin', accountId: 'B', accountName: 'Coinbase', currency: 'USD', balance: 50, asOf: '2026-07-12' });

  const latest = latestValuations(db);
  assert.equal(latest.length, 2);
  const empower = latest.find((v) => v.accountId === 'A');
  assert.equal(empower.balance, 111);
  assert.equal(empower.asOf, '2026-07-13');
  assert.equal(latest.find((v) => v.accountId === 'B').balance, 50);
});

test('net worth sums valuations and fails closed on broken or non-USD ones', () => {
  const accounts = [{ id: '1', name: 'Checking', type: 'asset', currentBalance: 1000, currencyCode: 'USD' }];
  const good = computeNetWorth({ accounts, valuations: [{ accountName: 'Empower 401k', balance: 54210.33, currency: 'USD' }] });
  assert.equal(good.netWorth, 55210.33);
  assert.equal(good.valuationsTotal, 54210.33);

  const broken = computeNetWorth({ accounts, valuations: [{ accountName: 'Empower 401k', balance: NaN }] });
  assert.equal(broken.netWorth, null);
  assert.ok(broken.flags.some((f) => f.includes('Empower')));

  const eur = computeNetWorth({ accounts, valuations: [{ accountName: 'X', balance: 10, currency: 'EUR' }] });
  assert.equal(eur.netWorth, null);
});

test('migration v1 to v2 adds account_valuations without touching v1 data', () => {
  // Simulate the deployed prod db: open (migrates to current), then confirm both
  // the new table and the old ones coexist and user_version is 2.
  const db = openStore(':memory:');
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('account_valuations'));
  assert.ok(tables.includes('nw_dti_series'));
});
