// CNB finalization: map CNB into the sync, dedup the pre-import stray, prevent the
// CSV<->sync overlap, sync the recent window, and true the opening balance so CNB's
// computed balance lands on its real SimpleFIN balance. Run on pm2-prod (needs the
// SimpleFIN URL + the store + Firefly).
//
//   node cnb-finalize.js          DRY RUN: print the full plan, write nothing
//   node cnb-finalize.js apply    execute, in order:
//        1. map CNB (SimpleFIN -> Firefly acct 12) so future syncs flow automatically
//        2. delete pre-import strays that duplicate a CSV row (the $150 Blenko)
//        3. prime the seen-ledger for SimpleFIN txns already present via the CSV
//           (dated <= the last CSV row), so the sync cannot double-create them
//        4. run the sync (fills any genuinely newer transactions the CSV lacks)
//        5. true the opening balance: opening_new = opening_old + (real - computed),
//           computed read LIVE after 1-4 so the balance lands on real regardless.
//
// Step 5 is self-correcting by construction, so the ledger balance is right even if the
// recent window shifts; steps 2-3 keep the transaction HISTORY clean (no phantom dups).
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { fetchTransactions } from './lib/simplefin.js';
import { epochWindow } from './lib/sync.js';
import { runSyncPass } from './lib/quality.js';
import { openStore, upsertSyncAccountMapEntry, markTxnSeen } from './lib/store.js';

