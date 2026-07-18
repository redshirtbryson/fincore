// Debt engine: pure, deterministic, unit-tested. No I/O, no model, no clock, no env.
//
// Why this exists (SPEC 3B, section 6): every debt figure behind a recommendation
// (monthly interest, months-to-payoff, interest saved, payoff date, plan projection)
// must come from a pure function the tests pin down, never from the model. The model
// narrates; these numbers are law.
//
// Money math rule (matches lib/matching.js, lib/networth.js): all arithmetic runs
// through whole cents (Math.round(dollars * 100)) so float traps like 0.1 + 0.2 or a
// balance rebuilt from parts never drift a payoff schedule off by a penny. Dollars
// come back out only at the boundary, cents-rounded.
//
// Flag, do not guess (SPEC section 11): an unparseable amount or rate yields null (for
// scalar functions) or a `flag` on the result (for the schedule/plan builders), never
// a coerced-and-continued bad number. A payment that cannot cover the first month's
// interest is Infinity months plus a flag, not a silently truncated or looping run.
//
// No Date anywhere: "month" is an integer step, 1-based offset from now. The caller
// owns the calendar; this file owns the arithmetic.

// Hard ceiling on any amortization run. A payment that only barely beats interest can
// take decades of tiny principal; 600 months (50 years) is well past any real consumer
// debt and stops a near-zero-principal run from producing an enormous schedule array.
const MAX_MONTHS = 600;

