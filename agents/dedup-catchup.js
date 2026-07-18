// Remove sync-created duplicates of CSV-backfilled transactions. Needed whenever a
// widened catch-up sync (SYNC_LOOKBACK_DAYS above the default) reaches back across
// the CSV backfill boundary: Firefly's duplicate hash only catches byte-identical
// journals, and the feed masks descriptions differently than the CSV export
// ("XXXXXX3590" vs "6307763590"), so the same real-world transaction lands twice.
//
//   node dedup-catchup.js          DRY RUN: list sync copies that duplicate a CSV row
//   node dedup-catchup.js apply    delete the SYNC copies (the CSV copy, already
//                                  categorized, is kept)
//
// Match key: type + own-account + date + exact cents. Deliberately strict — a real
// same-day same-amount repeat purchase would produce TWO sync rows for ONE csv row,
// which this flags (ambiguous) instead of deleting.
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json', 'Content-Type': 'application/json' };
const apply = process.argv[2] === 'apply';
const cents = (a) => Math.round(parseFloat(a) * 100);

async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: H });
  const b = await r.text();
  if (!r.ok) { const e = new Error(p + ' -> ' + r.status + ' ' + b.slice(0, 160)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

const all = [];
for (const type of ['withdrawal', 'deposit']) {
  let page = 1;
  for (;;) {
    const j = await fapi(`/transactions?type=${type}&limit=200&page=${page}`);
    const d = j.data || [];
    if (!d.length) break;
    for (const t of d) for (const s of t.attributes.transactions) all.push({
      txId: t.id, type: s.type, date: (s.date || '').slice(0, 10), desc: s.description || '', amount: s.amount,
      tags: s.tags || [], acctId: s.type === 'deposit' ? s.destination_id : s.source_id,
      acct: s.type === 'deposit' ? s.destination_name : s.source_name,
    });
    if (d.length < 200) break;
    page++;
  }
}

const key = (x) => `${x.type}|${x.acctId}|${x.date}|${cents(x.amount)}`;
const csvByKey = new Map();
for (const x of all) if (x.tags.includes('csv-backfill')) csvByKey.set(key(x), x);

const syncMatches = new Map(); // key -> sync copies
for (const x of all) {
  if (!x.tags.includes('simplefin-sync')) continue;
  const k = key(x);
  if (!csvByKey.has(k)) continue;
  if (!syncMatches.has(k)) syncMatches.set(k, []);
  syncMatches.get(k).push(x);
}

const toDelete = [];
let ambiguous = 0;
for (const [k, copies] of syncMatches) {
  const c = csvByKey.get(k);
  if (copies.length > 1) {
    ambiguous += 1;
    console.log(`AMBIGUOUS (${copies.length} sync copies for one CSV row; a real repeat purchase?) — NOT touched:`);
    for (const x of copies) console.log(`    tx${x.txId} ${x.date} $${parseFloat(x.amount).toFixed(2)} ${x.desc.slice(0, 40)}`);
    continue;
  }
  const x = copies[0];
  console.log(`DUP: ${x.date} $${parseFloat(x.amount).toFixed(2)} ${x.acct}`);
  console.log(`    keep   csv tx${c.txId}: ${c.desc.slice(0, 46)}`);
  console.log(`    delete sync tx${x.txId}: ${x.desc.slice(0, 46)}`);
  toDelete.push(x);
}

console.log(`\n${toDelete.length} sync duplicate(s) to delete; ${ambiguous} ambiguous left alone.`);
if (!apply) { console.log('DRY RUN. Re-run with "apply".'); process.exit(0); }

let done = 0;
for (const x of toDelete) {
  try { await fapi('/transactions/' + x.txId, { method: 'DELETE' }); done++; }
  catch (e) { console.log(`  delete tx${x.txId} failed: ${e.message}`); }
}
console.log(`Deleted ${done}/${toDelete.length} sync duplicate(s). (Their SimpleFIN ids stay in the seen-ledger, so the sync will not re-create them.)`);
