// Fix the rule type-trigger bug the baseline audit caught — in TWO parts, because
// the first fix shipped its own bug:
//
// Part 1 (original): rules triggered on description_contains alone, so a $1
// "SP BLENKO ONLINE" PURCHASE was categorized Income. Fix: add a
// transaction_type=deposit trigger to deposit-only (Income/Refunds) rules.
//
// Part 2 (the fix's bug, caught when a Blenko PAYROLL deposit came out "Refunds"):
// those rules were strict=false, and Firefly fires a non-strict rule when ANY
// trigger matches — so the added type trigger made every Income/Refunds rule fire
// on EVERY deposit (last rule wins: paychecks became "Refunds"), and description
// matches still fired on withdrawals. Multi-trigger rules must be strict=true
// (ALL triggers must match).
//
//   node fix-rule-types.js          DRY RUN: list rules and misfires
//   node fix-rule-types.js apply    ensure type trigger + strict=true on
//                                   deposit-only rules; clear misfired withdrawals
//                                   (the daily model loop re-categorizes them); and
//                                   repair the known fallout deposits precisely.
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json', 'Content-Type': 'application/json' };
const apply = process.argv[2] === 'apply';
const DEPOSIT_ONLY = new Set(['Income', 'Refunds']);

async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: H });
  const b = await r.text();
  if (!r.ok) { const e = new Error(p + ' -> ' + r.status + ' ' + b.slice(0, 160)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

// 1. Find rules that set a deposit-only category but lack a transaction_type trigger.
const rules = [];
let page = 1;
for (;;) {
  const j = await fapi(`/rules?limit=50&page=${page}`);
  const d = j.data || [];
  if (!d.length) break;
  rules.push(...d);
  if (d.length < 50) break;
  page++;
}

// A deposit-only rule is correct only when BOTH hold: it has the type trigger AND
// it is strict (all triggers must match). Non-strict multi-trigger = OR = fires on
// every deposit via the type trigger and on withdrawals via the description.
const toFix = [];
for (const r of rules) {
  const a = r.attributes;
  const setsDepositOnly = (a.actions || []).some((x) => x.type === 'set_category' && DEPOSIT_ONLY.has(x.value));
  if (!setsDepositOnly) continue;
  const hasTypeTrigger = (a.triggers || []).some((x) => x.type === 'transaction_type');
  const isStrict = a.strict === true;
  if (!hasTypeTrigger || !isStrict) toFix.push({ r, addTrigger: !hasTypeTrigger, makeStrict: !isStrict });
}

console.log(`Rules total: ${rules.length} | deposit-only rules needing repair: ${toFix.length}`);
for (const { r, addTrigger, makeStrict } of toFix) console.log(`  ${r.id}  ${r.attributes.title}  [${[addTrigger && 'add type trigger', makeStrict && 'set strict'].filter(Boolean).join(', ')}]`);

// 2. The known misfire: the $1 SP BLENKO ONLINE withdrawal categorized Income.
const misfires = [];
page = 1;
for (;;) {
  const j = await fapi(`/transactions?type=withdrawal&limit=200&page=${page}`);
  const d = j.data || [];
  if (!d.length) break;
  for (const t of d) for (const s of t.attributes.transactions) {
    if (DEPOSIT_ONLY.has(s.category_name || '')) misfires.push({ txId: t.id, jId: s.transaction_journal_id, date: (s.date || '').slice(0, 10), amount: s.amount, desc: s.description, cat: s.category_name, tags: s.tags || [] });
  }
  if (d.length < 200) break;
  page++;
}
console.log(`\nWithdrawals wearing a deposit-only category (misfires): ${misfires.length}`);
for (const m of misfires) console.log(`  ${m.date} $${parseFloat(m.amount).toFixed(2)} ${m.desc.slice(0, 40)} [${m.cat}] -> cleared for the model loop`);

// 3. Known strict-bug fallout on DEPOSITS (created while the OR-rules were live).
// Precise match (description + exact cents), same discipline as every other repair.
const FALLOUT = [
  { desc: 'BLENKO GLASS CO PAYROLL', cents: 93008, cat: 'Income', keepSourceTag: 'income-source:blenko', note: 'paycheck mis-set to Refunds by the OR-rules' },
  { desc: 'AUTOMATIC STATEMENT CREDIT', cents: 3433, cat: 'Refunds', keepSourceTag: null, note: 'category fine; strip any stray income-source tags' },
];
const deposits = [];
page = 1;
for (;;) {
  const j = await fapi(`/transactions?type=deposit&limit=200&page=${page}`);
  const d = j.data || [];
  if (!d.length) break;
  for (const t of d) for (const s of t.attributes.transactions) deposits.push({ txId: t.id, jId: s.transaction_journal_id, date: (s.date || '').slice(0, 10), desc: s.description || '', cents: Math.round(parseFloat(s.amount) * 100), cat: s.category_name || '', tags: s.tags || [] });
  if (d.length < 200) break;
  page++;
}
const falloutWork = [];
for (const f of FALLOUT) {
  const hits = deposits.filter((x) => x.desc.toUpperCase().includes(f.desc) && x.cents === f.cents && x.date >= '2026-07-13');
  if (hits.length !== 1) { console.log(`fallout ${f.desc}: ${hits.length} matches; skipped`); continue; }
  falloutWork.push({ ...hits[0], ...f });
}
console.log(`\nFallout deposits to repair: ${falloutWork.length}`);
for (const w of falloutWork) console.log(`  ${w.date} $${(w.cents / 100).toFixed(2)} ${w.desc.slice(0, 36)} [${w.cat}] -> ${w.cat === w.cat && w.cat !== '' ? w.cat + ' (verify)' : ''}${w.note ? '  (' + w.note + ')' : ''}`);

if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); process.exit(0); }

