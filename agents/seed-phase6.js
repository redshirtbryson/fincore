// One-off: seed the Phase 6 plan state from the ledger (run once on pm2-prod).
//   node seed-phase6.js          DRY RUN
//   node seed-phase6.js apply
//
// Seeds: plan_cnb_base (the CNB balance at plan start — buffer counts NEW dollars
// above it), redshirt_received_2026 (sum of income-source:redshirt-cloud deposits,
// the tax formula's base), roth_2026_funded (0), and the historical Redshirt
// deposit dates as status='historical' rows so the drought watcher has a cadence
// from day one. Idempotent: metas overwrite, historical rows dedupe on journal id.
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { openStore, setMeta, getMeta, recordInfluxAllocation, influxDates } from './lib/store.js';

const apply = process.argv[2] === 'apply';
const CNB_BASE = 621.68; // trued 2026-07-18 (cnb-finalize)

async function main() {
  console.log(`Phase 6 seed — mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  // All 2026 Redshirt deposits from the full ledger.
  const deposits = [];
  const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
  const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json' };
  let page = 1;
  for (;;) {
    const r = await fetch(`${BASE}/api/v1/transactions?type=deposit&limit=200&page=${page}`, { headers: H });
    const j = await r.json();
    const d = j.data || [];
    if (!d.length) break;
    for (const t of d) for (const s of t.attributes.transactions) {
      if ((s.tags || []).includes('income-source:redshirt-cloud')) {
        deposits.push({ txId: t.id, jId: String(s.transaction_journal_id), date: (s.date || '').slice(0, 10), amount: parseFloat(s.amount) });
      }
    }
    if (d.length < 200) break;
    page++;
  }
  deposits.sort((a, b) => (a.date < b.date ? -1 : 1));
  const total = deposits.reduce((n, d) => n + d.amount, 0);

  console.log(`Redshirt deposits found: ${deposits.length}, total $${total.toFixed(2)}`);
  for (const d of deposits) console.log(`  ${d.date}  $${d.amount.toFixed(2)}`);
  console.log(`\nWill seed: plan_cnb_base=$${CNB_BASE} | redshirt_received_2026=$${total.toFixed(2)} | roth_2026_funded=0`);
  console.log(`Historical influx rows (cadence seed): ${deposits.length}`);

  if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); return; }

  const db = openStore();
  setMeta(db, 'plan_start_date', '2026-07-18');
  setMeta(db, 'plan_cnb_base', String(CNB_BASE));
  setMeta(db, 'redshirt_received_2026', String(total.toFixed(2)));
  if (getMeta(db, 'roth_2026_funded') === null) setMeta(db, 'roth_2026_funded', '0');
  for (const d of deposits) {
    recordInfluxAllocation(db, {
      depositDate: d.date,
      depositAmount: d.amount,
      fireflyTxId: d.txId,
      fireflyJournalId: d.jId,
      influxIndex: 0,
      tranches: [],
      status: 'historical',
      actor: 'seed-phase6',
    });
  }
  console.log(`Seeded. Influx dates now tracked: ${influxDates(db).join(', ')}`);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
