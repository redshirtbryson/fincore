// Money-grade tests for the debt engine (SPEC 3B, section 6). These pin the DEFINITION:
// cents-exact interest and amortization, a payment that cannot cover interest flagged
// (not looped), avalanche ordering, strike overflow rolling debt to debt, and the real
// fincore debt numbers as fixtures. Unit functions are asserted cents-EXACT; the
// multi-month plan projection is asserted in sane ranges plus exact death months, so a
// harmless rounding change does not turn the suite red while a real error still would.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoney,
  parseAprPercent,
  monthlyInterest,
  monthsToPayoff,
  projectPlan,
  interestCancelled,
  avalancheOrder,
} from '../lib/debt-engine.js';

// Real fincore debts, restated here so the fixtures live with the assertions.
const DISCOVER = { name: 'Discover', balance: 27056.70, aprPercent: 28.49, minimum: 250 };
const APPLE = { name: 'Apple', balance: 5003.17, aprPercent: 25.49, minimum: 100 };
const AFFIRM = { name: 'Affirm', balance: 4483.30, aprPercent: 23.1, minimum: 90 };

test('parseMoney strips $ and commas, keeps sign, rejects garbage', () => {
  assert.equal(parseMoney(27056.7), 27056.7);
  assert.equal(parseMoney('$27,056.70'), 27056.7);
  assert.equal(parseMoney('  1,000.00 '), 1000);
  assert.equal(parseMoney(-5), -5); // negatives pass through so callers can reject them
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(NaN), null);
  assert.equal(parseMoney(Infinity), null);
  assert.equal(parseMoney(null), null);
});

test('parseAprPercent strips % , rejects negative and garbage', () => {
  assert.equal(parseAprPercent(28.49), 28.49);
  assert.equal(parseAprPercent('28.49%'), 28.49);
  assert.equal(parseAprPercent('28.49'), 28.49);
  assert.equal(parseAprPercent(0), 0);
  assert.equal(parseAprPercent(-1), null); // negative APR is nonsense for debt
  assert.equal(parseAprPercent('nope'), null);
  assert.equal(parseAprPercent(''), null);
  assert.equal(parseAprPercent(null), null);
});

test('monthlyInterest: real fincore debts, cents-exact', () => {
  // Discover $27,056.70 @ 28.49% = 27056.70 * 0.2849 / 12 = 642.3675... -> $642.37.
  assert.equal(monthlyInterest(27056.70, 28.49), 642.37);
  assert.equal(monthlyInterest('$27,056.70', '28.49%'), 642.37); // string form agrees
  assert.equal(monthlyInterest(5003.17, 25.49), 106.28); // Apple
  assert.equal(monthlyInterest(4483.30, 23.1), 86.30); // Affirm
});

test('monthlyInterest flags-not-guesses on bad input (null, never 0 or NaN)', () => {
  assert.equal(monthlyInterest(-5, 10), null); // negative balance
  assert.equal(monthlyInterest('xyz', 10), null); // garbage balance
  assert.equal(monthlyInterest(1000, -3), null); // negative APR
  assert.equal(monthlyInterest(1000, 'bad'), null); // garbage APR
  assert.equal(monthlyInterest(0, 28.49), 0); // zero balance is a real, honest 0
});

