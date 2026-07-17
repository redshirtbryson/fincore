// One-time cleanup: collapse historical internal-transfer leg-pairs into real
// Firefly transfers. The CSV backfill and the pre-fix sync ingested each internal
// movement (a checking-to-savings transfer, a credit-card payment) as two
// independent legs: a withdrawal into an expense account and a deposit out of a
// revenue account. Left that way the deposit leg reads as income and pollutes the
// revenue view, and the withdrawal leg reads as an expense.
//
//   node cleanup-transfers.js            DRY RUN: list every pair it would convert
//   node cleanup-transfers.js apply      convert them (delete deposit leg, convert
//                                        the withdrawal leg in place to a transfer)
//   node cleanup-transfers.js apply 1    convert only the first N pairs (a live test:
//                                        do one, eyeball it in Firefly, then run the rest)
//
// Same safety machinery as the daily matcher (lib/quality.js): the conversion, the
// autonomy verdict, and the multi-split guard are the SAME shared functions, so this
// script and the daily pass can never diverge. A pair is auto-listed for conversion
// only when it is unique on both sides (matchTransfers), its DEPOSIT leg names an
// internal movement, both legs are category-clean, both own-account ids resolve, and
// neither leg is multi-split. Equal-amount pairs that fail those tests are printed
// separately for a human, never converted. The forward matcher now does this
// automatically, so this is a backfill fixup; it is idempotent (a converted leg is no
// longer a withdrawal, so a re-run is a no-op).
//
// It also converts legacy `transfer-match:` tagged pairs from the earlier tag-only
// scheme (which labeled but never collapsed them, so they still pollute income).
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { matchTransfers, parseAmount } from './lib/matching.js';
import { autoConvertVerdict, convertPairToTransfer, multiSplitTxIds } from './lib/quality.js';
import { openStore } from './lib/store.js';

const LOOKBACK_DAYS = Number(process.env.CLEANUP_LOOKBACK_DAYS) > 0 ? Number(process.env.CLEANUP_LOOKBACK_DAYS) : 400;
const LEGACY_TAG_PREFIX = 'transfer-match:';

function pairLine(m) {
  const a = parseAmount(m.withdrawal.amount);
  return (
    `$${a?.toFixed(2) ?? m.withdrawal.amount}  ${m.withdrawal.date}  ` +
    `${m.withdrawal.account} -> ${m.deposit.account}  ` +
    `| W: ${m.withdrawal.description} | D: ${m.deposit.description}`
  );
}

// Reconstruct pairs the old tag-only scheme marked but never collapsed. The tag
// encodes both journal ids, so pairing is exact; we only need both legs present in
// the window and identifiable as one withdrawal + one deposit.
function legacyTaggedPairs(items) {
  const byTag = new Map();
  for (const t of items) {
    for (const tag of t.tags || []) {
      if (!tag.startsWith(LEGACY_TAG_PREFIX)) continue;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(t);
    }
  }
  const pairs = [];
  const incomplete = [];
  for (const [tag, legs] of byTag) {
    const w = legs.find((l) => l.type === 'withdrawal');
    const d = legs.find((l) => l.type === 'deposit');
    if (w && d && legs.length === 2) pairs.push({ tag, withdrawal: w, deposit: d, dateDelta: 0 });
    else incomplete.push({ tag, count: legs.length });
  }
  return { pairs, incomplete };
}

