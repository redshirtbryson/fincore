// DTI engine: pure, deterministic, unit-tested. No I/O, no model.
//
// Definition (SPEC 10.5, decided in v4.2): back-end DTI = total monthly debt
// obligations / gross monthly income.
//   Numerator: all active obligations (debt minimums AND housing, mortgage or rent).
//   Denominator, per income source:
//     - W-2 with a paystub template: per-stub gross scaled by pay cadence.
//     - Otherwise: trailing 12-month average of observed gross when 12 full months
//       exist; with less history, the average over available months seeded with the
//       onboarding-declared amount. The basis is always reported alongside the number.
// Dirty inputs are flagged, never guessed around (SPEC section 11): zero or unknown
// income yields dti null plus a flag, not a confident wrong number.

export const CADENCE_PER_YEAR = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

// Per-paycheck amount -> monthly amount. Biweekly is 26/12, not 2 (SPEC 10.5).
export function monthlyFromCadence(perPeriodAmount, cadence) {
  const perYear = CADENCE_PER_YEAR[cadence];
  if (!perYear) throw new RangeError(`unknown pay cadence: ${cadence}`);
  if (typeof perPeriodAmount !== 'number' || !Number.isFinite(perPeriodAmount)) {
    throw new RangeError(`per-period amount must be a finite number, got ${perPeriodAmount}`);
  }
  return (perPeriodAmount * perYear) / 12;
}

// Trailing average of observed monthly gross income totals.
// observedMonths: [{ month: 'YYYY-MM', gross: number }], full months only.
// Returns { monthly, basisMonths } or null when nothing is observed.
export function trailingMonthlyAverage(observedMonths, { window = 12 } = {}) {
  const rows = (observedMonths || []).filter(
    (m) => m && typeof m.gross === 'number' && Number.isFinite(m.gross) && m.gross >= 0
  );
  if (rows.length === 0) return null;
  const recent = [...rows].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, window);
  const total = recent.reduce((sum, m) => sum + m.gross, 0);
  return { monthly: total / recent.length, basisMonths: recent.length };
}

// Resolve one income source to a monthly gross figure plus its basis.
// source: { name, treatment: 'w2'|'self_employment', declaredMonthlyGross?, cadence? }
// paystub: { gross, pay_cadence } | null   (the in-effect template for W-2 sources)
// observedMonths: full-month observed gross totals for this source, may be empty.
export function monthlyGrossForSource({ source, paystub = null, observedMonths = [] }, { window = 12 } = {}) {
  if (paystub) {
    return {
      name: source.name,
      monthly: monthlyFromCadence(paystub.gross, paystub.pay_cadence),
      basis: `paystub template x ${paystub.pay_cadence} cadence`,
      partial: false,
    };
  }
  const trailing = trailingMonthlyAverage(observedMonths, { window });
  if (trailing && trailing.basisMonths >= window) {
    return {
      name: source.name,
      monthly: trailing.monthly,
      basis: `trailing ${trailing.basisMonths}-month observed average`,
      partial: false,
    };
  }
  // Partial history: blend what was observed with the declared amount by month count,
  // so 3 observed months count for 3 and the declared figure stands in for the rest.
  const declared = source.declaredMonthlyGross;
  const hasDeclared = typeof declared === 'number' && Number.isFinite(declared) && declared >= 0;
  if (trailing && hasDeclared) {
    const observedShare = trailing.basisMonths / window;
    const monthly = trailing.monthly * observedShare + declared * (1 - observedShare);
    return {
      name: source.name,
      monthly,
      basis: `partial: ${trailing.basisMonths} observed months blended with declared amount`,
      partial: true,
    };
  }
  if (trailing) {
    return {
      name: source.name,
      monthly: trailing.monthly,
      basis: `partial: trailing ${trailing.basisMonths}-month observed average only (no declared amount)`,
      partial: true,
    };
  }
  if (hasDeclared) {
    return {
      name: source.name,
      monthly: declared,
      basis: 'partial: onboarding-declared amount only (no observed history)',
      partial: true,
    };
  }
  return { name: source.name, monthly: null, basis: 'no data', partial: true };
}

// Compute back-end DTI.
// obligations: [{ name, kind: 'debt_minimum'|'housing'|'other', monthlyAmount, active }]
// incomes: output rows of monthlyGrossForSource
// Returns { dti, monthlyObligations, monthlyGrossIncome, basis, partial, flags }.
// dti is null (with flags) when it cannot be computed honestly.
export function computeDTI({ obligations = [], incomes = [] }) {
  const flags = [];

  // active may arrive as a JS boolean or as SQLite's 0/1 integer; both count.
  const activeObligations = obligations.filter((o) => o && o.active !== false && o.active !== 0);
  let monthlyObligations = 0;
  for (const o of activeObligations) {
    if (typeof o.monthlyAmount !== 'number' || !Number.isFinite(o.monthlyAmount) || o.monthlyAmount < 0) {
      flags.push(`obligation "${o.name}" has invalid monthly amount (${o.monthlyAmount}); excluded`);
      continue;
    }
    monthlyObligations += o.monthlyAmount;
  }
  if (!activeObligations.some((o) => o.kind === 'housing')) {
    flags.push('no housing obligation recorded; back-end DTI expects one (rent or mortgage)');
  }

  let monthlyGrossIncome = 0;
  let anyIncome = false;
  let partial = false;
  const basisParts = [];
  for (const inc of incomes) {
    if (inc.monthly === null || inc.monthly === undefined) {
      flags.push(`income source "${inc.name}" has no usable figure (${inc.basis})`);
      partial = true; // the denominator is missing a source, so the basis is not whole
      continue;
    }
    if (typeof inc.monthly !== 'number' || !Number.isFinite(inc.monthly) || inc.monthly < 0) {
      flags.push(`income source "${inc.name}" has invalid monthly gross (${inc.monthly}); excluded`);
      partial = true;
      continue;
    }
    monthlyGrossIncome += inc.monthly;
    anyIncome = true;
    partial = partial || Boolean(inc.partial);
    basisParts.push(`${inc.name}: ${inc.basis}`);
  }

  if (!anyIncome || monthlyGrossIncome <= 0) {
    flags.push('gross monthly income is zero or unknown; DTI cannot be computed');
    return { dti: null, monthlyObligations, monthlyGrossIncome, basis: basisParts.join('; '), partial, flags };
  }

  return {
    dti: monthlyObligations / monthlyGrossIncome,
    monthlyObligations,
    monthlyGrossIncome,
    basis: basisParts.join('; '),
    partial,
    flags,
  };
}
