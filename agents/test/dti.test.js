// Money-grade tests for the DTI engine (SPEC 10.5 + v4.2 decisions). These assert
// the DEFINITION, not just behavior: back-end DTI, housing included, cadence
// scaling at 26/12 for biweekly, partial-history fallback, flag-don't-guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyFromCadence,
  trailingMonthlyAverage,
  monthlyGrossForSource,
  computeDTI,
} from '../lib/dti.js';

test('monthlyFromCadence scales per the decided factors, not naive x2', () => {
  // Biweekly is 26 checks/year: 2000 per check = 4333.33 monthly, NOT 4000.
  assert.ok(Math.abs(monthlyFromCadence(2000, 'biweekly') - (2000 * 26) / 12) < 1e-9);
  assert.equal(monthlyFromCadence(2000, 'semimonthly'), 4000);
  assert.equal(monthlyFromCadence(1000, 'monthly'), 1000);
  assert.ok(Math.abs(monthlyFromCadence(500, 'weekly') - (500 * 52) / 12) < 1e-9);
  assert.throws(() => monthlyFromCadence(2000, 'fortnightly'), RangeError);
  assert.throws(() => monthlyFromCadence(NaN, 'monthly'), RangeError);
});

test('trailingMonthlyAverage uses the most recent window and reports basis', () => {
  const months = [
    { month: '2026-01', gross: 1000 },
    { month: '2026-02', gross: 2000 },
    { month: '2026-03', gross: 3000 },
  ];
  const r = trailingMonthlyAverage(months);
  assert.equal(r.monthly, 2000);
  assert.equal(r.basisMonths, 3);

  // Window trims to the most recent N months.
  const r2 = trailingMonthlyAverage(months, { window: 2 });
  assert.equal(r2.monthly, 2500);
  assert.equal(r2.basisMonths, 2);

  assert.equal(trailingMonthlyAverage([]), null);
  // Invalid rows are dropped, not summed as NaN.
  assert.equal(trailingMonthlyAverage([{ month: '2026-01', gross: NaN }]), null);
});

test('monthlyGrossForSource prefers paystub, then full history, then blend', () => {
  const w2 = { name: 'Blenko', treatment: 'w2', declaredMonthlyGross: 4000 };

  // Paystub template wins and is not partial.
  const fromStub = monthlyGrossForSource({ source: w2, paystub: { gross: 2000, pay_cadence: 'biweekly' } });
  assert.ok(Math.abs(fromStub.monthly - (2000 * 26) / 12) < 1e-9);
  assert.equal(fromStub.partial, false);

  // 12 full observed months: trailing average, not partial.
  const full = monthlyGrossForSource({
    source: { name: 'Redshirt Cloud', treatment: 'self_employment', declaredMonthlyGross: 9999 },
    observedMonths: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, gross: 1200 })),
  });
  assert.equal(full.monthly, 1200);
  assert.equal(full.partial, false);

  // 3 observed months blend with declared by month count: 3/12 observed + 9/12 declared.
  const blended = monthlyGrossForSource({
    source: { name: 'Neptune Political', treatment: 'self_employment', declaredMonthlyGross: 2000 },
    observedMonths: [
      { month: '2026-04', gross: 1000 },
      { month: '2026-05', gross: 1000 },
      { month: '2026-06', gross: 1000 },
    ],
  });
  assert.ok(Math.abs(blended.monthly - (1000 * (3 / 12) + 2000 * (9 / 12))) < 1e-9);
  assert.equal(blended.partial, true);

  // Declared only.
  const declaredOnly = monthlyGrossForSource({ source: w2 });
  assert.equal(declaredOnly.monthly, 4000);
  assert.equal(declaredOnly.partial, true);

  // Nothing at all: null, never zero (zero would silently inflate DTI's honesty).
  const nothing = monthlyGrossForSource({ source: { name: 'Mystery', treatment: 'self_employment' } });
  assert.equal(nothing.monthly, null);
});