const CNB_FID = '12';
const CNB_NAME = 'CNB - Joint';
const CNB_SFID = 'ACT-9fcfe978-96e6-4d7a-94d4-e2822edfec0d';
const apply = process.argv[2] === 'apply';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json', 'Content-Type': 'application/json' };
async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: H });
  const b = await r.text();
  if (!r.ok) { const e = new Error(r.status + ' ' + b.slice(0, 200)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cents = (a) => Math.round(parseFloat(a) * 100);

async function cnbFireflyState() {
  const acct = (await fapi('/accounts/' + CNB_FID)).data.attributes;
  const txns = [];
  let page = 1;
  for (;;) {
    const j = await fapi(`/accounts/${CNB_FID}/transactions?limit=200&page=${page}`);
    const d = j.data || [];
    if (!d.length) break;
    for (const t of d) for (const s of t.attributes.transactions) {
      txns.push({ txId: t.id, jId: s.transaction_journal_id, type: s.type, date: (s.date || '').slice(0, 10), amount: s.amount, desc: s.description, tags: s.tags || [] });
    }
    if (d.length < 200) break;
    page += 1;
  }
  return { computed: parseFloat(acct.current_balance), opening: parseFloat(acct.opening_balance), openingDate: (acct.opening_balance_date || '').slice(0, 10), txns };
}

// SimpleFIN CNB account: current balance + recent transactions (30-day window).
async function cnbSimplefin() {
  const { startEpoch, endEpoch } = epochWindow({ now: new Date(), lookbackDays: 30 });
  const accounts = await fetchTransactions({ startEpoch, endEpoch });
  const a = accounts.find((x) => String(x.id) === CNB_SFID) || accounts.find((x) => /city national|CNB/i.test((x.org?.name || '') + ' ' + (x.name || '')));
  if (!a) throw new Error('CNB not found in SimpleFIN accounts');
  const txns = (a.transactions || []).map((t) => ({ id: String(t.id), posted: t.posted, date: firefly.nyDateStr(new Date(t.posted * 1000)), amount: t.amount, desc: t.description || t.payee || '' }));
  return { realBalance: parseFloat(a.balance), txns };
}

async function main() {
  console.log(`CNB finalize — mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  const ff = await cnbFireflyState();
  const sf = await cnbSimplefin();

  const csvDates = ff.txns.filter((t) => t.tags.includes('csv-backfill')).map((t) => t.date).sort();
  const csvMax = csvDates.length ? csvDates[csvDates.length - 1] : ff.openingDate;

  // Strays: a non-CSV, non-opening-balance Firefly txn that duplicates a CSV row
  // (same date+amount+type). The pre-import $150 Blenko is the known one.
  const csvKey = new Set(ff.txns.filter((t) => t.tags.includes('csv-backfill')).map((t) => `${t.type}|${t.date}|${cents(t.amount)}`));
  const strays = ff.txns.filter((t) => t.type !== 'opening balance' && !t.tags.includes('csv-backfill') && csvKey.has(`${t.type}|${t.date}|${cents(t.amount)}`));

  // Seen-prime: SimpleFIN txns already in Firefly via the CSV (dated <= csvMax). Priming
  // them makes the sync skip them, so it never double-creates the overlap window.
  const toPrime = sf.txns.filter((t) => t.date <= csvMax);
  const gap = sf.txns.filter((t) => t.date > csvMax);

  console.log(`Firefly CNB: computed ${money(ff.computed)} | opening ${money(ff.opening)} @ ${ff.openingDate} | ${ff.txns.length} txns (CSV through ${csvMax})`);
  console.log(`SimpleFIN CNB: real balance ${money(sf.realBalance)} | ${sf.txns.length} txns in 30d window\n`);
  console.log(`1. MAP: SimpleFIN ${CNB_SFID} -> Firefly ${CNB_FID} (${CNB_NAME})`);
  console.log(`2. DEDUP strays (delete): ${strays.length}`);
  for (const s of strays) console.log(`     tx${s.txId}  ${s.date}  ${money(s.amount)}  ${s.desc.slice(0, 40)}`);
  console.log(`3. SEEN-PRIME (skip in sync, already in CSV): ${toPrime.length} SimpleFIN txn(s) dated <= ${csvMax}`);
  console.log(`4. SYNC will create genuinely newer txns (dated > ${csvMax}): ${gap.length}`);
  for (const g of gap) console.log(`     ${g.date}  ${money(g.amount)}  ${g.desc.slice(0, 40)}`);

  // Truing preview (final number is computed live at apply, after 2-4).
  const strayDelta = strays.reduce((n, s) => n + (s.type === 'deposit' ? -cents(s.amount) : s.type === 'withdrawal' ? cents(s.amount) : 0), 0) / 100;
  const projectedComputed = ff.computed + strayDelta; // gap-sync effect is absorbed by the live read at apply
  const openingNewPreview = ff.opening + (sf.realBalance - projectedComputed);
  console.log(`\n5. TRUE opening: opening_new = ${money(ff.opening)} + (${money(sf.realBalance)} - computed_live)`);
  console.log(`     preview (pre-sync): ~${money(openingNewPreview)}  (exact value computed live at apply)`);

  if (!apply) {
    console.log('\nDRY RUN. Re-run with "apply" to execute steps 1-5.');
    return;
  }

  const db = openStore();
  // 1. map
  upsertSyncAccountMapEntry(db, { simplefinId: CNB_SFID, fireflyAccountId: CNB_FID, fireflyAccountName: CNB_NAME, actor: 'cnb-finalize' });
  console.log('\n[1] mapped.');
  // 2. dedup
  let deleted = 0;
  for (const s of strays) { try { await fapi('/transactions/' + s.txId, { method: 'DELETE' }); deleted += 1; } catch (e) { console.log('  del fail ' + s.txId + ': ' + e.message); } }
  console.log(`[2] deleted ${deleted}/${strays.length} stray(s).`);
  // 3. seen-prime
  for (const t of toPrime) markTxnSeen(db, t.id, null);
  console.log(`[3] primed ${toPrime.length} SimpleFIN txn id(s) as seen.`);
  // 4. sync (all mapped accounts; CNB now included)
  const res = await runSyncPass(db, { now: new Date() });
  console.log(`[4] sync: ${res.created ?? 0} created, ${res.duplicates ?? 0} duplicate.${res.line ? ' ' + res.line : ''}`);
  // 5. true (live computed)
  const after = await cnbFireflyState();
  const openingNew = +(after.opening + (sf.realBalance - after.computed)).toFixed(2);
  await fapi('/accounts/' + CNB_FID, { method: 'PUT', body: JSON.stringify({ opening_balance: String(openingNew), opening_balance_date: after.openingDate }) });
  const verify = await cnbFireflyState();
  console.log(`[5] opening ${money(after.opening)} -> ${money(openingNew)}; CNB computed now ${money(verify.computed)} (target ${money(sf.realBalance)}).`);
  db.close();
  const ok = Math.abs(cents(verify.computed) - cents(sf.realBalance)) <= 1;
  console.log(`\n${ok ? 'DONE — CNB balance trued to real.' : 'WARNING — computed did not land on real; check by hand.'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
