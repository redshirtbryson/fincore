// Correct the locked baseline to include the New Home asset, which existed at lock
// time (the land was bought 2026-06-15, before the 2026-07-17 lock) but was not yet
// tracked. Without this, the next snapshot would read the newly-tracked $23,600 asset
// as a fake ~$23,600 net-worth "improvement". SPEC section 1/3C: measure and attribute
// honestly. Uses the designed correction path (correctBaseline, 30-day window, audited).
//
//   node correct-baseline.js         DRY RUN: show the recomputed baseline
//   node correct-baseline.js apply   correct it (audited)
//
// Run on pm2-prod (needs fincore.db with the locked baseline + oracle valuations).
import 'dotenv/config';
import { openStore, baselineState, correctBaseline, getMeta } from './lib/store.js';
import { computeOutcomes, formatOutcome } from './lib/outcomes.js';

const apply = process.argv[2] === 'apply';
const REASON = 'Capitalized the new-home land ($23,600) into a New Home asset account; it existed at baseline but was untracked.';
const ACTOR = 'correct-baseline';
const money = (n) => (n == null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function main() {
  const db = openStore();
  const state = baselineState(db);
  if (!state.locked) { console.log('No baseline is locked — nothing to correct.'); db.close(); return; }
  if (!state.correctable) { console.log(`Correction window closed (${state.windowEndsAt}); the baseline is frozen.`); db.close(); return; }

  const snapshotDate = getMeta(db, 'baseline_snapshot_date');
  const before = db.prepare('SELECT net_worth, dti, dti_basis FROM nw_dti_series WHERE snapshot_date = ?').get(snapshotDate);
  const outcome = await computeOutcomes(db);

  console.log(`Baseline locked ${state.lockedAt}; correction window open until ${state.windowEndsAt}.`);
  console.log(`\nCurrent baseline:  net worth ${money(before?.net_worth)}  | DTI ${before?.dti != null ? (before.dti * 100).toFixed(1) + '%' : 'n/a'}`);
  console.log('\nRecomputed now (includes New Home):');
  console.log(formatOutcome(outcome));
  if (outcome.flags?.length) { console.log('\nFLAGS present — resolve before correcting:'); for (const f of outcome.flags) console.log('  - ' + f); }
  console.log(`\nWould correct baseline net worth: ${money(before?.net_worth)} -> ${money(outcome.netWorth.netWorth)}`);
  console.log(`Reason: ${REASON}`);

  if (!apply) { console.log('\nDRY RUN. Re-run with "apply" to correct (audited).'); db.close(); return; }

  correctBaseline(db, {
    netWorth: outcome.netWorth.netWorth,
    dti: outcome.dti.dti,
    dtiBasis: outcome.dti.basis || null,
    inputs: outcome.inputs,
    reason: REASON,
    actor: ACTOR,
  });
  console.log('\nBaseline corrected (audited).');
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