test('computeDTI is back-end: housing counts in the numerator', () => {
  const r = computeDTI({
    obligations: [
      { name: 'Rent', kind: 'housing', monthlyAmount: 1500 },
      { name: 'Card minimum', kind: 'debt_minimum', monthlyAmount: 250 },
      { name: 'Car loan', kind: 'debt_minimum', monthlyAmount: 450 },
    ],
    incomes: [{ name: 'Blenko', monthly: 5500, basis: 'paystub', partial: false }],
  });
  assert.ok(Math.abs(r.dti - 2200 / 5500) < 1e-9);
  assert.equal(r.monthlyObligations, 2200);
  assert.equal(r.flags.length, 0);
});

test('computeDTI flags a missing housing obligation instead of quietly understating', () => {
  const r = computeDTI({
    obligations: [{ name: 'Card minimum', kind: 'debt_minimum', monthlyAmount: 250 }],
    incomes: [{ name: 'Blenko', monthly: 5000, basis: 'paystub', partial: false }],
  });
  assert.ok(r.flags.some((f) => f.includes('housing')));
  assert.ok(r.dti !== null); // still computed, but flagged
});

test('a dropped income source marks the basis partial, never whole', () => {
  const r = computeDTI({
    obligations: [{ name: 'Rent', kind: 'housing', monthlyAmount: 1500 }],
    incomes: [
      { name: 'Blenko', monthly: 5000, basis: 'paystub', partial: false },
      { name: 'Redshirt Cloud', monthly: null, basis: 'no data', partial: true },
    ],
  });
  assert.ok(r.dti !== null); // computed from what exists...
  assert.equal(r.partial, true); // ...but honestly labeled incomplete
  assert.ok(r.flags.some((f) => f.includes('Redshirt Cloud')));
});

test('computeDTI treats SQLite integer active=0 as inactive', () => {
  const r = computeDTI({
    obligations: [
      { name: 'Rent', kind: 'housing', monthlyAmount: 1500, active: 1 },
      { name: 'Paid-off card', kind: 'debt_minimum', monthlyAmount: 250, active: 0 },
    ],
    incomes: [{ name: 'Blenko', monthly: 5000, basis: 'paystub', partial: false }],
  });
  assert.equal(r.monthlyObligations, 1500);
});

test('computeDTI refuses to produce a number over zero or unknown income', () => {
  const zero = computeDTI({
    obligations: [{ name: 'Rent', kind: 'housing', monthlyAmount: 1500 }],
    incomes: [],
  });
  assert.equal(zero.dti, null);
  assert.ok(zero.flags.some((f) => f.includes('cannot be computed')));

  const unusable = computeDTI({
    obligations: [{ name: 'Rent', kind: 'housing', monthlyAmount: 1500 }],
    incomes: [{ name: 'Mystery', monthly: null, basis: 'no data', partial: true }],
  });
  assert.equal(unusable.dti, null);
});

test('computeDTI excludes and flags invalid obligations, honors inactive ones', () => {
  const r = computeDTI({
    obligations: [
      { name: 'Rent', kind: 'housing', monthlyAmount: 1500 },
      { name: 'Bad row', kind: 'debt_minimum', monthlyAmount: -50 },
      { name: 'Old loan', kind: 'debt_minimum', monthlyAmount: 400, active: false },
    ],
    incomes: [{ name: 'Blenko', monthly: 5000, basis: 'paystub', partial: false }],
  });
  assert.equal(r.monthlyObligations, 1500);
  assert.ok(r.flags.some((f) => f.includes('Bad row')));
});

test('computeDTI propagates the partial-basis marker', () => {
  const r = computeDTI({
    obligations: [{ name: 'Rent', kind: 'housing', monthlyAmount: 1000 }],
    incomes: [{ name: 'Neptune Political', monthly: 2000, basis: 'partial: declared only', partial: true }],
  });
  assert.equal(r.partial, true);
});
