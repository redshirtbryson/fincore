// One-time backlog re-categorization: TOP-LINE accuracy fixes only (Tier 1).
// Fixes what actually distorts the income/expense totals -- misfiled transfers, debt
// payments, and refunds -- and tags real income by source. It deliberately does NOT
// sub-categorize the long tail of real expenses (restaurants, retail, gas); that is
// the model categorizer's job (SPEC 3B: deterministic in code, model on top).
//
//   node recategorize-backlog.js         DRY RUN: show what would change
//   node recategorize-backlog.js apply   apply, and create Firefly rules so future
//                                        transactions of these shapes auto-classify
//
// Idempotent: a row already carrying the right category + the 'recat-2026-07-17' tag
// is skipped. Ledger text is untrusted; rules only ever select from the fixed set.
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const PAT = process.env.FIREFLY_III_PAT;
const apply = process.argv[2] === 'apply';
const RUN_TAG = 'recat-2026-07-17';

async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/json', 'Content-Type': 'application/json' } });
  const b = await r.text();
  if (!r.ok) { const e = new Error(r.status + ' ' + b.slice(0, 160)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

// A rule is { kw, cat, tag? }. kw is matched case-insensitively as a substring of the
// text (source_name preferred for deposits, else description; description for
// withdrawals). First match wins, so order specific-before-general.
// DEPOSIT rules: real income (Income + a source tag) first, then non-income (money-back
// -> Refunds, own-account movements -> Transfer).
const DEPOSIT_RULES = [
  { kw: 'BLENKO', cat: 'Income', tag: 'income-source:blenko' },
  { kw: 'WV CSP', cat: 'Income', tag: 'income-source:redshirt-cloud' },
  { kw: 'CSP LLC', cat: 'Income', tag: 'income-source:redshirt-cloud' },
  { kw: 'MOBILE CHECK DEPOSIT', cat: 'Income' },        // earned income, source unspecified
  { kw: 'INTEREST PAYMENT', cat: 'Income' },            // bank interest (trivial)
  // Not income -> Transfer (neutral; excluded from both income and spend):
  // Money BACK, not income and not a transfer -> Refunds:
  { kw: 'RETURN', cat: 'Refunds' },                     // merchant refunds/returns
  { kw: 'STATEMENT CREDIT', cat: 'Refunds' },           // card credits/rewards
  { kw: 'MENARDS', cat: 'Refunds' }, { kw: 'TARGET', cat: 'Refunds' },
  { kw: 'AUTOZONE', cat: 'Refunds' }, { kw: 'EBAY', cat: 'Refunds' },
  { kw: 'AMZNPHARMA', cat: 'Refunds' }, { kw: 'TCGPLAYER', cat: 'Refunds' },
  // Genuine internal movements into an own account -> Transfer (neutral):
  { kw: 'CASH APP', cat: 'Transfer' },                  // money from self
  { kw: 'ONLINE TFR HUNTINGTON', cat: 'Transfer' },     // CNB side of a Huntington->CNB transfer
  { kw: 'TRANSFER FROM', cat: 'Transfer' },             // internal transfer into an own account
];
// WITHDRAWAL rules: structural only. Real internal movements out of the spend total,
// tax payments, plus a known business pass-through (see FACEBK).
const WITHDRAWAL_RULES = [
  { kw: 'EXT TRANSFER FROM HUNTINGTON', cat: 'Transfer' }, // -> CNB Joint (own account)
  { kw: 'JPMORGAN CHASE EXT', cat: 'Debt Payment' },       // $593.20/mo auto-loan payment
  { kw: 'PAYPAL INST XFER', cat: 'Transfer' },
  { kw: 'APPLE CASH', cat: 'Transfer' },
  // Tax payments to federal/state authorities -> Taxes (distinct; feeds the set-aside).
  { kw: 'USATAXPYMT', cat: 'Taxes' },                     // IRS federal
  { kw: 'WVTAXPAY', cat: 'Taxes' },                       // WV state
  { kw: 'WVTREASURY', cat: 'Taxes' },                     // WV treasury
  // Meta ad spend billed to the personal card by accident, reimbursed via Redshirt
  // disbursements: a business pass-through, not personal spend. Net-worth-neutral.
  { kw: 'FACEBK', cat: 'Business Expense', tag: 'business-reimbursed' },
];

function match(rules, text) {
  const t = (text || '').toUpperCase();
  for (const r of rules) if (t.includes(r.kw)) return r;
  return null;
}

async function pull(type) {
  const out = [];
  let page = 1;
  for (;;) {
    const j = await fapi(`/transactions?type=${type}&limit=200&page=${page}`);
    const d = j.data || [];
    if (!d.length) break;
    for (const t of d) for (const s of t.attributes.transactions) {
      out.push({ txId: t.id, jId: s.transaction_journal_id, type, desc: s.description || '', src: s.source_name || '', cat: s.category_name || '', tags: s.tags || [] });
    }
    if (d.length < 200) break;
    page++;
  }
  return out;
}

const work = [];
const tally = {};
for (const [type, rules, keyText] of [['deposit', DEPOSIT_RULES, (r) => (r.src && r.src !== '(no name)' ? r.src : r.desc)], ['withdrawal', WITHDRAWAL_RULES, (r) => r.desc]]) {
  for (const row of await pull(type)) {
    const hit = match(rules, keyText(row));
    if (!hit) continue;
    const wantTags = hit.tag ? [hit.tag] : [];
    const already = row.cat === hit.cat && row.tags.includes(RUN_TAG) && wantTags.every((t) => row.tags.includes(t));
    if (already) continue;
    work.push({ ...row, newCat: hit.cat, addTags: [RUN_TAG, ...wantTags] });
    const k = type + ':' + hit.cat + (hit.tag ? ' (' + hit.tag + ')' : '');
    tally[k] = (tally[k] || 0) + 1;
  }
}

console.log(`Would update ${work.length} transactions:`);
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(4) + '  ' + k);

if (!apply) { console.log('\nDry run. Re-run with "apply".'); process.exit(0); }

// Firefly rules so FUTURE transactions of these shapes auto-classify.
const groups = await fapi('/rule-groups?limit=100');
let gid = (groups.data || []).find((g) => g.attributes.title === 'AI Categorized')?.id;
if (!gid) gid = (await fapi('/rule-groups', { method: 'POST', body: JSON.stringify({ title: 'AI Categorized', active: true }) })).data.id;
for (const [rules, isDep] of [[DEPOSIT_RULES, true], [WITHDRAWAL_RULES, false]]) {
  for (const r of rules) {
    const actions = [{ type: 'set_category', value: r.cat, order: 1, active: true, stop_processing: false }];
    if (r.tag) actions.push({ type: 'add_tag', value: r.tag, order: 2, active: true, stop_processing: false });
    const body = { title: `AI: ${isDep ? 'dep' : 'wdl'} ${r.kw} -> ${r.cat}`.slice(0, 100), rule_group_id: gid, trigger: 'store-journal', active: true, strict: false, stop_processing: false,
      triggers: [{ type: 'description_contains', value: r.kw, order: 1, active: true, stop_processing: false }], actions };
    try { await fapi('/rules', { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { if (!(e.status === 422 && /already in use/i.test(e.message))) console.log('rule fail ' + r.kw + ': ' + e.message); }
  }
}

// Apply to the backlog.
let done = 0;
for (const w of work) {
  const tags = Array.from(new Set([...w.tags, ...w.addTags]));
  try {
    await fapi(`/transactions/${w.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(w.jId), category_name: w.newCat, tags }] }) });
    done++;
  } catch (e) { console.log('set fail ' + w.txId + ': ' + e.message); }
}
console.log(`\nApplied: ${done}/${work.length} transactions updated; Firefly rules upserted for future auto-classification.`);
