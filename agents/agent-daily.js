// agent-daily: runs each morning under PM2, categorizes new transactions.
// Deterministic categorization is already handled by Firefly III rules on import;
// this job only touches the residue Firefly could not categorize, sends it to Haiku,
// auto-applies confident answers, and asks on Discord when unsure.
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { categorizeBatch } from './lib/anthropic.js';
import { sendAsk, sendHeartbeat } from './lib/discord.js';

// The store (better-sqlite3, a native addon) is loaded lazily so a missing or
// broken native build degrades the snapshot and audit features, never the
// categorizer itself. Returns null when unavailable.
let storeModules = null;
async function loadStore() {
  if (storeModules) return storeModules;
  try {
    const [store, outcomes] = await Promise.all([import('./lib/store.js'), import('./lib/outcomes.js')]);
    storeModules = { store, outcomes };
  } catch (e) {
    console.warn('fincore.db unavailable (continuing without snapshot/audit):', e.message);
    storeModules = null;
  }
  return storeModules;
}

const THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.8);
const CAP = Number(process.env.CATEGORIZE_CAP || 40);
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 30);

// Trigger the Data Importer's autoimport endpoint: POST /autoimport?directory=..&secret=..
// with an empty body. Requires CAN_POST_AUTOIMPORT, AUTO_IMPORT_SECRET, and
// IMPORT_DIR_ALLOWLIST on the importer container (see firefly-stack/README.md).
// Fire-and-forget: the import runs asynchronously in the importer, so transactions it
// pulls may only be categorized on the next run. The lookback window absorbs that.
async function maybeTriggerImport() {
  const base = (process.env.IMPORTER_URL || '').replace(/\/+$/, '');
  const secret = process.env.IMPORTER_AUTOIMPORT_SECRET || '';
  if (process.env.IMPORTER_AUTOIMPORT_URL) {
    console.warn('IMPORTER_AUTOIMPORT_URL is no longer read; set IMPORTER_URL + IMPORTER_AUTOIMPORT_SECRET (see .env.example).');
  }
  if (!base && !secret) return;
  if (!base || !secret) {
    console.warn('autoimport trigger skipped: both IMPORTER_URL and IMPORTER_AUTOIMPORT_SECRET must be set.');
    return;
  }
  const dir = process.env.IMPORTER_AUTOIMPORT_DIR || '/import';
  const url = `${base}/autoimport?directory=${encodeURIComponent(dir)}&secret=${encodeURIComponent(secret)}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
    if (!res.ok) console.warn(`importer trigger -> ${res.status} (continuing)`);
  } catch (e) {
    console.warn('importer trigger failed (continuing):', e.message);
  }
}

// Off-host dead man's switch (SPEC section 13): a healthchecks.io-style URL that
// alerts when the ping STOPS arriving, covering host-level outages the bot's own
// liveness cross-check cannot see. Optional; unset means skip.
async function pingHealthcheck(ok) {
  const url = process.env.HEALTHCHECK_PING_URL;
  if (!url) return;
  try {
    await fetch(ok ? url : `${url.replace(/\/+$/, '')}/fail`, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    console.warn('healthcheck ping failed:', e.message);
  }
}

async function main() {
  // Health check first so a bad token fails loudly and early.
  const about = await firefly.about();
  console.log('firefly ok:', about?.version);

  await maybeTriggerImport();

  const items = await firefly.getTransactionsNeedingReview({ lookbackDays: LOOKBACK, cap: CAP });
  if (items.length === 0) {
    await sendHeartbeat('Fincore daily: no new transactions to categorize.');
    return;
  }

  const { guesses, errors } = await categorizeBatch(items);
  // Keyed per split, not per transaction: a multi-split transaction yields several
  // items sharing one tx_id, and collapsing them would apply one split's guess to all.
  const byKey = new Map(guesses.map((g) => [`${g.tx_id}|${g.journal_id}`, g]));

  let applied = 0;
  let asked = 0;
  const failures = [...errors];
  const auditDb = await openAuditDb();

  for (const item of items) {
    const g = byKey.get(`${item.tx_id}|${item.journal_id}`);
    if (!g) continue;
    try {
      if (g.confidence >= THRESHOLD && g.category && g.category !== 'Uncategorized') {
        await firefly.applyConfirmed(item.tx_id, item.journal_id, g.category, {
          incomeSource: g.income_source,
          knownTags: item.existing_tags,
        });
        applied += 1;
        auditCategorization(auditDb, item, g);
      } else {
        // Ask first, then tag. The review tag makes future runs skip the transaction,
        // so it must never be applied unless the human was actually asked; a failed
        // tag after a sent ask just means a duplicate ask tomorrow, which is benign.
        await sendAsk(item, g);
        await firefly.markReview(item.tx_id, item.journal_id, { knownTags: item.existing_tags });
        asked += 1;
      }
    } catch (e) {
      failures.push(`${item.tx_id}: ${e.message}`);
    }
  }

  if (auditDb) auditDb.close();

  const overflow = items.length >= CAP ? ` Cap reached (${CAP}); more will process tomorrow.` : '';
  let summary = `Fincore daily: ${applied} auto-categorized, ${asked} need your review.${overflow}`;
  if (failures.length) summary += `\n${failures.length} errors: ${failures.slice(0, 5).join('; ')}`;
  summary += await dailyStoreLines();
  await sendHeartbeat(summary);
  console.log(summary);
}

async function openAuditDb() {
  const mods = await loadStore();
  if (!mods) return null;
  try {
    return mods.store.openStore();
  } catch (e) {
    console.warn('audit store open failed (continuing):', e.message);
    return null;
  }
}

// SPEC section 15: every autonomous action lands in the audit log with a reversal
// handle. Audit failure is loud but never blocks the categorization itself.
function auditCategorization(db, item, g) {
  if (!db) return;
  try {
    storeModules.store.audit(db, {
      actor: 'categorizer',
      action: 'transaction.categorize',
      target: `firefly:tx:${item.tx_id}:${item.journal_id}`,
      before: { category: null },
      after: { category: g.category, confidence: g.confidence, incomeSource: g.income_source },
      reversalHandle: storeModules.store.reversalHandleFor('firefly_transaction', `${item.tx_id}:${item.journal_id}`, {
        category: null,
      }),
    });
  } catch (e) {
    console.warn(`audit write failed for tx ${item.tx_id}:`, e.message);
  }
}

// Store-backed daily work, in dependency order: matching and freshness FIRST
// (matching cleans the data the snapshot sums; freshness writes the verdicts the
// snapshot row records), then the snapshot (only once the baseline exists, SPEC
// 10.3), then reconciliation (needs the computed figure). Matching writes are
// gated on the baseline lock like the snapshot: nothing acts before the baseline
// exists. Each part is reported, never fatal to the categorizer.
async function dailyStoreLines() {
  const mods = await loadStore();
  if (!mods) return '\nSnapshot and quality passes skipped: fincore.db unavailable.';
  let db = null;
  const lines = [];
  let computedNetWorth = null;
  try {
    db = mods.store.openStore();
    const baselineLocked = Boolean(mods.store.getMeta(db, 'baseline_locked_at'));
    if (!baselineLocked) {
      // Said out loud on purpose: a silently empty store (unrun onboarding, or a
      // typo'd FINCORE_DB_PATH pointing at a fresh file) must be visible.
      lines.push('Snapshot and matching skipped: baseline not locked (run npm run onboard).');
    }

    let deposits = [];
    let quality = null;
    try {
      quality = await import('./lib/quality.js');
      const pre = await quality.runPreSnapshotPasses(db, { matchingEnabled: baselineLocked });
      deposits = pre.deposits;
      lines.push(...pre.lines);
    } catch (e) {
      lines.push(`Quality passes failed: ${e.message}`);
    }

    if (baselineLocked) {
      let fireflyNetWorth = null;
      try {
        const outcome = await mods.outcomes.snapshot(db, { actor: 'agent-daily' });
        computedNetWorth = outcome.netWorth.netWorth;
        fireflyNetWorth = outcome.fireflyNetWorth;
        const { money } = mods.outcomes;
        const dti = outcome.dti.dti;
        let line = `Snapshot: net worth ${money(computedNetWorth)}, DTI ${dti === null ? 'n/a' : `${(dti * 100).toFixed(1)}%`}${outcome.dti.partial ? ' (partial basis)' : ''}.`;
        if (outcome.flags.length) line += ` ${outcome.flags.length} data flags; run npm run snapshot for detail.`;
        if (outcome.stale.length) line += ` STALE: ${outcome.stale.join(', ')}.`;
        lines.push(line);
      } catch (e) {
        lines.push(`Snapshot failed: ${e.message}`);
      }

      if (quality) {
        try {
          // Reconcile over the Firefly-scope figure only: Firefly's own summary can
          // never include Schwab positions or oracle valuations.
          const r = await quality.runReconcilePass(db, { computedNetWorth: fireflyNetWorth, deposits });
          lines.push(...r.lines);
          quality.surfaceFlags(lines, 'Reconcile', r.flags);
        } catch (e) {
          lines.push(`Reconcile pass failed: ${e.message}`);
        }
      }
    }

    return lines.length ? `\n${lines.join('\n')}` : '';
  } catch (e) {
    return `\nStore work failed: ${e.message}`;
  } finally {
    if (db) db.close();
  }
}

main()
  .then(() => pingHealthcheck(true))
  .catch(async (e) => {
    console.error(e);
    try {
      await sendHeartbeat(`Fincore daily FAILED: ${e.message}`);
    } catch (_) {}
    await pingHealthcheck(false);
    process.exit(1);
  });
