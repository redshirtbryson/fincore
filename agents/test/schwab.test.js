// Tests for the Schwab ingestion layer's pure normalizer and the positions store.
// Money-grade: cost-basis rounding, flag-don't-guess on broken values, and
// replace-by-day semantics are all asserted against exact numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchwabPayload, ingestPositions } from '../lib/schwab.js';
import { openStore } from '../lib/store.js';

// A realistic two-account payload: a brokerage with three positions (one of which
// has a broken marketValue that must be flagged, not ingested) plus cash, and a
// second account that is cash-only.
function twoAccountPayload() {
  return {
    ok: true,
    accounts: [
      {
        type: 'BROKERAGE',
        accountNumberLast4: '4821',
        liquidationValue: 12345.67,
        cashBalance: 1000.5,
        positions: [
          // 26 shares at 12.125 -> 315.25 exactly, but pick a price that needs
          // rounding: 26 * 12.126 = 315.276 -> round2 -> 315.28.
          { symbol: 'VTI', assetType: 'EQUITY', quantity: 26, marketValue: 5678.9, averagePrice: 12.126 },
          // A short position: negative quantity still ingests on a finite value.
          { symbol: 'AAPL', assetType: 'EQUITY', quantity: -10, marketValue: -1750.25, averagePrice: 175.0 },
          // Broken market value: must go to flags, never become $0.
          { symbol: 'BADMV', assetType: 'EQUITY', quantity: 5, marketValue: 'n/a', averagePrice: 3.0 },
        ],
      },
      {
        type: 'CMA',
        accountNumberLast4: '9910',
        liquidationValue: 250.0,
        cashBalance: 250.0,
        positions: [],
      },
    ],
  };
}

test('normalizeSchwabPayload: two accounts, cash pseudo-positions, flagged broken value, cost-basis rounding', () => {
  const { positions, flags } = normalizeSchwabPayload(twoAccountPayload());

  // The one broken position is flagged and excluded.
  assert.equal(flags.length, 1);
  assert.ok(flags[0].includes('BADMV'));
  assert.ok(flags[0].includes('BROKERAGE:4821'));
  assert.ok(!positions.some((p) => p.symbol === 'BADMV'));

  // Positions: VTI, AAPL, CASH (account 1), CASH (account 2). BADMV excluded.
  assert.equal(positions.length, 4);

  const vti = positions.find((p) => p.symbol === 'VTI');
  assert.equal(vti.account, 'BROKERAGE:4821');
  assert.equal(vti.quantity, 26);
  assert.equal(vti.marketValue, 5678.9);
  // 26 * 12.126 = 315.276, rounded to cents = 315.28. Exact, not float noise.
  assert.equal(vti.costBasis, 315.28);

  const aapl = positions.find((p) => p.symbol === 'AAPL');
  assert.equal(aapl.quantity, -10);
  assert.equal(aapl.marketValue, -1750.25);
  // -10 * 175.0 = -1750.00.
  assert.equal(aapl.costBasis, -1750);

  // Cash pseudo-positions: one per account, labeled and valued from cashBalance.
  const cash1 = positions.find((p) => p.symbol === 'CASH' && p.account === 'BROKERAGE:4821');
  assert.equal(cash1.marketValue, 1000.5);
  assert.equal(cash1.quantity, null);
  assert.equal(cash1.costBasis, null);
  const cash2 = positions.find((p) => p.symbol === 'CASH' && p.account === 'CMA:9910');
  assert.equal(cash2.marketValue, 250.0);
});

test('normalizeSchwabPayload: ok:false payload yields no positions and one flag', () => {
  const { positions, flags } = normalizeSchwabPayload({ ok: false, error: 'Schwab token missing or expired; run: npm run schwab-auth' });
  assert.deepEqual(positions, []);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].includes('schwab-auth'));

  // A payload that is not ok and carries no error still flags (never crashes).
  const bare = normalizeSchwabPayload({ ok: false });
  assert.deepEqual(bare.positions, []);
  assert.equal(bare.flags[0], 'schwab payload not ok');

  // A null/undefined payload is handled defensively.
  assert.equal(normalizeSchwabPayload(null).flags[0], 'schwab payload not ok');
});

test('normalizeSchwabPayload: empty accounts array flags "no accounts"', () => {
  const { positions, flags } = normalizeSchwabPayload({ ok: true, accounts: [] });
  assert.deepEqual(positions, []);
  assert.deepEqual(flags, ['schwab returned no accounts']);
});