test('monthsToPayoff: $1,000 @ 12%, $100/mo matches hand-computed amortization to the penny', () => {
  // 12% APR = 1% per month. Hand amortization (interest = 1% of prior balance):
  //  m1  int 10.00  prin 90.00  -> 910.00
  //  m2   9.10       90.90       -> 819.10
  //  m3   8.19       91.81       -> 727.29
  //  m4   7.27       92.73       -> 634.56
  //  m5   6.35       93.65       -> 540.91
  //  m6   5.41       94.59       -> 446.32
  //  m7   4.46       95.54       -> 350.78
  //  m8   3.51       96.49       -> 254.29
  //  m9   2.54       97.46       -> 156.83
  //  m10  1.57       98.43       ->  58.40
  //  m11  0.58   (final: pays remaining 58.40 principal) ->  0.00
  const r = monthsToPayoff({ balance: 1000, aprPercent: 12, monthlyPayment: 100 });
  assert.equal(r.months, 11);
  assert.equal(r.totalInterest, 58.98); // sum of the interest column above
  assert.equal(r.flag, undefined);

  const expected = [
    { month: 1, interest: 10.0, principal: 90.0, balanceAfter: 910.0 },
    { month: 2, interest: 9.1, principal: 90.9, balanceAfter: 819.1 },
    { month: 3, interest: 8.19, principal: 91.81, balanceAfter: 727.29 },
    { month: 4, interest: 7.27, principal: 92.73, balanceAfter: 634.56 },
    { month: 5, interest: 6.35, principal: 93.65, balanceAfter: 540.91 },
    { month: 6, interest: 5.41, principal: 94.59, balanceAfter: 446.32 },
    { month: 7, interest: 4.46, principal: 95.54, balanceAfter: 350.78 },
    { month: 8, interest: 3.51, principal: 96.49, balanceAfter: 254.29 },
    { month: 9, interest: 2.54, principal: 97.46, balanceAfter: 156.83 },
    { month: 10, interest: 1.57, principal: 98.43, balanceAfter: 58.4 },
    { month: 11, interest: 0.58, principal: 58.4, balanceAfter: 0 },
  ];
  assert.deepEqual(r.schedule, expected);
  // Final balance is exactly zero, never negative, never a sub-penny tail.
  assert.equal(r.schedule[r.schedule.length - 1].balanceAfter, 0);
  // The whole thing reconciles: principal paid == original balance.
  const totalPrincipal = r.schedule.reduce((s, m) => s + m.principal, 0);
  assert.ok(Math.abs(totalPrincipal - 1000) < 1e-9);
});

test('monthsToPayoff: Discover paying only its minimum barely dents interest but still terminates', () => {
  // At $642.37/mo interest, a $700 payment covers interest with room to spare, so this
  // is a long-but-finite payoff. Assert it is finite and the schedule ends at zero.
  const r = monthsToPayoff({ balance: DISCOVER.balance, aprPercent: DISCOVER.aprPercent, monthlyPayment: 700 });
  assert.ok(Number.isFinite(r.months));
  assert.ok(r.months > 60); // near-minimum payment: years, not months
  assert.equal(r.schedule[r.schedule.length - 1].balanceAfter, 0);
});

test('monthsToPayoff: payment at or below first-month interest is flagged, not looped', () => {
  // $1,000 @ 24% = $20/mo interest. A $20 payment exactly covers interest: never falls.
  const equal = monthsToPayoff({ balance: 1000, aprPercent: 24, monthlyPayment: 20 });
  assert.equal(equal.months, Infinity);
  assert.equal(equal.flag, 'payment does not cover interest');
  assert.deepEqual(equal.schedule, []);

  // Below interest is likewise flagged.
  const below = monthsToPayoff({ balance: 1000, aprPercent: 24, monthlyPayment: 15 });
  assert.equal(below.months, Infinity);
  assert.equal(below.flag, 'payment does not cover interest');
});

test('monthsToPayoff: zero balance is already paid off (0 months, empty schedule)', () => {
  const r = monthsToPayoff({ balance: 0, aprPercent: 28.49, monthlyPayment: 100 });
  assert.equal(r.months, 0);
  assert.equal(r.totalInterest, 0);
  assert.deepEqual(r.schedule, []);
  assert.equal(r.flag, undefined);
});

