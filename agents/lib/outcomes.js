// Outcomes orchestration: reads Firefly and the store, calls the pure engines,
// writes the nw/dti series. Thin I/O glue; all math lives in networth.js and
// dti.js so it stays testable without a network.
import * as firefly from './firefly.js';
import { computeNetWorth } from './networth.js';
import { computeDTI, monthlyGrossForSource } from './dti.js';
import { upsertSeriesRow, touchFeed, audit, getMeta, latestPaystub, latestValuations } from './store.js';

// Feeds older than this are stale: figures computed over them must say so
// rather than being presented as current (SPEC section 11). Phase 4 extends this
// beyond API reachability to true upstream freshness (last-imported-transaction
// recency per bank feed); the shape here is what it builds on.
const STALE_AFTER_DAYS = 3;

// A valuation without fresh data eventually RETIRES from the sum entirely: a
// disconnected or sold-off account must not ride its last mark forever. Between
// STALE_AFTER_DAYS and here it is summed but flagged stale; past here it is
// excluded with a loud flag.
const VALUATION_RETIRE_DAYS = 14;

// Pure partition, exported for tests.
export function partitionValuations(valuations, { now, retireAfterDays = VALUATION_RETIRE_DAYS } = {}) {
  const current = [];
  const retired = [];
  const cutoff = now.getTime() - retireAfterDays * 86400000;
  for (const v of valuations) {
    const t = parseStoreTimestamp(v.asOf);
    if (Number.isNaN(t) || t < cutoff) retired.push(v);
    else current.push(v);
  }
  return { current, retired };
}

function parseStoreTimestamp(ts) {
  if (!ts) return NaN;
  // Accept SQLite datetime('now') UTC 'YYYY-MM-DD HH:MM:SS', bare dates, and ISO.
  let normalized = ts;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) normalized = `${ts}T00:00:00Z`;
  else if (!ts.includes('T')) normalized = `${ts.replace(' ', 'T')}Z`;
  return new Date(normalized).getTime();
}

export function staleFeeds(db) {
  // Two conditions, both fail closed: a computed stale verdict, OR a verdict that
  // has not been rewritten recently (the freshness pass itself broke, so trusting
  // its frozen 'ok' would present stale data as current, SPEC 11's named failure).
  return db
    .prepare(
      `SELECT feed FROM feed_freshness
       WHERE status != 'ok' OR updated < datetime('now', '-${STALE_AFTER_DAYS} days')
       ORDER BY feed`
    )
    .all()
    .map((r) => r.feed);
}

// Gather engine inputs from Firefly and the store, compute both headline numbers,
// and return everything needed to either display (onboarding preview) or persist
// (snapshot). Only write: recording firefly feed freshness on a successful read.
// Pass prefetched accounts so a caller that already showed them to the user (the
// onboarding review step) computes the baseline from the exact set reviewed.
export async function computeOutcomes(db, { accounts = null, now = new Date() } = {}) {
  let allAccounts = accounts;
  if (!allAccounts) {
    const [assetAccounts, liabilityAccounts] = await Promise.all([
      firefly.getAccounts('asset'),
      firefly.getAccounts('liabilities'),
    ]);
    allAccounts = [...assetAccounts, ...liabilityAccounts];
  }
  touchFeed(db, 'firefly');

  // Net worth sums Firefly accounts plus oracle valuations ONLY. Schwab balances
  // arrive through the oracle (zero-maintenance SimpleFIN feed); the positions
  // store is analytics enrichment (Phase 11: TLH, drift, concentration) whose
  // weekly-expiring Trader API token must never be able to stale the headline
  // number. Positions are therefore deliberately NOT passed into the sum.
  const latestAsOf = db.prepare('SELECT MAX(as_of) AS asOf FROM positions').get()?.asOf || null;
  const { current: valuations, retired } = partitionValuations(latestValuations(db), { now });

  const nw = computeNetWorth({ accounts: allAccounts, valuations });
  for (const v of retired) {
    nw.flags.push(
      `valuation "${v.accountName}" retired from net worth: no data since ${v.asOf} (over ${VALUATION_RETIRE_DAYS} days). Reconnect the feed or remove its match rule.`
    );
  }

  const stale = staleFeeds(db);
  // Positions staleness is an ANALYTICS freshness signal (advice over old marks),
  // not a net worth problem; it reports as such. Unparseable fails closed.
  if (latestAsOf) {
    const t = parseStoreTimestamp(latestAsOf);
    if (Number.isNaN(t) || t < now.getTime() - STALE_AFTER_DAYS * 86400000) {
      stale.push(`schwab-positions/analytics-only (as of ${latestAsOf})`);
    }
  }
  for (const v of valuations) {
    const t = parseStoreTimestamp(v.asOf);
    if (Number.isNaN(t) || t < now.getTime() - STALE_AFTER_DAYS * 86400000) {
      stale.push(`valuation:${v.accountName} (as of ${v.asOf})`);
    }
  }

  const obligations = db
    .prepare('SELECT name, kind, monthly_amount AS monthlyAmount, active FROM obligations WHERE active = 1')
    .all();

  const sources = db
    .prepare(
      `SELECT name, treatment, cadence, declared_monthly_gross AS declaredMonthlyGross
       FROM income_sources WHERE active = 1`
    )
    .all();
  const incomes = sources.map((source) =>
    monthlyGrossForSource({
      source,
      paystub: source.treatment === 'w2' ? latestPaystub(db, source.name) : null,
      // Observed per-source monthly history comes from categorized income-source
      // tags; wiring that in follows once enough tagged months exist (Phase 4+).
      observedMonths: [],
    })
  );

  const dtiResult = computeDTI({ obligations, incomes });

  return {
    netWorth: nw,
    // Firefly-scope figure for reconciliation: Firefly's own summary can never
    // include positions or oracle valuations, so drift is only meaningful over
    // the accounts both sides can see.
    fireflyNetWorth: nw.netWorth === null ? null : nw.assetsTotal + nw.liabilitiesTotal,
    dti: dtiResult,
    stale,
    flags: [...nw.flags, ...dtiResult.flags],
    inputs: {
      accounts: allAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        balance: a.currentBalance,
        included: a.includeNetWorth !== false && a.active !== false,
      })),
      positionsAsOf: latestAsOf,
      valuations: valuations.map((v) => ({ name: v.accountName, balance: v.balance, asOf: v.asOf })),
      obligations,
      incomes,
    },
  };
}

