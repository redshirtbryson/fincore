// Influx allocation: pure, deterministic, unit-tested. No I/O, no model, no clock,
// no env, no DB. Every input the waterfall depends on (the deposit, the influx index,
// balances, the checkpoint date, the Roth window, the debt list) is passed in, so the
// same inputs always produce the same tranches. The caller reads the ledger, fetches
// balances, and asks the clock; this function only does arithmetic.
//
// Why this exists (playbook v2, 2026-07-18, Phase 6): Redshirt income arrives lumpy
// (~$9,400 every 5-6 weeks). Each deposit is split at receipt across a fixed priority
// waterfall — tax set-aside, CNB buffer, then a "strike" tranche that attacks the
// highest-APR frozen revolving debt (avalanche), with a Jan-Apr Roth window that can
// jump the queue once the top debt (Discover) is dead. This module encodes that
// waterfall verbatim so the deposit watcher can emit the exact transfer amounts.
//
// Flag, do not guess (SPEC section 11): an unparseable amount or date, a negative
// deposit, or a missing debts array returns { tranches: [], flags: [reason] } — the
// function never invents a split from bad input. Whether a given deposit is actually a
// Redshirt influx is the CALLER's filtering problem; this function allocates whatever
// deposit it is handed.

// ---------------------------------------------------------------------------
// Parsing helpers (mirror the house style in matching.js / loan-truing.js).
// ---------------------------------------------------------------------------

// String or number dollars to a finite Number, or null. Unlike matching.parseAmount
// this permits any finite value through (negatives are caught explicitly downstream so
// we can flag "negative deposit" distinctly from "unparseable amount"). Strips '$',
// commas, and whitespace.
function parseMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 'YYYY-MM-DD' to a UTC day count, or null if it does not parse as that exact shape.
// Same technique as matching.js: validate the format, compute from UTC so no local
// time zone shifts a day, and reject rolled-over dates like 2026-02-31.
function parseDay(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(ms / 86400000);
}

// Dollars to whole cents (integer). All internal arithmetic runs in integer cents so a
// three-way percentage split cannot leak a fraction of a cent, and the final tranches
// sum EXACTLY to the deposit. Rounds half away from zero at the cent.
function toCents(dollars) {
  return Math.round(dollars * 100);
}

// Whole cents back to a dollars Number for the returned tranche amounts.
function toDollars(cents) {
  return cents / 100;
}

// ---------------------------------------------------------------------------
// Avalanche: debts sorted highest-APR first, only those still carrying a balance.
// ---------------------------------------------------------------------------

