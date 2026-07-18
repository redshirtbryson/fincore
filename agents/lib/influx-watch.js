// Influx cadence watcher: pure, deterministic, unit-tested. No I/O, no model, no
// clock. Every date is an input so results are reproducible.
//
// Why this exists (debt playbook 2026-07-18): Redshirt (WV CSP) deposits land
// irregularly, roughly every 5 to 6 weeks. Between them the household runs a
// structural monthly gap on Blenko-only income (about $2,950), bridged by the CNB
// buffer. Two failure modes matter: a Redshirt deposit is LATER than usual (an
// influx drought, which stretches the buffer), and the buffer itself running thin.
// This module measures the observed deposit cadence, decides whether the next
// deposit is merely late or genuinely overdue, and converts a buffer balance into
// weeks of runway at the known burn rate.
//
// Flag, do not guess (house style, matching.js / freshness.js): with fewer than
// three deposits there is no gap-of-gaps to reason about, so cadence returns a flag
// alongside whatever it could compute, and droughtStatus degrades to level
// 'unknown' rather than inventing an expected date. Unparseable dates and garbage
// balances flag rather than coerce; a wrong "you have plenty of runway" is the
// expensive direction to be wrong.

// 'YYYY-MM-DD' to a UTC day count, or null if it does not parse as that exact
// shape. Reimplemented locally (not imported) so this module stands alone. UTC
// throughout so no local time zone can shift a day.
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