test('monthsToPayoff: garbage / negative inputs return a flag and a null month count', () => {
  const badBal = monthsToPayoff({ balance: 'abc', aprPercent: 10, monthlyPayment: 50 });
  assert.equal(badBal.months, null);
  assert.ok(/balance/.test(badBal.flag));

  const negBal = monthsToPayoff({ balance: -100, aprPercent: 10, monthlyPayment: 50 });
  assert.equal(negBal.months, null);
  assert.ok(/balance/.test(negBal.flag));

  const badApr = monthsToPayoff({ balance: 1000, aprPercent: 'nope', monthlyPayment: 50 });
  assert.equal(badApr.months, null);
  assert.ok(/APR/.test(badApr.flag));

  const badPay = monthsToPayoff({ balance: 1000, aprPercent: 10, monthlyPayment: 0 });
  assert.equal(badPay.months, null);
  assert.ok(/payment/.test(badPay.flag));
});

test('avalancheOrder sorts living debts APR-descending and drops dead/garbage rows', () => {
  const order = avalancheOrder([AFFIRM, DISCOVER, APPLE]);
  assert.deepEqual(order.map((d) => d.name), ['Discover', 'Apple', 'Affirm']);

  // Zero/negative balances are not "living" and drop out; garbage APR drops out.
  const withDead = avalancheOrder([
    DISCOVER,
    { name: 'PaidOff', balance: 0, aprPercent: 30 },
    { name: 'Bad', balance: 'x', aprPercent: 15 },
    APPLE,
  ]);
  assert.deepEqual(withDead.map((d) => d.name), ['Discover', 'Apple']);

  // Stable tie-break: equal APRs keep input order.
  const tie = avalancheOrder([
    { name: 'First', balance: 100, aprPercent: 20 },
    { name: 'Second', balance: 100, aprPercent: 20 },
  ]);
  assert.deepEqual(tie.map((d) => d.name), ['First', 'Second']);
});

test('interestCancelled: a principal paydown cancels balanceRetired * apr / 1200, cents-exact', () => {
  // Retiring $1,000 of Discover @ 28.49% removes 1000 * 0.2849 / 12 = 23.7416.. -> $23.74/mo forever.
  assert.equal(interestCancelled({ balanceRetired: 1000, aprPercent: 28.49 }), 23.74);
  assert.equal(interestCancelled({ balanceRetired: '$5,003.17', aprPercent: '25.49%' }), 106.28); // = Apple's full monthly interest
  assert.equal(interestCancelled({ balanceRetired: -1, aprPercent: 10 }), null);
  assert.equal(interestCancelled({ balanceRetired: 1000, aprPercent: -5 }), null);
  assert.equal(interestCancelled({ balanceRetired: 'x', aprPercent: 10 }), null);
});

test('projectPlan: strike overflow kills the first debt and rolls the remainder onward in the SAME month', () => {
  // Two zero-APR $1,000 debts, no minimums, a single $1,500 strike in month 1.
  // Avalanche-order irrelevant at 0% APR; A is first. $1,000 kills A, $500 rolls to B.
  const debts = [
    { name: 'A', balance: 1000, aprPercent: 0, minimum: 0 },
    { name: 'B', balance: 1000, aprPercent: 0, minimum: 0 },
  ];
  const r = projectPlan({ debts, strikes: [{ month: 1, amount: 1500 }] });
  assert.equal(r.perDebt.find((d) => d.name === 'A').deadMonth, 1); // A dies month 1
  assert.equal(r.perDebt.find((d) => d.name === 'B').deadMonth, null); // B survives (only $500 hit)
  const m1 = r.schedule[0];
  assert.equal(m1.debts.find((d) => d.name === 'A').strikePaid, 1000);
  assert.equal(m1.debts.find((d) => d.name === 'A').balanceAfter, 0);
  assert.equal(m1.debts.find((d) => d.name === 'B').strikePaid, 500);
  assert.equal(m1.debts.find((d) => d.name === 'B').balanceAfter, 500);
});

