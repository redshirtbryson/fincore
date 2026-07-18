// Apply the baseline-audit answers (2026-07-18): four precise one-off
// categorizations plus the Synchrony promo terms recorded on the account.
// Matched by description substring + exact amount, never a loose keyword.
//
//   node apply-audit-answers.js          DRY RUN
//   node apply-audit-answers.js apply
//
// Answers being encoded:
// - SALE ALEXANDRIA CROWE $410      -> Taxes + tag 'tax-prep-fee' (CPA filing fees;
//   tagged so authority-only tax sums can exclude professional fees)
// - GUILHERME LEVAND PAYPAL $148.50 -> Personal
// - CNB MOBILE DEPOSIT $168.42      -> Income (misc, no source)
// - CNB MOBILE DEPOSIT $74.00       -> Income (misc, no source)
// - Credit - Synchrony (Sleep): notes = deferred-interest promo terms (initial
//   $5,893.58 on 2025-11-01, expiry 2029-11-16). The debt engine (Phase 6) and any
//   human reading the account need this date visible.
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

const TARGETS = [
  { type: 'withdrawal', desc: 'ALEXANDRIA CROWE', cents: 41000, cat: 'Taxes', tag: 'tax-prep-fee', note: 'CPA tax-filing fees' },
  { type: 'withdrawal', desc: 'GUILHERME LEVAND', cents: 14850, cat: 'Personal', tag: null, note: 'personal PayPal purchase' },
  { type: 'deposit', desc: 'MOBILE DEPOSIT 2271442150', cents: 16842, cat: 'Income', tag: null, note: 'misc income' },
  { type: 'deposit', desc: 'MOBILE DEPOSIT 2244326402', cents: 7400, cat: 'Income', tag: null, note: 'misc income' },
];

const SYNCHRONY_ID = '16';
const SYNCHRONY_NOTES = [
  'DEFERRED-INTEREST PROMO: initial purchase $5,893.58 on 2025-11-01; 0% promo expires 2029-11-16.',
  'If not paid IN FULL by expiry, Synchrony back-charges interest from the purchase date on the full original amount (standard ~29.99% APR).',
  'Minimum pace to clear by expiry from a $4,000 balance (2026-07-18): ~$100/month. Recorded by fincore 2026-07-18.',
].join(' ');

async function pull(type) {
  const out = []; let page = 1;
  for (;;) {
    const j = await fapi(`/transactions?type=${type}&limit=200&page=${page}`); const d = j.data || [];
    if (!d.length) break;
    for (const t of d) for (const s of t.attributes.transactions) out.push({ txId: t.id, jId: s.transaction_journal_id, date: (s.date || '').slice(0, 10), desc: s.description || '', amtCents: cents(s.amount), cat: s.category_name || '', tags: s.tags || [] });
    if (d.length < 200) break; page++;
  }
  return out;
}

const byType = { withdrawal: await pull('withdrawal'), deposit: await pull('deposit') };
const work = [];
for (const t of TARGETS) {
  const hits = byType[t.type].filter((x) => x.desc.toUpperCase().includes(t.desc) && x.amtCents === t.cents);
  if (hits.length !== 1) { console.log(`${hits.length === 0 ? 'NO MATCH' : 'AMBIGUOUS(' + hits.length + ')'}: ${t.desc} @ $${(t.cents / 100).toFixed(2)} — skipped`); continue; }
  const h = hits[0];
  console.log(`  ${h.date}  $${(h.amtCents / 100).toFixed(2)}  ${h.desc.slice(0, 40)}  [${h.cat || '-'}] -> ${t.cat}${t.tag ? ' +' + t.tag : ''}  (${t.note})`);
  work.push({ ...h, ...t });
}
console.log(`${work.length}/${TARGETS.length} matched.`);
console.log(`Synchrony (Sleep) account ${SYNCHRONY_ID}: will set promo notes.`);

if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); process.exit(0); }

let done = 0;
for (const w of work) {
  const tags = Array.from(new Set([...w.tags, ...(w.tag ? [w.tag] : []), 'audit-answers-2026-07-18']));
  try {
    await fapi(`/transactions/${w.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(w.jId), category_name: w.cat, tags }] }) });
    done++;
  } catch (e) { console.log('set fail ' + w.txId + ': ' + e.message); }
}
// Account notes: fetch name first (Firefly's account PUT requires it), then update.
const acct = (await fapi('/accounts/' + SYNCHRONY_ID)).data.attributes;
await fapi('/accounts/' + SYNCHRONY_ID, { method: 'PUT', body: JSON.stringify({ name: acct.name, notes: SYNCHRONY_NOTES }) });
console.log(`Applied ${done}/${work.length} categorizations; Synchrony promo notes recorded.`);
