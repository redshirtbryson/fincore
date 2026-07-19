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

// v2 (2026-07-19): the first pass filtered originals by the csv-backfill tag and
// exact-date match, which missed (a) the checking import, which predates that tag
// convention (untagged rows), and (b) copies the bank dated one day apart from the
// feed. Originals are now ANY row without the simplefin-sync tag; dates may differ
// by one day; and a NORMALIZED-DESCRIPTION match is required as the safety lock
// (two genuinely separate same-amount purchases carry different reference codes,
// e.g. distinct Coinbase order ids, so they can never pair).
const normDesc = (d) => (d || '').toUpperCase().replace(/[^A-Z0-9*]/g, '');
const dayNum = (s) => Math.floor(Date.parse(s) / 86400000);

const originals = all.filter((x) => !x.tags.includes('simplefin-sync'));
const syncRows = all.filter((x) => x.tags.includes('simplefin-sync'));

const toDelete = [];
let ambiguous = 0;
const claimedOriginals = new Set();
for (const x of syncRows) {
  const matches = originals.filter(
    (o) =>
      !claimedOriginals.has(o.txId) &&
      o.type === x.type &&
      String(o.acctId) === String(x.acctId) &&
      cents(o.amount) === cents(x.amount) &&
      Math.abs(dayNum(o.date) - dayNum(x.date)) <= 1 &&
      normDesc(o.desc) === normDesc(x.desc)
  );
  if (matches.length === 0) continue;
  if (matches.length > 1) {
    ambiguous += 1;
    console.log(`AMBIGUOUS (${matches.length} original candidates for sync tx${x.txId} ${x.desc.slice(0, 36)}) — NOT touched`);
    continue;
  }
  const c = matches[0];
  claimedOriginals.add(c.txId);
  console.log(`DUP: ${x.date} $${parseFloat(x.amount).toFixed(2)} ${x.acct}`);
  console.log(`    keep   original tx${c.txId} (${c.date}): ${c.desc.slice(0, 46)}`);
  console.log(`    delete sync     tx${x.txId} (${x.date}): ${x.desc.slice(0, 46)}`);
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
