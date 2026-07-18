// Fix the rule type-trigger bug the baseline audit caught: every Firefly rule we
// created triggers on description_contains ALONE, with no transaction-type
// restriction. Evidence: a $1 "SP BLENKO ONLINE" PURCHASE was categorized Income by
// the BLENKO rule. Same flaw means a future Target/Menards purchase would be
// categorized "Refunds". Deposit-shaped categories must only ever fire on deposits.
//
//   node fix-rule-types.js          DRY RUN: list rules that would change
//   node fix-rule-types.js apply    add a transaction_type=deposit trigger to every
//                                   rule whose action sets Income or Refunds, and
//                                   re-categorize the known misfire ($1 SP BLENKO
//                                   ONLINE withdrawal -> Personal).
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

const toFix = [];
for (const r of rules) {
  const a = r.attributes;
  const setsDepositOnly = (a.actions || []).some((x) => x.type === 'set_category' && DEPOSIT_ONLY.has(x.value));
  const hasTypeTrigger = (a.triggers || []).some((x) => x.type === 'transaction_type');
  if (setsDepositOnly && !hasTypeTrigger) toFix.push(r);
}

console.log(`Rules total: ${rules.length} | setting Income/Refunds without a type trigger: ${toFix.length}`);
for (const r of toFix) console.log(`  ${r.id}  ${r.attributes.title}`);

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
for (const m of misfires) console.log(`  ${m.date} $${parseFloat(m.amount).toFixed(2)} ${m.desc.slice(0, 40)} [${m.cat}] -> Personal`);

if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); process.exit(0); }

// Apply: add the deposit type trigger to each flagged rule (full-body PUT).
let fixedRules = 0;
for (const r of toFix) {
  const a = r.attributes;
  const triggers = [
    ...(a.triggers || []).map((t) => ({ type: t.type, value: t.value, active: t.active !== false, stop_processing: t.stop_processing === true })),
    { type: 'transaction_type', value: 'deposit', active: true, stop_processing: false },
  ];
  const actions = (a.actions || []).map((x) => ({ type: x.type, value: x.value, active: x.active !== false, stop_processing: x.stop_processing === true }));
  const body = { title: a.title, rule_group_id: a.rule_group_id, trigger: a.trigger || 'store-journal', active: a.active !== false, strict: a.strict === true, stop_processing: a.stop_processing === true, triggers, actions };
  try { await fapi(`/rules/${r.id}`, { method: 'PUT', body: JSON.stringify(body) }); fixedRules++; }
  catch (e) { console.log(`  rule ${r.id} fix failed: ${e.message}`); }
}
console.log(`\nFixed ${fixedRules}/${toFix.length} rules (deposit-only categories now require type=deposit).`);

let fixedTx = 0;
for (const m of misfires) {
  try {
    await fapi(`/transactions/${m.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(m.jId), category_name: 'Personal', tags: Array.from(new Set([...m.tags, 'rule-misfire-fixed'])) }] }) });
    fixedTx++;
  } catch (e) { console.log(`  tx ${m.txId} fix failed: ${e.message}`); }
}
console.log(`Re-categorized ${fixedTx}/${misfires.length} misfired withdrawal(s) -> Personal.`);
