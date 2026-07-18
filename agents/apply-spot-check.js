// Apply the Personal spot-check rulings (2026-07-18):
//   1. Remodel costs -> Construction: big-box purchases (Lowes, Home Depot, Menards)
//      in the remodel window 2026-05-20..2026-06-30, currently categorized Personal,
//      move to Construction + property:current-home. Capital, not consumption — and
//      it drops Personal's observed baseline to where the $1,800 budget is realistic.
//   2. VENMO *ATRIX CARDS $200.85 -> Hobby budget (one-off card purchase; category
//      stays Personal, hobby spend is Personal + Hobby budget by convention).
//   3. eBay = hobby: standing strict rule (EBAY O -> Hobby budget) + July-forward
//      hobby merchants retro-assigned so the current month's Hobby bar is truthful.
//
//   node apply-spot-check.js          DRY RUN
//   node apply-spot-check.js apply
//
// Run BEFORE setup-budgets.js apply so the moved remodel rows never receive a
// Personal budget assignment.
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

const REMODEL_MERCHANTS = /LOWES|THE HOME DEPOT|MENARDS/i;
const REMODEL_START = '2026-05-20';
const REMODEL_END = '2026-06-30';
// PowerUp is NOT hobby — it is meal prep (ruling 2026-07-18) -> Groceries.
const HOBBY_MERCHANTS = /TCGPLAYER|POKEMON|WHATNOT|EBAY O|ATRIX CARDS/i;

const W = [];
let page = 1;
for (;;) {
  const j = await fapi(`/transactions?type=withdrawal&limit=200&page=${page}`);
  const d = j.data || [];
  if (!d.length) break;
  for (const t of d) for (const s of t.attributes.transactions) W.push({ txId: t.id, jId: s.transaction_journal_id, date: (s.date || '').slice(0, 10), amt: parseFloat(s.amount), desc: s.description || '', cat: s.category_name || '', budgetId: s.budget_id != null && s.budget_id !== '0' ? String(s.budget_id) : null, tags: s.tags || [] });
  if (d.length < 200) break;
  page++;
}

// 1. Remodel window moves.
const remodel = W.filter((x) => x.cat === 'Personal' && REMODEL_MERCHANTS.test(x.desc) && x.date >= REMODEL_START && x.date <= REMODEL_END);
const remodelTotal = remodel.reduce((n, x) => n + x.amt, 0);
console.log(`1. REMODEL -> Construction: ${remodel.length} txns, $${remodelTotal.toFixed(2)}`);
for (const x of remodel) console.log(`   ${x.date}  $${x.amt.toFixed(2).padStart(8)}  ${x.desc.slice(0, 44)}`);

// 1b. PowerUp = meal prep -> Groceries (all dates; currently Personal). The daily
// category->budget pass then assigns them the Groceries budget automatically.
const powerup = W.filter((x) => /POWERUP/i.test(x.desc) && x.cat !== 'Groceries');
console.log(`\n1b. POWERUP (meal prep) -> Groceries: ${powerup.length} txns, $${powerup.reduce((n, x) => n + x.amt, 0).toFixed(2)}`);

// 2+3. Hobby budget: ATRIX one-off + eBay history + July-forward hobby merchants.
const atrix = W.filter((x) => /ATRIX CARDS/i.test(x.desc) && cents(x.amt) === 20085);
const ebayHist = W.filter((x) => /EBAY O/i.test(x.desc) && x.cat === 'Personal');
const julyHobby = W.filter((x) => HOBBY_MERCHANTS.test(x.desc) && x.date >= '2026-07-01' && !x.budgetId);
const hobbyAssign = [...new Map([...atrix, ...ebayHist, ...julyHobby].map((x) => [x.jId, x])).values()];
console.log(`\n2+3. -> Hobby budget: ${hobbyAssign.length} txns ($${hobbyAssign.reduce((n, x) => n + x.amt, 0).toFixed(2)})`);
for (const x of hobbyAssign) console.log(`   ${x.date}  $${x.amt.toFixed(2).padStart(8)}  ${x.desc.slice(0, 44)}`);
console.log('   + standing strict rule: EBAY O (withdrawals) -> Hobby budget');

if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); process.exit(0); }

