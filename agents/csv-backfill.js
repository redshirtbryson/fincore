// One-off historical backfill: read bank/card CSV exports and create the
// transactions in Firefly via its API. Replaces the broken data-importer for
// backfills. Deterministic (explicit per-file spec), reversible (every row tagged
// 'csv-backfill'), and safe-by-default (dry-run unless you pass "apply").
//
// Usage (run where the CSVs live, with Firefly creds in .env):
//   node csv-backfill.js            # dry run: parse, transform, print, write nothing
//   node csv-backfill.js apply      # create the transactions in Firefly
//   node csv-backfill.js delete     # roll back: delete everything tagged csv-backfill
//
// Env: FIREFLY_III_URL, FIREFLY_III_PAT (as usual). BACKFILL_DIR (default
// ~/Downloads), BACKFILL_END_DATE (default 2026-07-13; rows after it are the
// sync's job).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv, transformRows } from './lib/csv-backfill.js';
import * as firefly from './lib/firefly.js';

const DIR = process.env.BACKFILL_DIR || `${process.env.HOME}/Downloads`;
const END_DATE = process.env.BACKFILL_END_DATE || '2026-07-13';
const TAG = 'csv-backfill';

// Per-file specs. Column names, date convention, and amount sign were read from the
// actual exports. negate=true means the export uses positive = charge (debt up):
// Apple and Discover do, Huntington and Amazon/Chase do not.
const SPECS = [
  { file: 'huntington-savings.csv', accountName: 'Huntington Bank - Savings', dateCol: 'Date', amountCol: 'Amount', descCol: 'Description', negate: false },
  { file: 'credit-amazon.csv', accountName: 'Credit - Amazon Prime', dateCol: 'Transaction Date', amountCol: 'Amount', descCol: 'Description', negate: false },
  { file: 'credit-apple.csv', accountName: 'Credit - Apple', dateCol: 'Transaction Date', amountCol: 'Amount (USD)', descCol: 'Description', negate: true },
  { file: 'credit-discover.csv', accountName: 'Credit - Discover', dateCol: 'Trans. Date', amountCol: 'Amount', descCol: 'Description', negate: true },
  // CNB joint: ISO dates, a separate Credit/Debit column (positive amounts), and NOT
  // synced -- so import the full history (endDate null), not just up to the boundary.
  { file: 'cnb-joint.csv', accountName: 'CNB - Joint', dateCol: 'Processed Date', amountCol: 'Amount', descCol: 'Description', directionCol: 'Credit or Debit', dateFormat: 'iso', endDate: null },
];

function loadSpec(spec) {
  const full = path.join(DIR, spec.file);
  if (!fs.existsSync(full)) return { ...spec, missing: true, creates: [], flags: [`file not found: ${full}`], counts: {} };
  const rows = parseCsv(fs.readFileSync(full, 'utf8'));
  // A spec may pin its own endDate (null = import everything, e.g. an unsynced account);
  // otherwise fall back to the global backfill boundary.
  const endDate = Object.prototype.hasOwnProperty.call(spec, 'endDate') ? spec.endDate : END_DATE;
  const { creates, flags, counts } = transformRows(rows, { ...spec, endDate });
  return { ...spec, rowCount: rows.length, creates, flags, counts };
}

function printSummary(loaded) {
  for (const s of loaded) {
    console.log(`\n=== ${s.file}  ->  ${s.accountName} ===`);
    if (s.missing) { console.log(`  MISSING: ${s.flags[0]}`); continue; }
    const c = s.counts;
    console.log(`  ${s.rowCount} rows read, ${c.total} to create (${c.withdrawals} out, ${c.deposits} in), ${c.skippedAfterEnd} after ${END_DATE} skipped (sync's job)`);
    console.log(`  dates ${c.dateRange[0]} .. ${c.dateRange[1]}; total out $${c.totalOut.toFixed(2)}, total in $${c.totalIn.toFixed(2)}; sign ${s.negate ? 'NEGATED (positive=charge)' : 'as-is (negative=out)'}`);
    for (const sample of s.creates.slice(0, 3)) {
      console.log(`    ${sample.date}  ${sample.type.padEnd(10)} $${sample.amount.padStart(10)}  ${sample.description.slice(0, 50)}`);
    }
    for (const f of s.flags.slice(0, 5)) console.log(`    FLAG: ${f}`);
    if (s.flags.length > 5) console.log(`    (+${s.flags.length - 5} more flags)`);
  }
}

async function resolveAccounts(loaded) {
  const [assets, liabilities] = await Promise.all([firefly.getAccounts('asset'), firefly.getAccounts('liabilities')]);
  const byName = new Map([...assets, ...liabilities].map((a) => [a.name, a.id]));
  const problems = [];
  for (const s of loaded) {
    if (s.missing) continue;
    s.accountId = byName.get(s.accountName);
    if (!s.accountId) problems.push(`no Firefly account named "${s.accountName}" (create it first)`);
  }
  return problems;
}

async function apply(loaded) {
  const problems = await resolveAccounts(loaded);
  if (problems.length) {
    console.error('Cannot apply, account mapping failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const s of loaded) {
    if (s.missing || !s.creates.length) continue;
    let created = 0;
    let duplicate = 0;
    const failed = [];
    for (const c of s.creates) {
      const args = { type: c.type, date: c.date, amount: c.amount, description: c.description, tags: [TAG] };
      if (c.type === 'withdrawal') { args.sourceId = s.accountId; args.destinationName = c.counterparty; }
      else { args.destinationId = s.accountId; args.sourceName = c.counterparty; }
      try {
        const r = await firefly.createTransaction(args);
        if (r.duplicate) duplicate += 1;
        else created += 1;
      } catch (e) {
        failed.push(`${c.date} ${c.description}: ${e.message}`);
      }
    }
    console.log(`${s.file}: ${created} created, ${duplicate} duplicate, ${failed.length} failed`);
    for (const f of failed.slice(0, 5)) console.log(`  FAIL ${f}`);
  }
}

async function rollback() {
  const ids = await firefly.getTransactionsByTag(TAG);
  console.log(`deleting ${ids.length} transactions tagged "${TAG}"...`);
  let deleted = 0;
  for (const id of ids) {
    try { await firefly.deleteTransaction(id); deleted += 1; } catch (e) { console.log(`  FAIL ${id}: ${e.message}`); }
  }
  console.log(`deleted ${deleted}/${ids.length}`);
}

async function main() {
  const mode = process.argv[2] || 'dry-run';
  // Optional file filter: process only specs whose filename contains this substring,
  // so a single new account (e.g. cnb-joint.csv) can be imported without re-touching
  // files already backfilled.
  const only = process.argv[3];
  const specs = only ? SPECS.filter((s) => s.file.includes(only)) : SPECS;
  if (only && specs.length === 0) { console.error(`no spec matches "${only}"`); process.exit(1); }
  const loaded = specs.map(loadSpec);

  if (mode === 'delete') { await rollback(); return; }

  printSummary(loaded);
  const totals = loaded.reduce((n, s) => n + (s.counts.total || 0), 0);
  console.log(`\nTotal to create across all files: ${totals} (end boundary ${END_DATE}, all tagged "${TAG}")`);

  if (mode === 'apply') {
    console.log('\nAPPLYING to Firefly...\n');
    await apply(loaded);
  } else {
    console.log('\nDry run only. Re-run with "apply" to write, or "delete" to roll back a prior apply.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