test('projectPlan: reference fincore scenario kills Discover in month 7, all debts by month 9', () => {
  // Mirrors the playbook: avalanche order (Discover > Apple > Affirm), minimums every
  // month on every living debt, plus escalating strikes with a two-month tax-window gap.
  //   month 1: ~$4,700   month 2: ~$5,640   months 3-4: ~$6,580
  //   months 5-6: none (tax set-aside window)   months 7+: ~$6,580
  const ordered = avalancheOrder([DISCOVER, APPLE, AFFIRM]);
  assert.deepEqual(ordered.map((d) => d.name), ['Discover', 'Apple', 'Affirm']);

  const strikes = [
    { month: 1, amount: 4700 },
    { month: 2, amount: 5640 },
    { month: 3, amount: 6580 },
    { month: 4, amount: 6580 },
    // months 5-6 intentionally empty (tax window)
  ];
  for (let mo = 7; mo <= 36; mo++) strikes.push({ month: mo, amount: 6580 });

  const r = projectPlan({ debts: ordered, strikes });

  // Death months: exact, because these are the load-bearing claim ("Discover dies in month N").
  const discover = r.perDebt.find((d) => d.name === 'Discover');
  const apple = r.perDebt.find((d) => d.name === 'Apple');
  const affirm = r.perDebt.find((d) => d.name === 'Affirm');
  assert.equal(discover.deadMonth, 7, 'Discover should die in month 7 under this plan');
  // Avalanche pays highest APR first, so the others survive until Discover is gone, then
  // fall in quick succession right after.
  assert.ok(apple.deadMonth >= discover.deadMonth && apple.deadMonth <= 10);
  assert.ok(affirm.deadMonth >= apple.deadMonth && affirm.deadMonth <= 11);
  assert.equal(r.monthsToAllDead, 9);
  assert.equal(r.flags, undefined); // clean run, no cap hit

  // Total interest lands in a sane band. Starting balances total ~$36.5k at 23-28.5%;
  // an aggressive ~9-month payoff should cost low thousands, not tens of thousands and
  // not zero. Assert a range, not a brittle exact figure (per house rule for plans).
  assert.ok(r.totalInterest > 2500, `total interest ${r.totalInterest} implausibly low`);
  assert.ok(r.totalInterest < 6000, `total interest ${r.totalInterest} implausibly high`);

  // Per-debt interest is positive for each and sums to the reported total (cents-exact).
  const summed = r.perDebt.reduce((s, d) => s + d.interestPaid, 0);
  assert.ok(Math.abs(summed - r.totalInterest) < 1e-9);
  for (const d of r.perDebt) assert.ok(d.interestPaid > 0);
});

test('projectPlan: excludes and flags a garbage debt instead of poisoning the plan', () => {
  const r = projectPlan({
    debts: [
      DISCOVER,
      { name: 'Mystery', balance: 'unknown', aprPercent: 20, minimum: 50 },
    ],
    strikes: [{ month: 1, amount: 30000 }],
  });
  // Only Discover is modeled; Mystery is flagged out.
  assert.equal(r.perDebt.length, 1);
  assert.equal(r.perDebt[0].name, 'Discover');
  assert.ok(r.flags.some((f) => /Mystery/.test(f) && /balance/.test(f)));
});

test('projectPlan: no living debts is zero work, not an error', () => {
  const r = projectPlan({
    debts: [{ name: 'PaidOff', balance: 0, aprPercent: 30, minimum: 0 }],
    strikes: [{ month: 1, amount: 1000 }],
  });
  assert.equal(r.monthsToAllDead, 0);
  assert.equal(r.totalInterest, 0);
  assert.deepEqual(r.schedule, []);
});

test('projectPlan: minimums that never cover interest hit the cap and flag it', () => {
  // $30k @ 30% ($750/mo interest at the start) with a $10 minimum and no strikes never
  // falls. The run must cap and say so, not loop forever or claim a payoff.
  const r = projectPlan({
    debts: [{ name: 'Runaway', balance: 30000, aprPercent: 30, minimum: 10 }],
    strikes: [],
  });
  assert.equal(r.monthsToAllDead, null);
  assert.equal(r.perDebt[0].deadMonth, null);
  assert.ok(r.flags.some((f) => /capped/.test(f)));
});
