// Onboarding conversation (SPEC 10.4), CLI edition. A guided, rerunnable wizard
// that seeds memory, configures the system, and locks the day-one baseline.
// Deliberately deterministic: structured prompts, no model in the loop. The
// Phase 12 assistant can rerun the same steps conversationally later.
// Paystub PDF parsing is Phase 5; step 2 here takes manual template entry.
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as firefly from './lib/firefly.js';
import {
  openStore,
  auditedWrite,
  reversalHandleFor,
  baselineState,
  lockBaseline,
  correctBaseline,
  getPref,
  setPrefAudited,
  setMeta,
  latestPaystub,
} from './lib/store.js';
import { computeOutcomes, formatOutcome } from './lib/outcomes.js';

const ACTOR = 'onboarding';
const rl = readline.createInterface({ input: stdin, output: stdout });

// --- prompt helpers ---

async function ask(q, def = '') {
  const suffix = def !== '' && def !== null && def !== undefined ? ` [${def}]` : '';
  const a = (await rl.question(`${q}${suffix}: `)).trim();
  return a === '' ? String(def ?? '') : a;
}

async function askNumber(q, def = null) {
  for (;;) {
    const a = await ask(q, def === null ? '' : def);
    if (a === '') return null;
    const n = Number(a.replace(/[$,]/g, ''));
    if (Number.isFinite(n)) return n;
    console.log('  Enter a number (or leave blank to skip).');
  }
}

async function askChoice(q, choices, def) {
  for (;;) {
    const a = (await ask(`${q} (${choices.join('/')})`, def)).toLowerCase();
    if (choices.includes(a)) return a;
    console.log(`  Pick one of: ${choices.join(', ')}`);
  }
}

async function askYesNo(q, def = false) {
  const a = await askChoice(q, ['y', 'n'], def ? 'y' : 'n');
  return a === 'y';
}

function heading(n, title) {
  console.log(`\n=== Step ${n}: ${title} ===`);
}

// --- steps ---

async function stepIncomeSources(db) {
  heading(1, 'Income sources and tax treatment');
  console.log('Personal scope only: these are sources that pay YOU, not businesses fincore accounts for.');

  const defaults = [
    { name: 'Blenko', treatment: 'w2' },
    { name: 'Redshirt Cloud', treatment: 'self_employment' },
    { name: 'Neptune Political', treatment: 'self_employment' },
  ];
  const existing = new Map(db.prepare('SELECT * FROM income_sources').all().map((r) => [r.name, r]));
  const upsert = db.prepare(
    `INSERT INTO income_sources (name, treatment, cadence, declared_monthly_gross, withheld, updated)
     VALUES (@name, @treatment, @cadence, @declared, @withheld, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET treatment = @treatment, cadence = @cadence,
       declared_monthly_gross = @declared, withheld = @withheld, updated = datetime('now')`
  );

  for (const d of defaults) {
    const row = existing.get(d.name);
    console.log(`\n${d.name}`);
    const treatment = await askChoice('  Treatment', ['w2', 'self_employment'], row?.treatment ?? d.treatment);
    const cadence = await askChoice(
      '  Pay cadence',
      ['weekly', 'biweekly', 'semimonthly', 'monthly', 'irregular'],
      row?.cadence ?? (treatment === 'w2' ? 'biweekly' : 'irregular')
    );
    const declared = await askNumber('  Rough gross per MONTH (used until 12 months of history exist)', row?.declared_monthly_gross ?? null);
    const withheld = treatment === 'w2' ? 1 : 0;

    const after = { treatment, cadence, declaredMonthlyGross: declared, withheld };
    auditedWrite(
      db,
      {
        actor: ACTOR,
        action: 'income_sources.upsert',
        target: `income_sources:${d.name}`,
        before: row ?? null,
        after,
        reversalHandle: reversalHandleFor('income_sources', d.name, row ?? null),
      },
      () => upsert.run({ name: d.name, treatment, cadence, declared, withheld })
    );
  }
}