let moved = 0;
for (const x of remodel) {
  const tags = Array.from(new Set([...x.tags, 'property:current-home', 'construction-set']));
  try {
    await fapi(`/transactions/${x.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(x.jId), category_name: 'Construction', tags }] }) });
    moved++;
  } catch (e) { console.log(`   move fail ${x.txId}: ${e.message}`); }
}
console.log(`\n[1] ${moved}/${remodel.length} moved to Construction.`);

let pu = 0;
for (const x of powerup) {
  try {
    await fapi(`/transactions/${x.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(x.jId), category_name: 'Groceries' }] }) });
    pu++;
  } catch (e) { console.log(`   powerup fail ${x.txId}: ${e.message}`); }
}
// Repoint the seed category rule (POWERUP -> Personal) at Groceries so future
// meal-prep charges categorize correctly at arrival.
try {
  const allRules = [];
  let rp = 1;
  for (;;) { const j = await fapi(`/rules?limit=50&page=${rp}`); const d = j.data || []; if (!d.length) break; allRules.push(...d); if (d.length < 50) break; rp++; }
  const puRule = allRules.find((r) => /POWERUP/.test(r.attributes.title) && (r.attributes.actions || []).some((a) => a.type === 'set_category'));
  if (puRule) {
    const a = puRule.attributes;
    const body = {
      title: 'AI: POWERUP -> Groceries', rule_group_id: a.rule_group_id, trigger: a.trigger || 'store-journal',
      active: true, strict: a.strict === true, stop_processing: a.stop_processing === true,
      triggers: (a.triggers || []).map((t) => ({ type: t.type, value: t.value, active: t.active !== false, stop_processing: t.stop_processing === true })),
      actions: (a.actions || []).map((x) => (x.type === 'set_category' ? { ...x, value: 'Groceries' } : x)).map((x) => ({ type: x.type, value: x.value, active: x.active !== false, stop_processing: x.stop_processing === true })),
    };
    await fapi(`/rules/${puRule.id}`, { method: 'PUT', body: JSON.stringify(body) });
    console.log(`[1b] ${pu}/${powerup.length} PowerUp txns -> Groceries; category rule repointed.`);
  } else {
    console.log(`[1b] ${pu}/${powerup.length} PowerUp txns -> Groceries; no existing rule found (none repointed).`);
  }
} catch (e) { console.log(`[1b] rule repoint failed: ${e.message}`); }

// Remove a POWERUP -> Hobby budget rule if the earlier hobby setup created one.
try {
  const allRules2 = [];
  let rp2 = 1;
  for (;;) { const j = await fapi(`/rules?limit=50&page=${rp2}`); const d = j.data || []; if (!d.length) break; allRules2.push(...d); if (d.length < 50) break; rp2++; }
  const bad = allRules2.find((r) => r.attributes.title === 'AI: budget POWERUP -> Hobby');
  if (bad) { await fapi(`/rules/${bad.id}`, { method: 'DELETE' }); console.log('[1b] stale POWERUP hobby-budget rule deleted.'); }
} catch (e) { console.log(`[1b] hobby-rule cleanup failed: ${e.message}`); }

let assigned = 0;
for (const x of hobbyAssign) {
  try {
    await fapi(`/transactions/${x.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(x.jId), budget_name: 'Hobby' }] }) });
    assigned++;
  } catch (e) { console.log(`   assign fail ${x.txId}: ${e.message}`); }
}
console.log(`[2+3] ${assigned}/${hobbyAssign.length} assigned to Hobby budget.`);

// Standing eBay rule (strict two-trigger), idempotent by title.
const groups = await fapi('/rule-groups?limit=100');
let gid = (groups.data || []).find((g) => g.attributes.title === 'AI Categorized')?.id;
if (!gid) gid = (await fapi('/rule-groups', { method: 'POST', body: JSON.stringify({ title: 'AI Categorized', active: true }) })).data.id;
const rules = [];
page = 1;
for (;;) { const j = await fapi(`/rules?limit=50&page=${page}`); const d = j.data || []; if (!d.length) break; rules.push(...d); if (d.length < 50) break; page++; }
const title = 'AI: budget EBAY O -> Hobby';
if (!rules.some((r) => r.attributes.title === title)) {
  await fapi('/rules', { method: 'POST', body: JSON.stringify({
    title, rule_group_id: gid, trigger: 'store-journal', active: true, strict: true, stop_processing: false,
    triggers: [
      { type: 'description_contains', value: 'EBAY O', active: true, stop_processing: false },
      { type: 'transaction_type', value: 'withdrawal', active: true, stop_processing: false },
    ],
    actions: [{ type: 'set_budget', value: 'Hobby', active: true, stop_processing: false }],
  }) });
  console.log('eBay hobby rule created.');
} else console.log('eBay hobby rule already exists.');
