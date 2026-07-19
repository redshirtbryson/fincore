// Bill due-date surfacing: pure, deterministic. No I/O, no clock — today is an
// input. Firefly's native Bills feature owns the definitions (name, amount range,
// recurrence, next expected date) and marks bills paid by linking transactions;
// this module only decides what deserves a heartbeat line: due within the
// lookahead, or overdue and unpaid. Flag-don't-guess: bills with unparseable
// dates are surfaced as flags, never silently dropped.

function parseDay(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

// bills: [{ name, amountMin, amountMax, nextDue, paidInPeriod, active }]
// Returns { due: [{ name, amount, dueDate, daysUntil, overdue }], flags }.
// due is sorted soonest-first; paid or inactive bills never appear.
export function upcomingBills(bills, { today, lookaheadDays = 10 } = {}) {
  const flags = [];
  const t = parseDay(today);
  if (t === null) return { due: [], flags: ['upcomingBills: unparseable today'] };
  const lookahead = Number(lookaheadDays);
  if (!Number.isFinite(lookahead) || lookahead < 0) {
    return { due: [], flags: ['upcomingBills: invalid lookaheadDays'] };
  }

  const due = [];
  for (const b of bills || []) {
    if (!b || b.active === false || b.paidInPeriod) continue;
    const d = parseDay(b.nextDue);
    if (d === null) {
      flags.push(`bill "${b?.name ?? '(unnamed)'}" has an unparseable due date (${b?.nextDue}); check it in Firefly`);
      continue;
    }
    const daysUntil = d - t;
    if (daysUntil > lookahead) continue;
    // Midpoint of the amount range: Firefly bills carry min/max; a single-amount
    // bill has min === max, so this is exact for the common case.
    const lo = Number(b.amountMin);
    const hi = Number(b.amountMax);
    const amount = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : null;
    due.push({ name: b.name || '(unnamed)', amount, dueDate: b.nextDue.slice(0, 10), daysUntil, overdue: daysUntil < 0 });
  }
  due.sort((a, b) => a.daysUntil - b.daysUntil);
  return { due, flags };
}