// Compute and persist today's series row. Refuses to run before the baseline is
// locked: the series must not start ahead of the "before" it is measured against.
// If today IS the locked baseline date, the write is skipped (the baseline row is
// write-protected in the store) and the outcome reports it.
export async function snapshot(db, { actor = 'snapshot', snapshotDate = firefly.nyDateStr() } = {}) {
  if (!getMeta(db, 'baseline_locked_at')) {
    throw new Error('baseline not locked; run onboarding (npm run onboard) before snapshotting');
  }
  const outcome = await computeOutcomes(db);
  let skippedBaseline = false;
  const tx = db.transaction(() => {
    const result = upsertSeriesRow(db, {
      snapshotDate,
      netWorth: outcome.netWorth.netWorth,
      dti: outcome.dti.dti,
      dtiBasis: outcome.dti.basis || null,
      partialBasis: outcome.dti.partial ? 1 : 0,
      flags: outcome.flags,
      inputs: outcome.inputs,
      staleFeeds: outcome.stale.length ? outcome.stale.join(',') : null,
    });
    skippedBaseline = result.skippedBaseline;
    if (!skippedBaseline) {
      audit(db, {
        actor,
        action: 'series.snapshot',
        target: `nw_dti_series:${snapshotDate}`,
        after: { netWorth: outcome.netWorth.netWorth, dti: outcome.dti.dti, stale: outcome.stale },
      });
    }
  });
  tx();
  return { ...outcome, skippedBaseline };
}

export function money(v) {
  return v === null || v === undefined
    ? 'n/a'
    : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatOutcome(outcome) {
  const lines = [];
  const nw = outcome.netWorth;
  lines.push(`Net worth: ${money(nw.netWorth)} (assets ${money(nw.assetsTotal)}, liabilities ${money(nw.liabilitiesTotal)}, valuations ${money(nw.valuationsTotal)})`);
  const d = outcome.dti;
  lines.push(
    d.dti === null
      ? 'DTI: cannot be computed yet'
      : `DTI: ${(d.dti * 100).toFixed(1)}% (${money(d.monthlyObligations)} obligations / ${money(d.monthlyGrossIncome)} gross monthly)${d.partial ? ' [partial income basis]' : ''}`
  );
  if (d.basis) lines.push(`Income basis: ${d.basis}`);
  for (const f of outcome.flags) lines.push(`FLAG: ${f}`);
  if (outcome.stale.length) lines.push(`STALE FEEDS: ${outcome.stale.join(', ')}`);
  if (outcome.skippedBaseline) lines.push('Note: today is the locked baseline date; the baseline row was left untouched.');
  return lines.join('\n');
}