// Return the debts that still owe money, sorted by APR descending. This is the strike
// order: the avalanche method attacks the highest rate first because that cancels the
// most interest per dollar. Debts with balance <= 0 are dead and dropped (they cannot
// be a strike target). Ties in APR break by name so the order is deterministic.
//
// Defensive: a debt with an unparseable balance or APR is skipped here rather than
// crashing the sort; computeAllocation validates the array shape up front and will
// have already flagged a wholly missing array, so this is belt-and-suspenders for a
// single malformed row inside an otherwise-valid list.
export function avalanche(debts) {
  const live = [];
  for (const d of debts || []) {
    if (!d || typeof d !== 'object') continue;
    const balance = parseMoney(d.balance);
    const apr = parseMoney(d.apr);
    if (balance === null || apr === null) continue;
    if (balance <= 0) continue;
    live.push({ ...d, _balance: balance, _apr: apr });
  }
  live.sort((a, b) => {
    if (b._apr !== a._apr) return b._apr - a._apr;
    const an = String(a.name ?? '');
    const bn = String(b.name ?? '');
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });
  // Strip the internal scratch fields so callers see the original debt shape.
  return live.map(({ _balance, _apr, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// The waterfall.
// ---------------------------------------------------------------------------

const DEFAULT_BUFFER_TIER1_TARGET = 6000;
const ROTH_APR_FLOOR = 28; // a debt at/above this APR is treated as the top "Discover-class" blocker

// Buffer percentage of the ORIGINAL deposit by influx index, applied only while the
// buffer is still below tier 1. Once the buffer is full every influx uses the base 15%
// (which then flows to the reservoir, not the buffer). See playbook "influx split".
function bufferPctForInflux(influxIndex, boosted) {
  if (!boosted) return 0.15; // buffer already at/over tier 1: no boost, base rate
  if (influxIndex === 1) return 0.35;
  if (influxIndex === 2) return 0.25;
  return 0.15;
}

// computeAllocation(input) -> { tranches, summary, flags }.
//
// tranches: [{ destination, amount, purpose }], amounts in dollars, summing EXACTLY to
//   the deposit. Zero-amount tranches are omitted.
// summary: human-readable lines describing the split (for the Discord message).
// flags:   anything a human should see. A hard-flag path (bad input) returns
//   { tranches: [], summary: [], flags: [reason] } and computes nothing.
export function computeAllocation(input) {
  const flags = [];
  const summary = [];

  if (!input || typeof input !== 'object') {
    return { tranches: [], summary: [], flags: ['no input object; nothing allocated'] };
  }

  // --- Validate the load-bearing inputs; flag, do not guess. ---------------
  const deposit = input.deposit;
  if (!deposit || typeof deposit !== 'object') {
    return { tranches: [], summary: [], flags: ['missing deposit; nothing allocated'] };
  }
  const amount = parseMoney(deposit.amount);
  if (amount === null) {
    return { tranches: [], summary: [], flags: [`unparseable deposit amount (${deposit.amount}); nothing allocated`] };
  }
  if (amount < 0) {
    return { tranches: [], summary: [], flags: [`negative deposit amount (${amount}); nothing allocated`] };
  }
  const day = parseDay(deposit.date);
  if (day === null) {
    return { tranches: [], summary: [], flags: [`unparseable deposit date (${deposit.date}); nothing allocated`] };
  }
  // The debts array MUST be present (an explicit empty array means "no live debts",
  // which is a valid state that routes strike to the reservoir; a missing array is a
  // caller bug and is flagged rather than assumed empty).
  if (!Array.isArray(input.debts)) {
    return { tranches: [], summary: [], flags: ['missing debts array; nothing allocated'] };
  }
  const checkpointDay = parseDay(input.checkpointDate);
  if (checkpointDay === null) {
    return { tranches: [], summary: [], flags: [`unparseable checkpointDate (${input.checkpointDate}); nothing allocated`] };
  }

  const depositCents = toCents(amount);
  if (depositCents === 0) {
    // A zero-dollar deposit has nothing to allocate; not an error, just empty.
    return { tranches: [], summary: ['deposit is $0.00; nothing to allocate'], flags: [] };
  }

  // --- 1. TAX TRANCHE ------------------------------------------------------
  // Before the checkpoint: a flat 15% of the deposit accrues toward the annual bill.
  // This deliberately under-accrues (~half the true 30% rate) so more of each early
  // influx front-loads Discover; the Jan-Feb influxes close the gap. From the
  // checkpoint on the rule flips to ABSOLUTE: pay the running tax deficit
  // (30% x all 2026 Redshirt received, less what is already held) in full before
  // anything else, capped at the deposit itself.
  let taxCents;
  const postCheckpoint = day >= checkpointDay;
  if (!postCheckpoint) {
    taxCents = Math.round(depositCents * 0.15);
    summary.push(`Tax: 15% pre-checkpoint accrual = ${fmt(taxCents)}`);
  } else {
    const accrued = parseMoney(input.taxAccruedTotal);
    const held = parseMoney(input.taxHeld);
    if (accrued === null || held === null) {
      return {
        tranches: [],
        summary: [],
        flags: [`post-checkpoint tax needs taxAccruedTotal and taxHeld; got (${input.taxAccruedTotal}, ${input.taxHeld}); nothing allocated`],
      };
    }
    const deficitCents = Math.max(0, toCents(accrued) - toCents(held));
    taxCents = Math.min(depositCents, deficitCents);
    if (deficitCents === 0) {
      // The 2026 obligation is fully funded. No further 15% accrues after Dec 31: any
      // deposit after the checkpoint is treated as 2027 income, and the 2027 accrual
      // rate is not configured yet, so the tax tranche is zero and we say so out loud.
      flags.push('2027 accrual rate not yet configured; post-checkpoint tax tranche set to $0 (2026 obligation fully funded)');
      summary.push('Tax: post-checkpoint deficit is $0 (2026 fully funded); tax tranche = $0.00');
    } else {
      summary.push(`Tax: ABSOLUTE post-checkpoint deficit ${fmt(deficitCents)}, tranche = ${fmt(taxCents)}`);
      if (taxCents === depositCents) {
        flags.push('tax deficit consumed the entire deposit; buffer and strike get $0 this influx');
      }
    }
  }

  // Whatever the tax tranche did not take is available to the rest of the waterfall.
  let remainingCents = depositCents - taxCents;

  // --- 2. BUFFER TRANCHE ---------------------------------------------------
  // Percentages apply to the ORIGINAL deposit, not the post-tax remainder, so the split
  // reads as the playbook's fixed 15/50/35-style table. The boost (35% / 25% on the
  // first two influxes) only runs while the buffer is below tier 1; once it is full,
  // every influx uses the base 15%, which then labels as reservoir, not buffer.
  const bufferBalance = parseMoney(input.bufferBalance);
  const tier1TargetRaw = parseMoney(input.bufferTier1Target);
  const tier1Target = tier1TargetRaw === null ? DEFAULT_BUFFER_TIER1_TARGET : tier1TargetRaw;
  if (bufferBalance === null) {
    return { tranches: [], summary: [], flags: [`unparseable bufferBalance (${input.bufferBalance}); nothing allocated`] };
  }
  // influxIndex must be a positive whole number (a 1-based count of influxes). A string
  // that is a clean integer ('2') is accepted; a fraction, zero, negative, or junk is
  // flagged rather than coerced — a half-influx has no meaning in the split table.
  const influxRaw = parseMoney(input.influxIndex);
  const influxIndex = influxRaw !== null && Number.isInteger(influxRaw) ? influxRaw : null;
  if (influxIndex === null || influxIndex < 1) {
    return { tranches: [], summary: [], flags: [`invalid influxIndex (${input.influxIndex}); expected a 1-based whole count; nothing allocated`] };
  }

  const bufferBelowTier1 = bufferBalance < tier1Target;
  const bufferPct = bufferPctForInflux(influxIndex, bufferBelowTier1);
  let bufferCents = Math.round(depositCents * bufferPct);
  // The buffer can never exceed what the tax tranche left behind. If a post-checkpoint
  // tax deficit ate most of the deposit, buffer shrinks to what remains and strike gets
  // nothing; the percentages are ceilings against the original deposit, not guarantees.
  if (bufferCents > remainingCents) bufferCents = remainingCents;

  // Destination label: money that fills the tier-1 buffer is labeled (buffer); once the
  // buffer is full the same CNB account is the household reservoir.
  const bufferDestination = bufferBelowTier1 ? 'CNB - Joint (buffer)' : 'CNB - Joint (reservoir)';
  const bufferPurpose = bufferBelowTier1
    ? `buffer fill toward tier 1 ($${tier1Target}); influx #${influxIndex} at ${Math.round(bufferPct * 100)}%`
    : `reservoir (buffer already at/over tier 1); ${Math.round(bufferPct * 100)}%`;
  summary.push(`Buffer: ${Math.round(bufferPct * 100)}% -> ${bufferDestination} = ${fmt(bufferCents)}`);

  remainingCents -= bufferCents;

  // --- 3. STRIKE TRANCHE = the remainder -----------------------------------
  // Everything the tax and buffer tranches did not take. It attacks debt in avalanche
  // order, with one exception: the Roth window can jump the queue once Discover is dead.
  const strikeCents = remainingCents; // by construction >= 0
  const strikeTranches = allocateStrike({
    strikeCents,
    day,
    debts: input.debts,
    roth: input.roth,
    summary,
    flags,
  });

  // --- Assemble tranches (tax, buffer, then strike sub-tranches). ----------
  const raw = [];
  if (taxCents > 0) {
    raw.push({ destination: 'Huntington Savings (tax)', amount: taxCents, purpose: 'tax set-aside toward 2026 Redshirt liability' });
  }
  if (bufferCents > 0) {
    raw.push({ destination: bufferDestination, amount: bufferCents, purpose: bufferPurpose });
  }
  for (const s of strikeTranches) {
    raw.push({ destination: s.destination, amount: s.amount, purpose: s.purpose });
  }

  // --- 4. PENNY DISCIPLINE -------------------------------------------------
  // Everything above is already in integer cents, so the tranches sum exactly by
  // construction. But the strike splitter may have rounded a Roth-vs-debt boundary, so
  // reconcile any residual cent onto the LAST non-zero tranche as a final guarantee.
  const tranches = reconcilePennies(raw, depositCents, flags);

  return { tranches, summary, flags };
}

// ---------------------------------------------------------------------------
// Strike allocation (the remainder), including the Roth-window exception.
// ---------------------------------------------------------------------------

// Split the strike cents across debt (avalanche) and, when the window is open and
// Discover is dead, the Roth. Returns [{ destination, amount(cents), purpose }].
function allocateStrike({ strikeCents, day, debts, roth, summary, flags }) {
  if (strikeCents <= 0) {
    summary.push('Strike: $0.00 (tax/buffer consumed the deposit)');
    return [];
  }

  const order = avalanche(debts); // highest APR first, live only
  const out = [];
  let left = strikeCents;

  // Is the Roth window open, funded below target, and is Discover dead? The playbook
  // rule: the Roth jumps ahead of the remaining debts ONLY once the top blocker is
  // gone. "Discover dead" means the debt literally named 'Discover' has balance 0 OR
  // there is no live debt at/above the 28% Discover-class APR floor. Discover alive
  // always beats the Roth.
  const rothPlan = evaluateRothWindow({ day, roth, order, flags });

  if (rothPlan.rothFirst && left > 0) {
    const rothCents = Math.min(left, rothPlan.rothRoomCents);
    if (rothCents > 0) {
      out.push({
        destination: 'Roth IRA 2026',
        amount: rothCents,
        purpose: `Roth window open, Discover dead: fund toward $${toDollars(rothPlan.targetCents)} target`,
      });
      summary.push(`Strike: Roth window -> Roth IRA 2026 = ${fmt(rothCents)}`);
      left -= rothCents;
    }
  }

  // Remaining strike dollars go to the top live debt (avalanche). A single influx pays
  // down one target at a time; if it would overpay the top debt, the overflow cascades
  // to the next debt in avalanche order (and, if all debts are satisfied, to the
  // reservoir at the end).
  for (const d of order) {
    if (left <= 0) break;
    const balCents = toCents(parseMoney(d.balance));
    if (balCents <= 0) continue;
    const pay = Math.min(left, balCents);
    out.push({
      destination: d.name,
      amount: pay,
      purpose: `avalanche strike @ ${d.apr}% APR`,
    });
    summary.push(`Strike: ${d.name} @ ${d.apr}% = ${fmt(pay)}`);
    left -= pay;
  }

  // Anything still left (all debts dead and Roth funded or out of window) flows to the
  // reservoir — the post-revolving destination for the full strike flow.
  if (left > 0) {
    out.push({
      destination: 'CNB - Joint (reservoir)',
      amount: left,
      purpose: 'strike overflow: all debts satisfied, Roth funded or window closed',
    });
    summary.push(`Strike: reservoir (goals satisfied) = ${fmt(left)}`);
    left = 0;
  }

  return out;
}

// Decide whether the Roth takes strike dollars before the remaining debts, and how much
// room it has. Returns { rothFirst, rothRoomCents, targetCents }. Never guesses: if the
// Roth block is missing or malformed it simply does not redirect (rothFirst=false).
function evaluateRothWindow({ day, roth, order, flags }) {
  const none = { rothFirst: false, rothRoomCents: 0, targetCents: 0 };
  if (!roth || typeof roth !== 'object') return none;

  const target = parseMoney(roth.target);
  const funded = parseMoney(roth.funded);
  const windowStart = parseDay(roth.windowStart);
  const deadline = parseDay(roth.deadline);
  if (target === null || funded === null || windowStart === null || deadline === null) {
    // A malformed Roth block should not silently redirect money; flag it and skip.
    flags.push('Roth block present but incomplete/unparseable; Roth redirect skipped this influx');
    return none;
  }

  const targetCents = toCents(target);
  const roomCents = targetCents - toCents(funded);
  if (roomCents <= 0) return { ...none, targetCents }; // already funded
  if (day < windowStart || day > deadline) return { ...none, targetCents }; // out of window

  // Discover-class blocker check: is any debt at/above the 28% floor (or literally named
  // 'Discover') still alive? If so, the Roth is consciously forfeited this influx.
  const live = avalanche(order); // order is already live+sorted, but re-derive defensively
  const discoverAlive = live.some((d) => {
    const apr = parseMoney(d.apr);
    const bal = parseMoney(d.balance);
    if (bal === null || apr === null || bal <= 0) return false;
    return String(d.name).toLowerCase() === 'discover' || apr >= ROTH_APR_FLOOR;
  });
  if (discoverAlive) return { ...none, targetCents }; // Discover alive beats the Roth

  return { rothFirst: true, rothRoomCents: roomCents, targetCents };
}

// ---------------------------------------------------------------------------
// Penny reconciliation.
// ---------------------------------------------------------------------------

// Given cent-denominated tranches that should sum to depositCents, drop zero-amount
// tranches, convert to dollars, and push any residual cent (from a rounded boundary)
// onto the LAST tranche so the returned amounts sum EXACTLY to the deposit.
function reconcilePennies(rawTranches, depositCents, flags) {
  const nonZero = rawTranches.filter((t) => t.amount > 0);
  if (nonZero.length === 0) {
    // Nothing to allocate (e.g. a $0 deposit slipped through) — not expected here since
    // computeAllocation short-circuits $0, but keep the invariant honest.
    return [];
  }
  let sum = 0;
  for (const t of nonZero) sum += t.amount;
  const residual = depositCents - sum;
  if (residual !== 0) {
    // A one- or two-cent rounding residual is normal from percentage splits; absorb it
    // on the last tranche. Anything larger would signal an arithmetic bug upstream.
    if (Math.abs(residual) > 5) {
      flags.push(`penny reconciliation residual ${residual}c exceeds the 5c sanity bound; check the split math`);
    }
    nonZero[nonZero.length - 1].amount += residual;
  }
  return nonZero.map((t) => ({
    destination: t.destination,
    amount: toDollars(t.amount),
    purpose: t.purpose,
  }));
}

// Format integer cents as a $#.## string for summary/flag lines.
function fmt(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rem}`;
}