// Dollars (number, or string like "$27,056.70") to a finite Number, or null on garbage.
// Strips '$', commas, and whitespace. Unlike lib/matching's parseAmount this permits
// negatives so callers can detect and reject them with a specific message; a raw
// negative balance is a data error, not a magnitude. Returns null (not NaN, not 0) for
// anything unparseable so the caller flags rather than guesses.
export function parseMoney(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// APR percent (number, or string like "28.49%" / "28.49") to a finite non-negative
// Number, or null. A percent is a rate, never money, so no '$'/',' stripping games:
// only '%' and whitespace come off. Negative APR is nonsensical for debt and returns
// null so the caller flags it.
export function parseAprPercent(v) {
  let n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const cleaned = v.replace(/[%\s]/g, '');
    if (cleaned === '') return null;
    n = Number(cleaned);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// Whole cents from a dollar Number. The one place float dollars become integer money.
function toCents(dollars) {
  return Math.round(dollars * 100);
}

// Cents back to a dollar Number, cents-exact (two decimals). Integer cents / 100 is
// exact for any value in range, so this never reintroduces float fuzz.
function toDollars(cents) {
  return cents / 100;
}

// One month's interest on an integer-cents balance at an APR percent, returned in
// whole cents (rounded). balanceCents * apr / 100 / 12 == balanceCents * apr / 1200.
// This is THE interest primitive: every schedule step and every "interest cancelled"
// figure routes through the same rounding so a plan and a single-debt payoff agree to
// the penny.
function monthInterestCents(balanceCents, aprPercent) {
  return Math.round((balanceCents * aprPercent) / 1200);
}

// (1) Monthly interest in dollars for a balance at an APR percent, cents-rounded.
// Negative or unparseable balance/APR -> null (flag-don't-guess at the call site).
// Discover $27,056.70 @ 28.49% -> $642.37 (27056.70 * 0.2849 / 12, rounded to cents).
export function monthlyInterest(balance, aprPercent) {
  const dollars = parseMoney(balance);
  const apr = parseAprPercent(aprPercent);
  if (dollars === null || dollars < 0) return null;
  if (apr === null) return null;
  return toDollars(monthInterestCents(toCents(dollars), apr));
}

// (2) Amortize a single debt at a fixed monthly payment.
// Input: { balance, aprPercent, monthlyPayment } (dollars / percent, tolerant parsing).
// Monthly compounding: each month interest = balance * apr / 1200 (cents-rounded),
// principal = payment - interest, balance -= principal. The final month pays the exact
// remaining balance plus its interest so the schedule never goes negative and never
// leaves a sub-penny tail.
// Returns { months, totalInterest, schedule } where schedule is
// [{ month, interest, principal, balanceAfter }] in dollars.
// A zero (or already-negative-to-zero) balance returns months 0, empty schedule.
// If the payment does not cover the first month's interest, returns
// { months: Infinity, totalInterest: 0, schedule: [], flag: 'payment does not cover interest' }.
// Garbage input returns { months: null, ..., flag } so the caller reports, not guesses.
export function monthsToPayoff({ balance, aprPercent, monthlyPayment } = {}) {
  const dollars = parseMoney(balance);
  const apr = parseAprPercent(aprPercent);
  const payment = parseMoney(monthlyPayment);

  if (dollars === null || dollars < 0) {
    return { months: null, totalInterest: 0, schedule: [], flag: `unparseable or negative balance (${balance})` };
  }
  if (apr === null) {
    return { months: null, totalInterest: 0, schedule: [], flag: `unparseable or negative APR (${aprPercent})` };
  }
  if (payment === null || payment <= 0) {
    return { months: null, totalInterest: 0, schedule: [], flag: `unparseable or non-positive payment (${monthlyPayment})` };
  }

  let balanceCents = toCents(dollars);
  if (balanceCents <= 0) {
    return { months: 0, totalInterest: 0, schedule: [] };
  }
  const paymentCents = toCents(payment);

  // Payment must strictly beat the first month's interest or the principal never falls.
  const firstInterest = monthInterestCents(balanceCents, apr);
  if (paymentCents <= firstInterest) {
    return {
      months: Infinity,
      totalInterest: 0,
      schedule: [],
      flag: 'payment does not cover interest',
    };
  }

  const schedule = [];
  let totalInterestCents = 0;
  let month = 0;

  while (balanceCents > 0 && month < MAX_MONTHS) {
    month += 1;
    const interestCents = monthInterestCents(balanceCents, apr);
    // If this month's payment clears the balance plus its interest, pay the exact
    // remainder: principal is the whole balance, the final payment is smaller.
    let principalCents;
    if (paymentCents >= balanceCents + interestCents) {
      principalCents = balanceCents;
    } else {
      principalCents = paymentCents - interestCents;
    }
    balanceCents -= principalCents;
    totalInterestCents += interestCents;
    schedule.push({
      month,
      interest: toDollars(interestCents),
      principal: toDollars(principalCents),
      balanceAfter: toDollars(balanceCents),
    });
  }

  // Cap hit before payoff: the debt is real but the run was truncated. Report both so
  // the caller never reads a capped schedule as a finished one.
  if (balanceCents > 0) {
    return {
      months: schedule.length,
      totalInterest: toDollars(totalInterestCents),
      schedule,
      flag: `schedule capped at ${MAX_MONTHS} months with balance remaining`,
    };
  }

  return {
    months: schedule.length,
    totalInterest: toDollars(totalInterestCents),
    schedule,
  };
}

// (5) Living debts (positive balance) sorted APR descending: the avalanche order that
// minimizes total interest. Ties break by original input order (stable), so a
// deterministic caller gets a deterministic queue. Unparseable rows are dropped here;
// projectPlan flags them separately so nothing is silently swallowed at the plan level.
export function avalancheOrder(debts) {
  const living = [];
  for (let i = 0; i < (debts || []).length; i++) {
    const d = debts[i];
    if (!d) continue;
    const bal = parseMoney(d.balance);
    const apr = parseAprPercent(d.aprPercent);
    if (bal === null || bal <= 0) continue;
    if (apr === null) continue;
    living.push({ debt: d, apr, order: i });
  }
  living.sort((a, b) => {
    if (b.apr !== a.apr) return b.apr - a.apr;
    return a.order - b.order; // stable tie-break
  });
  return living.map((x) => x.debt);
}

// (4) The permanent monthly interest a one-time principal reduction cancels forever.
// Retiring $balanceRetired of a debt at aprPercent removes balanceRetired * apr / 1200
// dollars of interest from EVERY future month. This is the honest way to state the
// value of a lump-sum paydown (SPEC 3C: under-claim, quantify the real effect), and it
// uses the exact same cents-rounded primitive as the schedule so the two never disagree.
// Negative/unparseable input -> null.
export function interestCancelled({ balanceRetired, aprPercent } = {}) {
  const dollars = parseMoney(balanceRetired);
  const apr = parseAprPercent(aprPercent);
  if (dollars === null || dollars < 0) return null;
  if (apr === null) return null;
  return toDollars(monthInterestCents(toCents(dollars), apr));
}

// (3) Project the fincore payoff plan across several debts.
// Input:
//   debts: [{ name, balance, aprPercent, minimum }] — the caller passes them in
//     avalanche order (highest APR first); this function does NOT re-sort, it trusts
//     the order given so a caller can model a chosen (e.g. snowball) order too. Use
//     avalancheOrder() first for the standard plan.
//   monthlyMinimums: unused sentinel kept for signature stability; minimums come off
//     each debt row. (Left in the destructure so callers passing it do not error.)
//   strikes: [{ month, amount }] — extra lump payments beyond minimums, 1-based month
//     offsets from now. A strike lands on the FIRST living debt in the given order;
//     whatever it over-pays that debt rolls to the next living debt in the SAME month,
//     and onward, so a big strike can kill more than one debt at once. Multiple strikes
//     in the same month sum.
// Model, per month, deterministic and cents-exact:
//   1. Accrue interest on every living debt (balance * apr / 1200, cents-rounded).
//   2. Pay each living debt its minimum (capped at its current balance).
//   3. Apply the month's strike money to the first living debt, overflow rolling on.
// A debt with balance 0 after a month is dead; its deadMonth is recorded once.
// Returns:
//   { perDebt: [{ name, deadMonth, interestPaid }], totalInterest, monthsToAllDead, schedule }
//   perDebt is in input order. deadMonth is null for a debt still alive at the cap.
//   schedule: [{ month, debts: [{ name, interest, minimumPaid, strikePaid, balanceAfter }] }].
//   flag is set if the run hit MAX_MONTHS with debt still alive.
export function projectPlan({ debts, monthlyMinimums, strikes } = {}) {
  const flags = [];

  // Normalize debts into integer-cents working state. A row with unparseable balance,
  // APR, or minimum is FLAGGED and excluded — a plan built on a guessed number is worse
  // than a plan that says one debt could not be modeled.
  const state = [];
  for (let i = 0; i < (debts || []).length; i++) {
    const d = debts[i];
    if (!d) continue;
    const bal = parseMoney(d.balance);
    const apr = parseAprPercent(d.aprPercent);
    const min = parseMoney(d.minimum);
    if (bal === null || bal < 0) {
      flags.push(`debt "${d.name ?? `#${i}`}" has unparseable/negative balance (${d.balance}); excluded from plan`);
      continue;
    }
    if (apr === null) {
      flags.push(`debt "${d.name ?? `#${i}`}" has unparseable/negative APR (${d.aprPercent}); excluded from plan`);
      continue;
    }
    if (min === null || min < 0) {
      flags.push(`debt "${d.name ?? `#${i}`}" has unparseable/negative minimum (${d.minimum}); excluded from plan`);
      continue;
    }
    state.push({
      name: d.name ?? `#${i}`,
      apr,
      minCents: toCents(min),
      balanceCents: toCents(bal),
      interestCents: 0,
      deadMonth: state.length >= 0 && toCents(bal) <= 0 ? 0 : null, // balance 0 at start = dead at month 0
    });
  }

  // Index strikes by month so lookups are O(1) per step. Ignore non-positive months or
  // amounts (a strike "now" has no month to land on); flag so nothing vanishes silently.
  const strikeByMonth = new Map();
  for (const s of strikes || []) {
    if (!s) continue;
    const amt = parseMoney(s.amount);
    const m = Number(s.month);
    if (!Number.isInteger(m) || m < 1) {
      flags.push(`strike with invalid month (${s.month}) ignored`);
      continue;
    }
    if (amt === null || amt <= 0) {
      flags.push(`strike in month ${m} has unparseable/non-positive amount (${s.amount}); ignored`);
      continue;
    }
    strikeByMonth.set(m, (strikeByMonth.get(m) || 0) + toCents(amt));
  }

  const schedule = [];
  const anyAliveAtStart = state.some((s) => s.balanceCents > 0);
  let month = 0;

  while (state.some((s) => s.balanceCents > 0) && month < MAX_MONTHS) {
    month += 1;
    const row = { month, debts: [] };

    // Per-debt accrual + minimum. Track what each debt got this month for the schedule.
    const paidThisMonth = new Map(); // name -> { interest, minimumPaid }
    for (const s of state) {
      if (s.balanceCents <= 0) continue;
      const interestCents = monthInterestCents(s.balanceCents, s.apr);
      s.balanceCents += interestCents;
      s.interestCents += interestCents;
      // Minimum cannot exceed the balance (never overpay into negative).
      const minPay = Math.min(s.minCents, s.balanceCents);
      s.balanceCents -= minPay;
      paidThisMonth.set(s.name, { interest: interestCents, minimumPaid: minPay, strikePaid: 0 });
      if (s.balanceCents <= 0 && s.deadMonth === null) s.deadMonth = month;
    }

    // Strike money for this month, applied to the first living debt in order, overflow
    // rolling to the next. A debt already killed by its minimum this month is skipped.
    let strikeCents = strikeByMonth.get(month) || 0;
    for (const s of state) {
      if (strikeCents <= 0) break;
      if (s.balanceCents <= 0) continue;
      const applied = Math.min(strikeCents, s.balanceCents);
      s.balanceCents -= applied;
      strikeCents -= applied;
      const rec = paidThisMonth.get(s.name) || { interest: 0, minimumPaid: 0, strikePaid: 0 };
      rec.strikePaid += applied;
      paidThisMonth.set(s.name, rec);
      if (s.balanceCents <= 0 && s.deadMonth === null) s.deadMonth = month;
    }
    // Any strike money left after all debts are dead is simply not spent — the plan
    // needed less than offered. It is neither an error nor interest; it just stops.

    for (const s of state) {
      const rec = paidThisMonth.get(s.name);
      if (!rec) continue; // debt was already dead before this month
      row.debts.push({
        name: s.name,
        interest: toDollars(rec.interest),
        minimumPaid: toDollars(rec.minimumPaid),
        strikePaid: toDollars(rec.strikePaid),
        balanceAfter: toDollars(Math.max(s.balanceCents, 0)),
      });
    }
    schedule.push(row);
  }

  const stillAlive = state.some((s) => s.balanceCents > 0);
  if (stillAlive) {
    flags.push(`plan capped at ${MAX_MONTHS} months with debt still alive; minimums may not cover interest`);
  }

  let totalInterestCents = 0;
  const perDebt = state.map((s) => {
    totalInterestCents += s.interestCents;
    return { name: s.name, deadMonth: s.deadMonth, interestPaid: toDollars(s.interestCents) };
  });

  return {
    perDebt,
    totalInterest: toDollars(totalInterestCents),
    // monthsToAllDead is the last month the schedule ran; null when nothing was alive
    // to begin with (no work to do) or the run capped without clearing everything.
    monthsToAllDead: !anyAliveAtStart ? 0 : stillAlive ? null : month,
    schedule,
    ...(flags.length ? { flags } : {}),
  };
}
