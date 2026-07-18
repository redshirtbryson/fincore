// Tax set-aside tracker: pure, deterministic, unit-tested. No I/O, no model, no
// clock. Every date is an input so results are reproducible.
//
// Why this exists (debt playbook 2026-07-18): Bryson self-funds his own taxes on
// Redshirt (WV CSP) income, which arrives with nothing withheld. He moves a fixed
// share (30% by policy) into Huntington Savings against the eventual bill. A hard
// checkpoint on 2027-01-15 requires that Savings actually covers the accrued
// formula. This module answers two questions and nothing else: how much SHOULD be
// held versus how much IS held (the deficit), and how loud to be about that deficit
// as the checkpoint approaches.
//
// Flag, do not guess (house style, matching.js): an input that cannot be read as a
// finite non-negative number is not coerced to zero or a default; the function
// returns { flag } and computes nothing. A silent zero here would understate a tax
// liability, which is the expensive direction to be wrong.
//
// All money is handled in whole cents internally so float traps (0.1 + 0.2, a rate
// times a dollar figure) cannot drift a set-aside by a penny. Callers pass and
// receive dollars; the rounding boundary lives here.

// Dollars (number or numeric string) to a finite non-negative Number, or null.
// Direction is never meaningful for these figures (a total received, a balance
// held), so a negative value is invalid input, not a magnitude. Strips '$' and
// thousands separators. Mirrors parseAmount in lib/matching.js deliberately: same
// house rule, kept local so this module stands alone.
function parseMoney(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    return v;
  }
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// A rate to a finite number in [0, 1], or null. The default 0.30 is the playbook
// policy, applied by the caller (not here) when rate is omitted, so an explicitly
// bad rate still flags rather than silently falling back.
function parseRate(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1) return null;
  return v;
}

// 'YYYY-MM-DD' to a UTC day count, or null if it does not parse as that exact
// shape. Reimplemented locally (not imported from matching.js) so this module has
// no internal dependencies. UTC throughout so no local time zone can shift a day.
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
  // Reject rolled-over dates like 2026-02-31 that Date.UTC silently accepts.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(ms / 86400000);
}

// Whole dollars for a message. Uses cents internally then formats with two decimals
// and thousands separators so a heartbeat line reads '$13,700.00'.
function fmtDollars(cents) {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// How much tax is owed on Redshirt income received so far, how much is held against
// it, and the shortfall.
//   redshirtReceivedTotal: total non-withheld income received to date (dollars).
//   rate: set-aside fraction in [0,1]; defaults to 0.30 (playbook policy).
//   savingsBalance: current Huntington Savings balance earmarked for taxes (dollars).
// Returns { accrued, held, deficit } in DOLLARS, where:
//   accrued = rate x total, rounded to whole cents.
//   held    = savingsBalance, normalized to cents (float-safe).
//   deficit = max(0, accrued - held). Never negative: an over-funded set-aside is a
//             deficit of zero, not a negative "surplus" the callers would have to
//             special-case.
// Any unparseable input returns { flag } and computes nothing (fail loud).
export function taxOwed({ redshirtReceivedTotal, rate = 0.30, savingsBalance } = {}) {
  const total = parseMoney(redshirtReceivedTotal);
  if (total === null) {
    return { flag: `unparseable redshirtReceivedTotal (${redshirtReceivedTotal})` };
  }
  const r = parseRate(rate);
  if (r === null) {
    return { flag: `unparseable rate (${rate}); must be a number in [0,1]` };
  }
  const held = parseMoney(savingsBalance);
  if (held === null) {
    return { flag: `unparseable savingsBalance (${savingsBalance})` };
  }

  // Do the rate multiply in cents. total*100 is the received amount in cents;
  // multiply by the rate, then round once to land on a whole-cent accrual.
  const accruedCents = Math.round(total * 100 * r);
  const heldCents = Math.round(held * 100);
  const deficitCents = Math.max(0, accruedCents - heldCents);

  return {
    accrued: accruedCents / 100,
    held: heldCents / 100,
    deficit: deficitCents / 100,
  };
}

// How loud to be about a tax-set-aside deficit given how close the checkpoint is.
//   deficit: shortfall in dollars (from taxOwed). A deficit of 0 is always 'ok'.
//   today, checkpointDate: 'YYYY-MM-DD' strings. Day math is UTC.
// Returns { level, daysToCheckpoint, message }.
//   daysToCheckpoint = checkpoint day - today (negative once the checkpoint passes).
// Levels (only reached when deficit > 0):
//   'ok'       deficit is 0. Fully funded; nothing to say.
//   'info'     deficit > 0 and more than 60 days out. Time to fix it calmly.
//   'warn'     deficit > 0 and 60 or fewer days out (but not yet reached).
//   'critical' deficit > 0 and on or past the checkpoint (daysToCheckpoint <= 0).
// Messages are heartbeat-ready one-liners naming dollars and days.
// Unparseable deficit or dates return { flag } (fail loud) rather than a wrong level.
export function checkpointStatus({ deficit, today, checkpointDate } = {}) {
  const def = parseMoney(deficit);
  if (def === null) {
    return { flag: `unparseable deficit (${deficit})` };
  }
  const todayDay = parseDay(today);
  if (todayDay === null) {
    return { flag: `unparseable today (${today}); expected 'YYYY-MM-DD'` };
  }
  const checkpointDay = parseDay(checkpointDate);
  if (checkpointDay === null) {
    return { flag: `unparseable checkpointDate (${checkpointDate}); expected 'YYYY-MM-DD'` };
  }

  const daysToCheckpoint = checkpointDay - todayDay;
  const defCents = Math.round(def * 100);

  // Fully funded: say so and stop, regardless of the date. A zero deficit past the
  // checkpoint is a pass, not a crisis.
  if (defCents <= 0) {
    return {
      level: 'ok',
      daysToCheckpoint,
      message: `Tax set-aside fully funded; ${daysToCheckpoint}d to checkpoint ${checkpointDate}.`,
    };
  }

  const defStr = fmtDollars(defCents);

  // On or past the checkpoint with money still owed: the hard deadline has hit.
  if (daysToCheckpoint <= 0) {
    const overdue = daysToCheckpoint === 0 ? 'today' : `${-daysToCheckpoint}d ago`;
    return {
      level: 'critical',
      daysToCheckpoint,
      message: `CRITICAL: tax set-aside short ${defStr} at checkpoint ${checkpointDate} (${overdue}).`,
    };
  }

  // Within the 60-day run-up: loud but not yet failed.
  if (daysToCheckpoint <= 60) {
    return {
      level: 'warn',
      daysToCheckpoint,
      message: `WARN: tax set-aside short ${defStr}, ${daysToCheckpoint}d to checkpoint ${checkpointDate}.`,
    };
  }

  // More than 60 days out: informational, plenty of runway to close the gap.
  return {
    level: 'info',
    daysToCheckpoint,
    message: `Tax set-aside short ${defStr}, ${daysToCheckpoint}d to checkpoint ${checkpointDate}.`,
  };
}