test('normalizeSchwabPayload: CASH pseudo-position records true state, missing stays missing', () => {
  const base = (cashBalance) => ({
    ok: true,
    accounts: [{ type: 'BROKERAGE', accountNumberLast4: '0001', cashBalance, positions: [] }],
  });

  // Zero cash IS data: a liquidated account's true state records as $0, so the
  // day's snapshot exists and stale old rows stop being the latest.
  const zero = normalizeSchwabPayload(base(0)).positions;
  assert.equal(zero.length, 1);
  assert.equal(zero[0].marketValue, 0);
  // Missing/undefined/null cash: no CASH row (missing is missing, not $0).
  assert.equal(normalizeSchwabPayload(base(undefined)).positions.length, 0);
  assert.equal(normalizeSchwabPayload(base(null)).positions.length, 0);
  // Non-finite cash: no CASH row.
  assert.equal(normalizeSchwabPayload(base('lots')).positions.length, 0);
  // Negative cash (margin debit) is finite: it ingests.
  const neg = normalizeSchwabPayload(base(-42.5)).positions;
  assert.equal(neg.length, 1);
  assert.equal(neg[0].symbol, 'CASH');
  assert.equal(neg[0].marketValue, -42.5);
});

test('normalizeSchwabPayload: JSON null never becomes a fabricated zero', () => {
  // The sidecar deliberately emits null for non-numeric values, and Number(null)
  // is 0: null must flag and skip, never ingest as $0.
  const { positions, flags } = normalizeSchwabPayload({
    ok: true,
    accounts: [
      {
        type: 'BROKERAGE',
        accountNumberLast4: '0001',
        cashBalance: 100,
        positions: [
          { symbol: 'MARA', quantity: 10, marketValue: null, averagePrice: 15 },
          { symbol: 'SCHD', quantity: 5, marketValue: 130.5, averagePrice: null },
        ],
      },
    ],
  });
  // MARA (null marketValue) is flagged and skipped; SCHD ingests with null cost basis.
  assert.equal(positions.length, 2); // SCHD + CASH
  assert.ok(flags.some((f) => f.includes('MARA')));
  const schd = positions.find((p) => p.symbol === 'SCHD');
  assert.equal(schd.marketValue, 130.5);
  assert.equal(schd.costBasis, null); // null averagePrice never multiplies into 0
});

test('normalizeSchwabPayload: missing symbol and account fields fall back defensively', () => {
  const { positions } = normalizeSchwabPayload({
    ok: true,
    accounts: [{ positions: [{ marketValue: 100 }] }],
  });
  // No type/last4 -> 'schwab:????'; no symbol -> 'UNKNOWN'; no quantity -> null.
  assert.equal(positions.length, 1);
  assert.equal(positions[0].symbol, 'UNKNOWN');
  assert.equal(positions[0].account, 'schwab:????');
  assert.equal(positions[0].quantity, null);
  assert.equal(positions[0].costBasis, null);
  assert.equal(positions[0].marketValue, 100);
});

test('ingestPositions: replace-by-as_of keeps one snapshot per day, no duplicates', () => {
  const db = openStore(':memory:');
  const day = '2026-07-13';
  const rows = normalizeSchwabPayload(twoAccountPayload()).positions;

  const first = ingestPositions(db, rows, day);
  assert.equal(first, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions WHERE as_of = ?').get(day).n, 4);

  // Re-running the same day replaces, never appends.
  const second = ingestPositions(db, rows, day);
  assert.equal(second, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions WHERE as_of = ?').get(day).n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 4);

  // A short position stored its negative quantity and market value intact.
  const aapl = db.prepare('SELECT * FROM positions WHERE symbol = ? AND as_of = ?').get('AAPL', day);
  assert.equal(aapl.quantity, -10);
  assert.equal(aapl.market_value, -1750.25);
  assert.equal(aapl.raw_json, null);
});

test('ingestPositions: a different as_of keeps both days', () => {
  const db = openStore(':memory:');
  const rows = normalizeSchwabPayload(twoAccountPayload()).positions;

  ingestPositions(db, rows, '2026-07-12');
  ingestPositions(db, rows, '2026-07-13');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 8);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT as_of) AS n FROM positions').get().n, 2);

  // Re-ingesting one day only touches that day's rows.
  ingestPositions(db, rows.slice(0, 1), '2026-07-13');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions WHERE as_of = ?').get('2026-07-12').n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions WHERE as_of = ?').get('2026-07-13').n, 1);
});