// A UTC day count back to a 'YYYY-MM-DD' string, for messages and expectedBy.
function dayToStr(dayCount) {
  const d = new Date(dayCount * 86400000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// Money (number or numeric string) to a finite non-negative Number, or null.
// Strips '$' and thousands separators. Mirrors parseAmount in matching.js.
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

// Normalize a list of 'YYYY-MM-DD' deposit dates to sorted, de-duplicated UTC day
// counts, dropping (and counting) any that will not parse. Sorting here means the
// caller may pass history in any order. Duplicates are removed because two deposits
// stamped the same day would inject a zero gap that is not a real cadence signal.
// Returns { days: [ascending day counts], dropped: count }.
function normalizeDates(depositDates) {
  const parsed = [];
  let dropped = 0;
  for (const s of Array.isArray(depositDates) ? depositDates : []) {
    const d = parseDay(s);
    if (d === null) {
      dropped++;
      continue;
    }
    parsed.push(d);
  }
  parsed.sort((a, b) => a - b);
  const days = [];
  for (const d of parsed) {
    if (days.length === 0 || days[days.length - 1] !== d) days.push(d);
  }
  return { days, dropped };
}

// Median of a numeric array. On an even count the convention is the AVERAGE of the
// two middle values, so a run of gaps like [39, 39, 40, 41] gives 39.5, not a
// silently-picked side. (The task's "ties -> lower" refers to which VALUE wins when
// middle values are equal, which the average trivially satisfies: avg(39,39)=39.)
// Documented here because a non-integer median flows straight into day arithmetic
// downstream, where it is ceil'd, so the half matters.
function median(nums) {
  const n = nums.length;
  if (n === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Observed deposit cadence from a history of 'YYYY-MM-DD' dates.
// Returns { medianGapDays, lastDate, n } where:
//   medianGapDays = median of consecutive day gaps (may be a .5 value).
//   lastDate      = most recent parseable deposit ('YYYY-MM-DD'), or null.
//   n             = count of distinct parseable deposit dates.
// Fewer than three dates cannot yield a stable gap-of-gaps, so the result carries
// { flag: 'insufficient history' } PLUS whatever was computable (lastDate always,
// medianGapDays when at least one gap exists, i.e. two dates). Unparseable dates are
// dropped and noted in a flag; if any were dropped that flag is appended too.
export function cadence(depositDates) {
  const { days, dropped } = normalizeDates(depositDates);
  const n = days.length;
  const lastDate = n > 0 ? dayToStr(days[n - 1]) : null;

  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(days[i] - days[i - 1]);
  const medianGapDays = gaps.length > 0 ? median(gaps) : null;

  const result = { medianGapDays, lastDate, n };

  const flags = [];
  if (n < 3) flags.push('insufficient history');
  if (dropped > 0) flags.push(`${dropped} unparseable deposit date(s) dropped`);
  if (flags.length > 0) result.flag = flags.join('; ');

  return result;
}

// Whether the next Redshirt deposit is on time, merely late, or overdue.
//   depositDates: history of 'YYYY-MM-DD' deposit dates.
//   today: 'YYYY-MM-DD'. Day math is UTC.
//   overdueFactor: multiplier on the median gap that marks "overdue"; default 1.4
//     (about 7 weeks on a 5-week cadence, matching the playbook's 5-to-6-week
//     rhythm plus slack before we sound the alarm).
// Returns { level, daysSinceLast, expectedBy, message } where:
//   daysSinceLast = today - lastDate, in days.
//   expectedBy    = lastDate + ceil(medianGapDays x overdueFactor) days,
//                   'YYYY-MM-DD'. The ceil keeps a fractional median from
//                   under-shooting the boundary by a day.
// Levels:
//   'ok'      today is within one median gap of the last deposit (on schedule).
//   'watch'   past a median gap but not yet past expectedBy (running late).
//   'overdue' on or past expectedBy (later than the cadence should ever allow).
//   'unknown' insufficient history to judge; carries a flag, no expectedBy.
// Unparseable today or an unusable overdueFactor returns { flag }.
export function droughtStatus({ depositDates, today, overdueFactor = 1.4 } = {}) {
  const todayDay = parseDay(today);
  if (todayDay === null) {
    return { flag: `unparseable today (${today}); expected 'YYYY-MM-DD'` };
  }
  if (typeof overdueFactor !== 'number' || !Number.isFinite(overdueFactor) || overdueFactor <= 0) {
    return { flag: `unusable overdueFactor (${overdueFactor}); must be a positive number` };
  }

  const c = cadence(depositDates);

  // Without a median gap (fewer than two deposits) there is no schedule to miss.
  // Report what we know (days since the last deposit, if any) and defer judgement.
  if (c.medianGapDays === null || c.lastDate === null) {
    const lastDay = c.lastDate === null ? null : parseDay(c.lastDate);
    const daysSinceLast = lastDay === null ? null : todayDay - lastDay;
    return {
      level: 'unknown',
      daysSinceLast,
      expectedBy: null,
      flag: c.flag || 'insufficient history',
      message: 'Deposit cadence unknown: insufficient history.',
    };
  }

  const lastDay = parseDay(c.lastDate);
  const daysSinceLast = todayDay - lastDay;
  const overdueDays = Math.ceil(c.medianGapDays * overdueFactor);
  const expectedByDay = lastDay + overdueDays;
  const expectedBy = dayToStr(expectedByDay);

  // Boundaries: 'ok' up to and including one whole median gap; 'overdue' on or past
  // the expectedBy day; 'watch' in between. Comparing against Math.floor of the
  // median keeps the "within a gap" test on whole days without a fractional slip.
  const medianGapWhole = Math.floor(c.medianGapDays);
  let level;
  if (daysSinceLast <= medianGapWhole) {
    level = 'ok';
  } else if (todayDay >= expectedByDay) {
    level = 'overdue';
  } else {
    level = 'watch';
  }

  let message;
  if (level === 'ok') {
    message = `Redshirt deposit on schedule: ${daysSinceLast}d since ${c.lastDate} (median ${c.medianGapDays}d).`;
  } else if (level === 'watch') {
    message = `Redshirt deposit running late: ${daysSinceLast}d since ${c.lastDate}, overdue if none by ${expectedBy}.`;
  } else {
    message = `OVERDUE: no Redshirt deposit in ${daysSinceLast}d since ${c.lastDate}; expected by ${expectedBy}.`;
  }

  const result = { level, daysSinceLast, expectedBy, message };
  // Surface a dropped-dates flag from cadence so bad history is never silent.
  if (c.flag && c.flag !== 'insufficient history') result.flag = c.flag;
  return result;
}

// How many weeks the CNB buffer covers the structural monthly gap.
//   bufferBalance: current buffer balance (dollars).
//   monthlyGap: structural shortfall bridged each month (dollars); default 2950
//     (playbook figure for Blenko-only income).
// Returns { weeks, message } where weeks = bufferBalance / (monthlyGap / 4.345),
// to one decimal. 4.345 is the average weeks per month (365.25 / 12 / 7), so the
// weekly burn is the monthly gap spread evenly across a month.
// Guards: an unparseable balance flags; a monthly gap that is unparseable or zero
// flags (division by zero, or a nonsensical "no gap" that would imply infinite
// runway).
export function bufferRunway({ bufferBalance, monthlyGap = 2950 } = {}) {
  const balance = parseMoney(bufferBalance);
  if (balance === null) {
    return { flag: `unparseable bufferBalance (${bufferBalance})` };
  }
  const gap = parseMoney(monthlyGap);
  if (gap === null) {
    return { flag: `unparseable monthlyGap (${monthlyGap})` };
  }
  if (gap === 0) {
    return { flag: 'monthlyGap is zero; runway undefined' };
  }

  const WEEKS_PER_MONTH = 4.345;
  const weeklyBurn = gap / WEEKS_PER_MONTH;
  const weeksRaw = balance / weeklyBurn;
  const weeks = Math.round(weeksRaw * 10) / 10;

  return {
    weeks,
    message: `CNB buffer covers ${weeks.toFixed(1)} weeks at the $${gap.toLocaleString('en-US')}/mo gap.`,
  };
}