async function stepPaystub(db) {
  heading(2, 'Paystub template (W-2 sources)');
  console.log('PDF upload and parsing arrives in Phase 5. For now the template can be typed in');
  console.log('from a current paystub so gross-to-net and DTI use real figures.');

  const w2s = db.prepare("SELECT name FROM income_sources WHERE treatment = 'w2' AND active = 1").all();
  const insert = db.prepare(
    `INSERT INTO paystubs (source, effective_from, pay_cadence, gross, federal_tax, state_tax, local_tax,
                           fica_ss, fica_medicare, healthcare_premium, retirement_contribution, net_pay)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const { name } of w2s) {
    const current = latestPaystub(db, name);
    if (current) {
      console.log(`\n${name}: template on file (gross ${current.gross} ${current.pay_cadence}, effective ${current.effective_from}).`);
      if (!(await askYesNo('  Replace it with a new one?', false))) continue;
    } else if (!(await askYesNo(`\n${name}: enter a paystub template now?`, true))) {
      continue;
    }

    const cadence = await askChoice('  Pay cadence for this stub', ['weekly', 'biweekly', 'semimonthly', 'monthly'], 'biweekly');
    const gross = await askNumber('  Gross per paycheck');
    if (gross === null) {
      console.log('  Skipped (no gross).');
      continue;
    }
    const federal = await askNumber('  Federal tax per check (blank to skip)');
    const state = await askNumber('  State tax per check (blank to skip)');
    const local = await askNumber('  Local tax per check (blank to skip)');
    const ss = await askNumber('  Social Security per check (blank to skip)');
    const medicare = await askNumber('  Medicare per check (blank to skip)');
    const health = await askNumber('  Healthcare premium per check (blank to skip)');
    const retirement = await askNumber('  Retirement contribution per check (blank to skip)');
    const net = await askNumber('  Net pay per check (blank to skip)');

    auditedWrite(
      db,
      {
        actor: ACTOR,
        action: 'paystubs.insert',
        target: `paystubs:${name}`,
        before: current,
        after: { cadence, gross, net },
        // A new template supersedes; reversal is restoring the prior one as current.
        reversalHandle: reversalHandleFor('paystubs', name, current),
      },
      () => insert.run(name, firefly.nyDateStr(), cadence, gross, federal, state, local, ss, medicare, health, retirement, net)
    );
  }
}

async function fetchAccountsSafe() {
  try {
    const [assets, liabilities] = await Promise.all([
      firefly.getAccounts('asset'),
      firefly.getAccounts('liabilities'),
    ]);
    return { assets, liabilities };
  } catch (e) {
    console.log(`\nCould not reach Firefly (${e.message}).`);
    console.log('Steps 3, 4, and the baseline need it; fix .env / the stack and rerun.');
    return null;
  }
}

async function stepAccounts(accounts) {
  heading(3, 'Accounts');
  console.log('From Firefly (assets and liabilities). Investment/retirement accounts should NOT');
  console.log('be here: Schwab owns those in net worth. Off-feed assets (cash, PayPal/Venmo,');
  console.log('crypto, the Pokemon collection) belong in Firefly as manual asset accounts.');
  console.log('');
  for (const a of [...accounts.assets, ...accounts.liabilities]) {
    const bal = Number.isFinite(a.currentBalance) ? a.currentBalance.toFixed(2) : 'NO BALANCE';
    const skip = a.includeNetWorth === false ? ' [excluded from net worth]' : '';
    const inactive = a.active === false ? ' [inactive]' : '';
    console.log(`  ${a.type === 'asset' ? 'A' : 'L'}  ${a.name}: ${bal} ${a.currencyCode}${skip}${inactive}`);
  }
  console.log('');
  if (!(await askYesNo('Is every account that should count present (add missing ones in Firefly, then rerun)?', true))) {
    console.log('Rerun this wizard after adding accounts in Firefly. Continuing with what exists.');
  }
}

function deactivateObligation(db, row, reason) {
  auditedWrite(
    db,
    {
      actor: ACTOR,
      action: 'obligations.deactivate',
      target: `obligations:${row.name}`,
      before: row,
      after: { active: 0, reason },
      reversalHandle: reversalHandleFor('obligations', row.name, row),
    },
    () => db.prepare("UPDATE obligations SET active = 0, updated = datetime('now') WHERE id = ?").run(row.id)
  );
}

function rekindObligation(db, row, kind) {
  auditedWrite(
    db,
    {
      actor: ACTOR,
      action: 'obligations.rekind',
      target: `obligations:${row.name}`,
      before: row,
      after: { kind },
      reversalHandle: reversalHandleFor('obligations', row.name, row),
    },
    () => db.prepare("UPDATE obligations SET kind = ?, updated = datetime('now') WHERE id = ?").run(kind, row.id)
  );
}

async function stepDebts(db, accounts) {
  heading(4, 'Debts and monthly obligations');
  console.log('Firefly holds each liability and its APR; minimum payments live in fincore.db');
  console.log('(Firefly has no native field for them). These feed the DTI numerator directly.');

  const getOb = db.prepare('SELECT * FROM obligations WHERE lower(name) = lower(?)');
  const upsertOb = db.prepare(
    `INSERT INTO obligations (name, kind, monthly_amount, firefly_account_id, active, updated)
     VALUES (@name, @kind, @amount, @accountId, 1, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET kind = @kind, monthly_amount = @amount,
       firefly_account_id = @accountId, active = 1, updated = datetime('now')`
  );
  const activeLiabilities = accounts.liabilities.filter((a) => a.active !== false);

  for (const a of activeLiabilities) {
    console.log(`\n${a.name} (balance ${Number.isFinite(a.currentBalance) ? a.currentBalance.toFixed(2) : 'unknown'}, APR ${a.interest ?? 'NOT SET in Firefly'})`);
    if (a.interest === null) console.log('  Set the APR on this liability in Firefly; the debt engine needs it.');
    const row = getOb.get(a.name);
    const amount = await askNumber('  Monthly minimum payment', row?.monthly_amount ?? null);
    if (amount === null) {
      console.log('  Skipped; DTI will be missing this debt until it is set.');
      continue;
    }
    const kind = row?.kind === 'housing' ? 'housing' : 'debt_minimum';
    auditedWrite(
      db,
      {
        actor: ACTOR,
        action: 'obligations.upsert',
        target: `obligations:${a.name}`,
        before: row ?? null,
        after: { kind, monthlyAmount: amount },
        reversalHandle: reversalHandleFor('obligations', a.name, row ?? null),
      },
      () => upsertOb.run({ name: a.name, kind, amount, accountId: a.id })
    );
  }

  // Reconcile stranded rows: an obligation tied to a Firefly account that no longer
  // exists (renamed, paid off, closed) would otherwise inflate DTI forever.
  const liabilityIds = new Set(activeLiabilities.map((a) => a.id));
  const stranded = db
    .prepare('SELECT * FROM obligations WHERE active = 1 AND firefly_account_id IS NOT NULL')
    .all()
    .filter((o) => !liabilityIds.has(o.firefly_account_id));
  for (const o of stranded) {
    console.log(`\n"${o.name}" ($${o.monthly_amount}/month) no longer matches any Firefly liability (renamed, paid off, or closed).`);
    if (await askYesNo('  Deactivate it so DTI stops counting it?', true)) {
      deactivateObligation(db, o, 'no matching Firefly liability');
    }
  }

  // Housing (back-end DTI includes it). Switching situations cleans up the old shape
  // so housing is never double-counted.
  console.log('\nHousing (back-end DTI includes it).');
  const situation = await askChoice('Housing situation', ['rent', 'mortgage', 'none'], getPref(db, 'housing_situation') ?? 'rent');
  setPrefAudited(db, 'housing_situation', situation, ACTOR);

  const rentRow = getOb.get('Rent');
  const accountLinkedHousing = db
    .prepare("SELECT * FROM obligations WHERE active = 1 AND kind = 'housing' AND firefly_account_id IS NOT NULL")
    .all();

  if (situation === 'rent') {
    for (const row of accountLinkedHousing) rekindObligation(db, row, 'debt_minimum');
    const rent = await askNumber('Monthly rent', rentRow?.monthly_amount ?? null);
    if (rent !== null) {
      auditedWrite(
        db,
        {
          actor: ACTOR,
          action: 'obligations.upsert',
          target: 'obligations:Rent',
          before: rentRow ?? null,
          after: { kind: 'housing', monthlyAmount: rent },
          reversalHandle: reversalHandleFor('obligations', 'Rent', rentRow ?? null),
        },
        () => upsertOb.run({ name: 'Rent', kind: 'housing', amount: rent, accountId: null })
      );
    }
  } else if (situation === 'mortgage') {
    if (rentRow && rentRow.active === 1) deactivateObligation(db, rentRow, 'switched to mortgage');
    const name = await ask('Which liability above is the mortgage (name)');
    const row = name ? getOb.get(name) : null;
    if (row) {
      rekindObligation(db, row, 'housing');
    } else {
      console.log('  No obligation by that name; enter its minimum in the debt list above on a rerun.');
    }
  } else {
    if (rentRow && rentRow.active === 1) deactivateObligation(db, rentRow, 'housing situation: none');
    for (const row of accountLinkedHousing) rekindObligation(db, row, 'debt_minimum');
  }
}

async function stepGoals(db) {
  heading(5, 'Goals (North Star)');
  const existing = db.prepare("SELECT * FROM goals WHERE status = 'active'").all();
  if (existing.length) {
    console.log('Active goals:');
    for (const g of existing) console.log(`  - ${g.name}: ${g.target_amount ?? '?'} by ${g.target_date ?? '?'} (priority ${g.priority ?? '-'})`);
  }
  const insert = db.prepare('INSERT INTO goals (name, target_amount, target_date, priority) VALUES (?, ?, ?, ?)');
  while (await askYesNo('Add a goal?', existing.length === 0)) {
    const name = await ask('  Goal name');
    if (!name) break;
    const target = await askNumber('  Target amount');
    const date = await ask('  Target date (YYYY-MM-DD, blank if none)');
    const priority = await askNumber('  Priority (1 = highest)', existing.length + 1);
    auditedWrite(
      db,
      {
        actor: ACTOR,
        action: 'goals.insert',
        target: `goals:${name}`,
        after: { targetAmount: target, targetDate: date || null, priority },
        reversalHandle: reversalHandleFor('goals', name, null),
      },
      () => insert.run(name, target, date || null, priority)
    );
    console.log('  Added. Map it to a Firefly piggy bank when convenient.');
  }
}

async function stepConstraints(db) {
  heading(6, 'Constraints and priorities');
  const get = db.prepare('SELECT value FROM constraints WHERE name = ?');
  const upsert = db.prepare(
    `INSERT INTO constraints (name, value, updated) VALUES (?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated = datetime('now')`
  );
  const items = [
    ['liquid_minimum', 'Minimum liquid cash to always keep (dollars)'],
    ['do_not_touch', 'Do-not-touch accounts (comma-separated, blank if none)'],
    ['risk_posture', 'Risk posture in your own words'],
    ['priority_order', 'Priority order across goals and debts, in your own words'],
  ];
  for (const [name, q] of items) {
    const before = get.get(name)?.value ?? null;
    const v = await ask(q, before ?? '');
    if (v === '' || v === before) continue;
    auditedWrite(
      db,
      {
        actor: ACTOR,
        action: 'constraints.upsert',
        target: `constraints:${name}`,
        before: before === null ? null : { value: before },
        after: { value: v },
        reversalHandle: reversalHandleFor('constraints', name, before === null ? null : { value: before }),
      },
      () => upsert.run(name, v)
    );
  }
}

async function stepTax(db) {
  heading(7, 'Tax configuration (advisory only; the rate is CPA-confirmed)');
  const before = getPref(db, 'tax_setaside_rate');
  const rate = await askNumber('Effective set-aside rate for non-withheld income (percent)', before ?? 25);
  if (rate !== null) {
    setPrefAudited(db, 'tax_setaside_rate', rate, ACTOR);
    if (getPref(db, 'tax_rate_cpa_confirmed') === null) {
      console.log('Recorded as PENDING CPA confirmation. fincore reminds; it never files or pays.');
      setPrefAudited(db, 'tax_rate_cpa_confirmed', 'no', ACTOR);
    }
  }
}

async function stepAutonomy(db) {
  heading(8, 'Autonomy and authorization');
  const before = getPref(db, 'autonomy_dollar_threshold');
  const threshold = await askNumber('Dollar threshold for autonomous low-risk writes', before ?? 50);
  if (threshold !== null) {
    setPrefAudited(db, 'autonomy_dollar_threshold', threshold, ACTOR);
  }
  console.log('Discord write authorization is DISCORD_ALLOWED_USER_IDS in agents/.env (fail-closed).');
}

function stepBackfill() {
  heading(9, 'Historical backfill');
  console.log('Seed rules and the initial trend by categorizing ~90 days of history:');
  console.log('  LOOKBACK_DAYS=90 CATEGORIZE_CAP=200 npm run daily');
  console.log('Cost is bounded by the cap; rerun until the residue is gone.');
}

async function stepBaseline(db, accounts) {
  heading(10, 'Baseline');
  const state = baselineState(db);

  let outcome;
  try {
    // Computed over the exact account set reviewed in step 3, not a refetch, so the
    // locked "before" is the picture Bryson actually confirmed.
    outcome = await computeOutcomes(db, { accounts: [...accounts.assets, ...accounts.liabilities] });
  } catch (e) {
    console.log(`Cannot compute the baseline (${e.message}). Fix Firefly access and rerun.`);
    return;
  }
  console.log('\n' + formatOutcome(outcome) + '\n');

  const hasFlags = outcome.flags.length > 0;
  if (hasFlags) console.log('Resolve the FLAG lines above before trusting these numbers.\n');

  if (!state.locked) {
    console.log('Locking freezes this as the "before" for all future measurement.');
    console.log('A 30-day correction window allows late-found accounts to adjust it; then it is frozen.');
    if (await askYesNo('Lock the baseline now?', !hasFlags)) {
      lockBaseline(db, {
        snapshotDate: firefly.nyDateStr(),
        netWorth: outcome.netWorth.netWorth,
        dti: outcome.dti.dti,
        dtiBasis: outcome.dti.basis || null,
        inputs: outcome.inputs,
        actor: ACTOR,
      });
      console.log('Baseline locked.');
    } else {
      console.log('Not locked. Nothing value-attributed acts until it is; rerun when ready.');
    }
  } else if (state.correctable) {
    console.log(`Baseline locked ${state.lockedAt}; correction window open until ${state.windowEndsAt}.`);
    if (await askYesNo('Recompute and correct the locked baseline with the current numbers?', false)) {
      const reason = await ask('Reason for the correction');
      correctBaseline(db, {
        netWorth: outcome.netWorth.netWorth,
        dti: outcome.dti.dti,
        dtiBasis: outcome.dti.basis || null,
        inputs: outcome.inputs,
        reason,
        actor: ACTOR,
      });
      console.log('Baseline corrected (audited).');
    }
  } else {
    console.log(`Baseline locked ${state.lockedAt} and frozen (window closed ${state.windowEndsAt}).`);
  }
}

// --- main ---

async function main() {
  console.log('fincore onboarding (SPEC 10.4). Rerunnable; existing answers appear as defaults.');
  const db = openStore();

  await stepIncomeSources(db);
  await stepPaystub(db);

  const accounts = await fetchAccountsSafe();
  if (accounts) {
    await stepAccounts(accounts);
    await stepDebts(db, accounts);
  }

  await stepGoals(db);
  await stepConstraints(db);
  await stepTax(db);
  await stepAutonomy(db);
  stepBackfill();

  if (accounts) await stepBaseline(db, accounts);

  setMeta(db, 'onboarding_last_run', new Date().toISOString());
  console.log('\nOnboarding complete. Rerun any time with: npm run onboard');
  rl.close();
  db.close();
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});