async function main() {
  const apply = process.argv[2] === 'apply';
  // Optional cap on how many pairs to convert this run, so the first pair can be
  // converted alone and eyeballed in Firefly before committing to the whole batch.
  const limit = Number.isInteger(Number(process.argv[3])) && Number(process.argv[3]) > 0 ? Number(process.argv[3]) : Infinity;

  const { items, truncated } = await firefly.getRecentTransactions({
    lookbackDays: LOOKBACK_DAYS,
    capPerType: 2000,
  });
  if (truncated) {
    console.error('Fetch truncated at the cap; uniqueness cannot be trusted. Raise capPerType and re-run.');
    process.exit(1);
  }
  const withdrawals = items.filter((t) => t.type === 'withdrawal');
  const deposits = items.filter((t) => t.type === 'deposit');
  const multiSplit = multiSplitTxIds(items);
  const liabilityIds = new Set((await firefly.getAccounts('liabilities')).map((a) => String(a.id)));

  const { matches, ambiguous, flags } = matchTransfers(withdrawals, deposits);
  for (const f of flags) console.log(`flag: ${f}`);

  const convertible = [];
  const skipped = []; // { m, reason }
  for (const m of matches) {
    const v = autoConvertVerdict(m, { multiSplit, liabilityIds });
    if (v.ok) convertible.push(m);
    else skipped.push({ m, reason: v.reason });
  }

  // Legacy tag-only pairs: the tag is stronger evidence than a description keyword, so
  // they bypass the description gate, but still must be single-split with resolved ids.
  const { pairs: legacyAll, incomplete: legacyIncomplete } = legacyTaggedPairs(items);
  const legacy = [];
  const legacySkipped = [];
  for (const p of legacyAll) {
    if (!p.withdrawal.accountId || !p.deposit.accountId) { legacySkipped.push({ ...p, reason: 'unresolved ids' }); continue; }
    if (multiSplit.has(p.withdrawal.tx_id) || multiSplit.has(p.deposit.tx_id)) { legacySkipped.push({ ...p, reason: 'multi-split' }); continue; }
    legacy.push(p);
  }

  console.log(`\nTransactions in window: ${items.length} (${withdrawals.length} withdrawals, ${deposits.length} deposits)`);
  console.log(`Unique transfer pairs matched: ${matches.length}`);
  console.log(`  will convert: ${convertible.length}`);
  console.log(`  skipped (fail the auto-convert gate): ${skipped.length}`);
  console.log(`Ambiguous (multiple candidates, never auto-touched): ${ambiguous.length}`);
  console.log(`Legacy transfer-match tagged pairs: ${legacyAll.length} (convert ${legacy.length}, skip ${legacySkipped.length}, incomplete ${legacyIncomplete.length})`);

  console.log('\n== WOULD CONVERT (structural) ==');
  for (const m of convertible) console.log('  ' + pairLine(m));
  if (legacy.length) {
    console.log('\n== WOULD CONVERT (legacy transfer-match tag) ==');
    for (const p of legacy) console.log(`  [${p.tag}] ` + pairLine(p));
  }
  if (skipped.length) {
    console.log('\n== SKIPPED equal-amount pairs (review by hand) ==');
    for (const { m, reason } of skipped) console.log(`  (${reason}) ` + pairLine(m));
  }
  if (legacySkipped.length) {
    console.log('\n== SKIPPED legacy tagged pairs ==');
    for (const p of legacySkipped) console.log(`  [${p.tag}] (${p.reason}) ` + pairLine(p));
  }
  if (legacyIncomplete.length) {
    console.log('\n== legacy tags with a leg outside the window (manual) ==');
    for (const p of legacyIncomplete) console.log(`  [${p.tag}] ${p.count} leg(s) in window`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with "apply" to convert the pairs under WOULD CONVERT.');
    return;
  }

  const batch = [...convertible, ...legacy].slice(0, limit);
  if (batch.length < convertible.length + legacy.length) {
    console.log(`\nLimiting this run to the first ${batch.length} of ${convertible.length + legacy.length} pairs.`);
  }
  const db = openStore();
  let done = 0;
  for (const m of batch) {
    try {
      await convertPairToTransfer(db, m, { actor: 'cleanup-transfers' });
      done += 1;
    } catch (e) {
      console.error(`FAILED ${pairLine(m)}: ${e.message} -- see the audit log / notification queue; check by hand`);
    }
  }
  db.close();
  console.log(`\nConverted ${done}/${batch.length} pairs this run (${convertible.length + legacy.length} total eligible).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