// Apply: ensure BOTH the deposit type trigger and strict=true (full-body PUT).
let fixedRules = 0;
for (const { r, addTrigger } of toFix) {
  const a = r.attributes;
  const triggers = [
    ...(a.triggers || []).map((t) => ({ type: t.type, value: t.value, active: t.active !== false, stop_processing: t.stop_processing === true })),
    ...(addTrigger ? [{ type: 'transaction_type', value: 'deposit', active: true, stop_processing: false }] : []),
  ];
  const actions = (a.actions || []).map((x) => ({ type: x.type, value: x.value, active: x.active !== false, stop_processing: x.stop_processing === true }));
  const body = { title: a.title, rule_group_id: a.rule_group_id, trigger: a.trigger || 'store-journal', active: a.active !== false, strict: true, stop_processing: a.stop_processing === true, triggers, actions };
  try { await fapi(`/rules/${r.id}`, { method: 'PUT', body: JSON.stringify(body) }); fixedRules++; }
  catch (e) { console.log(`  rule ${r.id} fix failed: ${e.message}`); }
}
console.log(`\nFixed ${fixedRules}/${toFix.length} rules (type=deposit trigger + strict=true).`);

// Misfired withdrawals: clear the category and let the daily model loop
// re-categorize honestly, stripping any income-source tags the OR-rules added.
let fixedTx = 0;
for (const m of misfires) {
  const tags = m.tags.filter((t) => !t.startsWith('income-source:')).concat('rule-misfire-fixed');
  try {
    await fapi(`/transactions/${m.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(m.jId), category_name: null, tags: Array.from(new Set(tags)) }] }) });
    fixedTx++;
  } catch (e) { console.log(`  tx ${m.txId} fix failed: ${e.message}`); }
}
console.log(`Cleared ${fixedTx}/${misfires.length} misfired withdrawal(s) for the model loop.`);

// Fallout deposits: set the right category; strip income-source tags except the one
// that genuinely belongs.
let fixedDep = 0;
for (const w of falloutWork) {
  const tags = Array.from(new Set([
    ...w.tags.filter((t) => !t.startsWith('income-source:')),
    ...(w.keepSourceTag ? [w.keepSourceTag] : []),
    'rule-misfire-fixed',
  ]));
  try {
    await fapi(`/transactions/${w.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(w.jId), category_name: w.cat, tags }] }) });
    fixedDep++;
  } catch (e) { console.log(`  tx ${w.txId} fix failed: ${e.message}`); }
}
console.log(`Repaired ${fixedDep}/${falloutWork.length} fallout deposit(s).`);
