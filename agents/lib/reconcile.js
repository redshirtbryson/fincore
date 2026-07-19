// Reconciliation engine: pure, deterministic, unit-tested. No I/O, no model.
//
// Purpose (SPEC section 11): catch a small feed error before it silently
// compounds. Two independent sources of truth are compared and any drift beyond
// tolerance is flagged rather than averaged away or ignored. A number we cannot
// reconcile is a flagged state, never a silent pass.
// Dirty inputs are flagged, never guessed around: prefer null plus a flag over a
// fabricated value.

// Round to cents so floating-point noise never becomes a spurious drift.
function toCents(dollars) {
  return Math.round(dollars * 100);
}

// Parse a money amount that may arrive as a number or a string (Firefly returns
// amounts as strings). Returns a finite number or null when unparseable.
function parseAmount(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Reconcile our computed net worth against an independently sourced reference.
// computed: our engine's net worth number (or null).
// reference: an independent figure, e.g. Firefly's own summary endpoint (or null).
// toleranceDollars: how far the two may drift and still pass.
// Returns { ok, driftDollars, flags }. ok is null (with a flag) when either
// input is missing or non-finite: cannot reconcile is a flagged state, not a
// pass. Drift is computed on cents and its sign is preserved (computed minus
// reference), so a caller can see which way we ran high or low.
export function reconcileNetWorth({ computed, reference, toleranceDollars = 1 }) {
  const flags = [];

  const computedOk = typeof computed === 'number' && Number.isFinite(computed);
  const referenceOk = typeof reference === 'number' && Number.isFinite(reference);

  if (!computedOk || !referenceOk) {
    if (!computedOk) flags.push(`computed net worth is missing or non-finite (${computed}); cannot reconcile`);
    if (!referenceOk) flags.push(`reference net worth is missing or non-finite (${reference}); cannot reconcile`);
    return { ok: null, driftDollars: null, flags };
  }

  const driftCents = toCents(computed) - toCents(reference);
  const driftDollars = driftCents / 100;
  const toleranceCents = toCents(toleranceDollars);

  if (Math.abs(driftCents) <= toleranceCents) {
    return { ok: true, driftDollars, flags };
  }

  flags.push(
    `net worth drift of ${driftDollars.toFixed(2)} exceeds tolerance ${toleranceDollars.toFixed(2)}: ` +
      `computed ${computed.toFixed(2)} vs reference ${reference.toFixed(2)}`
  );
  return { ok: false, driftDollars, flags };
}

// Reconcile observed payroll deposits against the in-effect paystub template.
// Purpose (SPEC 10.9): if a deposit drifts from template net pay, the user must
// be told to upload a fresh stub, because withholdings or pay changed.
// template: { source, net_pay (number|null), pay_cadence }.
// deposits: [{ amount (string|number), date 'YYYY-MM-DD' }] observed since the
//   template took effect.
// tolerancePercent: a deposit matches within this percent of net pay, OR within
//   toleranceDollarsMin, whichever band is wider. A small paycheck should not be
//   flagged over a couple of dollars, so a dollar floor governs the low end.
// Returns { matched, drifted, flags }. When template.net_pay is null or
// non-finite nothing can be verified: one flag, empty matched and drifted.
// Deposits whose amount will not parse go to flags, not to a bogus comparison.
export function reconcilePaystubDeposits({
  template,
  deposits = [],
  tolerancePercent = 1,
  toleranceDollarsMin = 5,
}) {
  const flags = [];
  const matched = [];
  const drifted = [];

  const netPay = template ? template.net_pay : undefined;
  const netPayOk = typeof netPay === 'number' && Number.isFinite(netPay);
  const source = template && template.source ? template.source : 'unknown source';

  if (!netPayOk) {
    flags.push(
      `paystub template for ${source} has no usable net pay (${netPay}); ` +
        `deposits cannot be verified until a stub is on file`
    );
    return { matched, drifted, flags };
  }

  const band = Math.max(Math.abs(netPay) * (tolerancePercent / 100), toleranceDollarsMin);

  // Net pay may be SPLIT across accounts (Bryson's Blenko stub, confirmed
  // 2026-07-19: $930.08 to checking + $150.00 to CNB = $1,080.08 net). A
  // per-deposit compare would flag both legs of a correct split forever, so
  // deposits are grouped by pay date and each DAY'S TOTAL is compared to the
  // template net. A lone unsplit deposit is a group of one, preserving the
  // original behavior.
  const byDate = new Map();
  for (const deposit of deposits) {
    const amount = parseAmount(deposit ? deposit.amount : undefined);
    if (amount === null) {
      flags.push(
        `deposit on ${deposit && deposit.date ? deposit.date : 'unknown date'} ` +
          `has an unparseable amount (${deposit ? deposit.amount : undefined}); skipped`
      );
      continue;
    }
    const key = deposit && deposit.date ? deposit.date : 'unknown';
    if (!byDate.has(key)) byDate.set(key, { deposits: [], total: 0 });
    const g = byDate.get(key);
    g.deposits.push(deposit);
    g.total = Math.round((g.total + amount) * 100) / 100;
  }

  for (const [, g] of byDate) {
    const deltaDollars = Math.round((g.total - netPay) * 100) / 100;
    const deltaPercent = netPay === 0 ? null : (deltaDollars / netPay) * 100;
    if (Math.abs(deltaDollars) <= band) {
      matched.push(...g.deposits);
    } else {
      for (const deposit of g.deposits) drifted.push({ deposit, deltaDollars, deltaPercent });
    }
  }

  if (drifted.length > 0) {
    flags.push(
      `${drifted.length} deposit(s) for ${source} drifted from template net pay ` +
        `${netPay.toFixed(2)}; upload a new paystub to re-verify`
    );
  }

  return { matched, drifted, flags };
}
