// Full-income-stream budgets via Firefly's native Budgets (prebuilt first, SPEC 3A).
// One auto-resetting monthly budget per consumption category plus a Fixed
// Obligations tracking bucket. Amounts were agreed 2026-07-18 from observed
// 6.5-month averages (shown side by side in the dry run so drift is visible at
// apply time). Assignment is handled by the daily budget-assignment pass
// (quality.runBudgetAssignPass: category -> budget, fills empty slots only) plus
// the dedicated Hobby merchant rules (setup-hobby-budget.js).
//
//   node setup-budgets.js          DRY RUN: observed vs proposed, writes nothing
//   node setup-budgets.js apply    create/update the budgets (auto-reset monthly)
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json', 'Content-Type': 'application/json' };
const apply = process.argv[2] === 'apply';

// name -> { amount, categories (for the observed-average display) }
const BUDGETS = [
  { name: 'Personal', amount: 1800, cats: ['Personal'] },
  { name: 'Dining', amount: 700, cats: ['Dining'] },
  { name: 'Utilities', amount: 650, cats: ['Utilities'] },
  { name: 'Groceries', amount: 450, cats: ['Groceries'] },
  { name: 'Healthcare', amount: 250, cats: ['Healthcare'] },
  { name: 'Entertainment', amount: 175, cats: ['Entertainment'] },
  { name: 'Software/SaaS', amount: 175, cats: ['Software/SaaS'] },
  { name: 'Transport', amount: 100, cats: ['Transport'] },
  { name: 'Housing', amount: 100, cats: ['Housing'] },
  // Fixed debt service ONLY (auto loan $593 + Synchrony ~$217; mortgage payment to be
  // added once its source account is identified). Assigned by the strict rules below,
  // NOT by category — the Debt Payment category also contains payoff strikes (~$7k/mo
  // observed during the paydown), which no fixed budget can represent.
  { name: 'Fixed Obligations', amount: 850, cats: [] },
  // Hobby ($150) is created by setup-hobby-budget.js; listed here read-only.
];

// Strict two-trigger rules assigning the known FIXED payments to Fixed Obligations.
const FIXED_RULES = [
  { kw: 'JPMORGAN CHASE EXT', note: 'auto loan $593.20/mo' },
  { kw: 'SYNCHRONY BANK', note: 'Synchrony $50/wk' },
];

async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: H });
  const b = await r.text();
  if (!r.ok) { const e = new Error(p + ' -> ' + r.status + ' ' + b.slice(0, 160)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

// Observed monthly average per category from the ledger (withdrawals, full history).
async function observedMonthly() {
  const byCat = new Map();
  let minDate = null, maxDate = null;
  let page = 1;
  for (;;) {
    const j = await fapi(`/transactions?type=withdrawal&limit=200&page=${page}`);
    const d = j.data || [];
    if (!d.length) break;
    for (const t of d) for (const s of t.attributes.transactions) {
      const cat = s.category_name || '';
      const date = (s.date || '').slice(0, 10);
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
      byCat.set(cat, (byCat.get(cat) || 0) + parseFloat(s.amount || 0));
    }
    if (d.length < 200) break;
    page++;
  }
  const months = Math.max(1, (Date.parse(maxDate) - Date.parse(minDate)) / (86400000 * 30.44));
  return { byCat, months };
}

async function main() {
  console.log(`Budgets — mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  const { byCat, months } = await observedMonthly();
  const existing = new Map(((await fapi('/budgets?limit=100')).data || []).map((b) => [b.attributes.name, b]));

  console.log('Budget'.padEnd(20) + 'observed/mo'.padStart(12) + 'proposed'.padStart(10) + '   status');
  let totalProposed = 0;
  for (const b of BUDGETS) {
    const obs = b.cats.reduce((n, c) => n + (byCat.get(c) || 0), 0) / months;
    totalProposed += b.amount;
    const ex = existing.get(b.name);
    console.log(b.name.padEnd(20) + ('$' + obs.toFixed(0)).padStart(12) + ('$' + b.amount).padStart(10) + '   ' + (ex ? 'exists -> update' : 'create'));
  }
  const hobby = existing.get('Hobby');
  console.log('Hobby'.padEnd(20) + ' (merchant-ruled)'.padStart(12) + '$150'.padStart(10) + '   ' + (hobby ? 'exists (managed separately)' : 'MISSING - run setup-hobby-budget.js'));
  console.log(`\nTotal budgeted (incl. Hobby): $${totalProposed + 150}/mo`);

  if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); return; }

  let done = 0;
  for (const b of BUDGETS) {
    const body = { name: b.name, active: true, auto_budget_type: 'reset', auto_budget_amount: String(b.amount), auto_budget_period: 'monthly' };
    try {
      const ex = existing.get(b.name);
      if (ex) await fapi(`/budgets/${ex.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await fapi('/budgets', { method: 'POST', body: JSON.stringify(body) });
      done += 1;
    } catch (e) { console.log(`  ${b.name} failed: ${e.message}`); }
  }

  // Fixed-payment rules (strict: description + type=withdrawal).
  const groups = await fapi('/rule-groups?limit=100');
  let gid = (groups.data || []).find((g) => g.attributes.title === 'AI Categorized')?.id;
  if (!gid) gid = (await fapi('/rule-groups', { method: 'POST', body: JSON.stringify({ title: 'AI Categorized', active: true }) })).data.id;
  const rules = [];
  let page = 1;
  for (;;) { const j = await fapi(`/rules?limit=50&page=${page}`); const d = j.data || []; if (!d.length) break; rules.push(...d); if (d.length < 50) break; page++; }
  let madeRules = 0;
  for (const f of FIXED_RULES) {
    const title = `AI: budget ${f.kw} -> Fixed Obligations`;
    if (rules.some((r) => r.attributes.title === title)) continue;
    const rule = {
      title, rule_group_id: gid, trigger: 'store-journal', active: true, strict: true, stop_processing: false,
      triggers: [
        { type: 'description_contains', value: f.kw, active: true, stop_processing: false },
        { type: 'transaction_type', value: 'withdrawal', active: true, stop_processing: false },
      ],
      actions: [{ type: 'set_budget', value: 'Fixed Obligations', active: true, stop_processing: false }],
    };
    try { await fapi('/rules', { method: 'POST', body: JSON.stringify(rule) }); madeRules++; }
    catch (e) { console.log(`  rule ${f.kw} failed: ${e.message}`); }
  }
  console.log(`\nApplied ${done}/${BUDGETS.length} budgets (auto-reset monthly) + ${madeRules} fixed-payment rules.`);
  console.log('The daily pass assigns categorized transactions from the current month onward (30-day backfill on first run).');
}

main().catch((e) => { console.error(e); process.exit(1); });
