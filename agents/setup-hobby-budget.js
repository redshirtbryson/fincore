// Hobby allowance via Firefly's native Budgets feature (prebuilt first, SPEC 3A).
// Creates a "Hobby" budget that auto-resets to the monthly allowance, plus one
// strict rule per hobby merchant (description + transaction_type=withdrawal — the
// hardened two-trigger pattern from the 2026-07-18 audit) assigning their spend to
// the budget. Firefly's UI then shows the spent-vs-limit bar, and the daily
// heartbeat can read budget status with one API call (Phase 6).
//
//   node setup-hobby-budget.js          DRY RUN
//   node setup-hobby-budget.js apply    create the budget + rules
//
// Amount: HOBBY_BUDGET_USD (default 150) per month, auto-reset by Firefly.
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json', 'Content-Type': 'application/json' };
const apply = process.argv[2] === 'apply';
const AMOUNT = Number(process.env.HOBBY_BUDGET_USD) > 0 ? Number(process.env.HOBBY_BUDGET_USD) : 150;
const BUDGET_NAME = 'Hobby';
// The observed hobby merchants (card shop, auctions, marketplaces, direct).
const MERCHANTS = ['TCGPLAYER', 'POKEMON', 'WHATNOT']; // POWERUP is meal prep -> Groceries, not hobby

async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: H });
  const b = await r.text();
  if (!r.ok) { const e = new Error(p + ' -> ' + r.status + ' ' + b.slice(0, 160)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

async function main() {
  console.log(`Hobby budget — mode: ${apply ? 'APPLY' : 'DRY RUN'} | $${AMOUNT}/month\n`);

  const budgets = (await fapi('/budgets?limit=100')).data || [];
  const existing = budgets.find((b) => b.attributes.name === BUDGET_NAME);
  console.log(`Budget "${BUDGET_NAME}": ${existing ? 'exists (id ' + existing.id + '; will update the auto-budget amount)' : 'will be CREATED'}`);
  console.log(`  auto-budget: reset to $${AMOUNT} monthly (Firefly manages the period)`);

  const rules = [];
  let page = 1;
  for (;;) { const j = await fapi(`/rules?limit=50&page=${page}`); const d = j.data || []; if (!d.length) break; rules.push(...d); if (d.length < 50) break; page++; }
  const wanted = MERCHANTS.filter((m) => !rules.some((r) => r.attributes.title === `AI: budget ${m} -> ${BUDGET_NAME}`));
  console.log(`Rules to create (strict: description + type=withdrawal): ${wanted.length ? wanted.join(', ') : 'none (all exist)'}`);

  if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); return; }

  // Budget with auto-reset monthly allowance.
  const body = {
    name: BUDGET_NAME,
    active: true,
    auto_budget_type: 'reset',
    auto_budget_amount: String(AMOUNT),
    auto_budget_period: 'monthly',
  };
  let budgetId;
  if (existing) {
    await fapi(`/budgets/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) });
    budgetId = existing.id;
    console.log(`\n[1] budget updated (id ${budgetId}).`);
  } else {
    const created = await fapi('/budgets', { method: 'POST', body: JSON.stringify(body) });
    budgetId = created.data.id;
    console.log(`\n[1] budget created (id ${budgetId}).`);
  }

  // Rule group + one STRICT rule per merchant (both triggers must match).
  const groups = await fapi('/rule-groups?limit=100');
  let gid = (groups.data || []).find((g) => g.attributes.title === 'AI Categorized')?.id;
  if (!gid) gid = (await fapi('/rule-groups', { method: 'POST', body: JSON.stringify({ title: 'AI Categorized', active: true }) })).data.id;
  let made = 0;
  for (const m of wanted) {
    const rule = {
      title: `AI: budget ${m} -> ${BUDGET_NAME}`,
      rule_group_id: gid,
      trigger: 'store-journal',
      active: true,
      strict: true,
      stop_processing: false,
      triggers: [
        { type: 'description_contains', value: m, active: true, stop_processing: false },
        { type: 'transaction_type', value: 'withdrawal', active: true, stop_processing: false },
      ],
      actions: [{ type: 'set_budget', value: BUDGET_NAME, active: true, stop_processing: false }],
    };
    try { await fapi('/rules', { method: 'POST', body: JSON.stringify(rule) }); made++; }
    catch (e) { console.log(`  rule ${m} failed: ${e.message}`); }
  }
  console.log(`[2] ${made}/${wanted.length} budget rules created (strict two-trigger).`);
  console.log(`\nDone. Firefly shows the $${AMOUNT}/mo Hobby bar from the current period onward; new hobby spend auto-assigns.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
