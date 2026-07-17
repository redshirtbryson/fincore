// Transfer and reimbursement matching: pure, deterministic, unit-tested. No I/O,
// no model, no clock. All dates and windows are inputs so results are reproducible.
//
// Why this exists (SPEC section 11): money moving between the user's own accounts
// arrives from the bank feed as two rows, a withdrawal in one account and a deposit
// in another. Left alone it double-counts as expense plus income. Reimbursable
// personal outlays (tagged 'reimbursable') are later paid back by a deposit; the
// payback must net against the outlay, not read as fresh income.
//
// Flag, do not guess (SPEC section 11): a row with an unparseable amount or date is
// put on a flags array and excluded from matching, never coerced into a bad match.
// When more than one candidate pairing exists for either side, none of those pairs
// auto-match; they all go to ambiguous for a human to confirm.

const MATCHED_TAG_PREFIX = 'transfer-match:';
const REIMBURSED_TAG = 'reimbursed';

// True when a description UNAMBIGUOUSLY names an internal money movement: a transfer
// between the user's own accounts, or a credit-card payment. This is the autonomy
// gate for auto-converting a matched pair into a real transfer, which involves
// deleting a leg, so the bar is high: only phrases that cannot plausibly belong to
// ordinary external activity are here.
//
// Deliberately EXCLUDED (they read as internal but routinely appear on real external
// spend or income, so an equal-amount coincidence could get a real transaction
// deleted): AUTOPAY / DIRECTPAY / AUTOMATIC PAYMENT (utility and insurance bill pay
// to real merchants), ACH DEPOSIT INTERNET (any inbound ACH, including from other
// people), STATEMENT CREDIT (a refund, i.e. real money in). Such pairs are queued for
// confirmation, never auto-converted. The caller further requires the DEPOSIT leg (the
// one being deleted, and the one polluting the income view) to match before acting.
const INTERNAL_MOVEMENT = [
  'TFR', 'TRANSFER', 'XFER', 'CRD PYMT', 'CREDIT CRD', 'E-PAYMENT', 'EPAY',
  'APPLECARD', 'GSBANK PAYMENT', 'PAYMENT THANK YOU', 'OD PROTECTION',
  'SYNCHRONY BANK', 'INTERNET PAYMENT', 'CC PYMT',
];

export function isInternalTransferDescription(desc) {
  const d = String(desc || '').toUpperCase();
  return INTERNAL_MOVEMENT.some((k) => d.includes(k));
}

// String or number dollars to a finite non-negative Number magnitude. Direction
// (money out vs money in) is carried by which array a row sits in, not by sign, so
// a negative value is not a valid magnitude here and returns null. Strips '$' and
// thousands separators. Returns null for anything unparseable or NaN.
export function parseAmount(v) {
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

// Two dollar magnitudes to whole cents, then compare. Rounding to cents before the
// comparison keeps float traps (0.1 + 0.2, 1499.99 built from parts) from breaking
// equality. toleranceDollars widens the allowed gap; 0 means exact to the cent.
export function centsEqual(a, b, toleranceDollars = 0) {
  const ca = Math.round(a * 100);
  const cb = Math.round(b * 100);
  const tol = Math.round(Math.abs(toleranceDollars) * 100);
  return Math.abs(ca - cb) <= tol;
}

// 'YYYY-MM-DD' to a UTC day count, or null if it does not parse as that exact
// shape. We avoid Date parsing quirks by validating the format and computing from
// UTC so no local time zone can shift a day.
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
  // Reject rolled-over dates like 2026-02-31 that Date.UTC would silently accept.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(ms / 86400000);
}

// True when a row already carries a 'transfer-match:' tag and so has been paired.
function alreadyTransferMatched(row) {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return tags.some((t) => typeof t === 'string' && t.startsWith(MATCHED_TAG_PREFIX));
}

// True when a reimbursable outlay has already been marked repaid.
function alreadyReimbursed(row) {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return tags.some((t) => typeof t === 'string' && t === REIMBURSED_TAG);
}

// Normalize a row into { row, amount, day } or record a flag and return null. The
// flag names the side and the tx_id so a human can find the offending row.
function normalize(row, side, flags) {
  const amount = parseAmount(row.amount);
  if (amount === null) {
    flags.push(`${side} tx ${row.tx_id ?? '(no id)'} has unparseable amount (${row.amount}); excluded`);
    return null;
  }
  const day = parseDay(row.date);
  if (day === null) {
    flags.push(`${side} tx ${row.tx_id ?? '(no id)'} has unparseable date (${row.date}); excluded`);
    return null;
  }
  return { row, amount, day };
}

// Deterministic sort key: date first, then tx_id. Applied to inputs before pairing
// so the same rows in any order produce the same result.
function byDateThenId(a, b) {
  if (a.row.date < b.row.date) return -1;
  if (a.row.date > b.row.date) return 1;
  const ai = String(a.row.tx_id ?? '');
  const bi = String(b.row.tx_id ?? '');
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

// Shared engine for both matchers. isEligible(withdrawal, deposit) decides whether a
// deposit is a candidate for a withdrawal given the already-normalized amounts and
// days. kind labels the resulting matches. reason labels ambiguous entries.
function runMatch(withdrawals, deposits, { amountTolerance, isEligible, kind, reason }) {
  const flags = [];

  const wNorm = [];
  for (const w of withdrawals || []) {
    const n = normalize(w, 'withdrawal', flags);
    if (n) wNorm.push(n);
  }
  const dNorm = [];
  for (const d of deposits || []) {
    const n = normalize(d, 'deposit', flags);
    if (n) dNorm.push(n);
  }

  wNorm.sort(byDateThenId);
  dNorm.sort(byDateThenId);

  // Build all candidate deposit lists per withdrawal, and count how many
  // withdrawals point at each deposit, so we can enforce uniqueness on both sides.
  const candidatesFor = new Map(); // withdrawal index -> [deposit index...]
  const depositRefCount = new Map(); // deposit index -> count of withdrawals eyeing it
  for (let wi = 0; wi < wNorm.length; wi++) {
    const w = wNorm[wi];
    const cands = [];
    for (let di = 0; di < dNorm.length; di++) {
      const d = dNorm[di];
      if (!centsEqual(w.amount, d.amount, amountTolerance)) continue;
      if (!isEligible(w, d)) continue;
      cands.push(di);
      depositRefCount.set(di, (depositRefCount.get(di) || 0) + 1);
    }
    candidatesFor.set(wi, cands);
  }

  const matches = [];
  const ambiguous = [];
  const matchedW = new Set();
  const matchedD = new Set();

  // A pair auto-matches only when the withdrawal has exactly one candidate deposit
  // and that deposit is wanted by exactly one withdrawal. Anything with more than
  // one candidate on either side is ambiguous, never guessed.
  for (let wi = 0; wi < wNorm.length; wi++) {
    const cands = candidatesFor.get(wi);
    if (cands.length !== 1) continue;
    const di = cands[0];
    if (depositRefCount.get(di) !== 1) continue;
    const w = wNorm[wi];
    const d = dNorm[di];
    matches.push({
      withdrawal: w.row,
      deposit: d.row,
      kind,
      dateDelta: d.day - w.day,
    });
    matchedW.add(wi);
    matchedD.add(di);
  }

  // Withdrawals with multiple candidates, or whose sole candidate is contested,
  // become ambiguous entries listing every candidate for a human to pick from.
  for (let wi = 0; wi < wNorm.length; wi++) {
    if (matchedW.has(wi)) continue;
    const cands = candidatesFor.get(wi);
    if (cands.length === 0) continue;
    const contested = cands.length === 1 && depositRefCount.get(cands[0]) !== 1;
    if (cands.length > 1 || contested) {
      ambiguous.push({
        item: wNorm[wi].row,
        candidates: cands.map((di) => dNorm[di].row),
        reason,
      });
      for (const di of cands) matchedD.add(di); // deposits in play are not "unmatched"
    }
  }

  const unmatched = [];
  for (let wi = 0; wi < wNorm.length; wi++) {
    if (matchedW.has(wi)) continue;
    if ((candidatesFor.get(wi) || []).length > 0) continue; // handled as ambiguous
    unmatched.push(wNorm[wi].row);
  }
  for (let di = 0; di < dNorm.length; di++) {
    if (matchedD.has(di)) continue;
    unmatched.push(dNorm[di].row);
  }

  return { matches, ambiguous, unmatched, flags };
}

// Match internal transfers: one withdrawal from an own account against one deposit
// into a different own account. A deposit is eligible when it lands within
// [withdrawal.date - 1, withdrawal.date + dateWindowDays] (one day early allowed for
// posting skew), the amounts are cents-equal within tolerance, the two own accounts
// differ (a same-account pair is a correction, not a transfer), and neither side is
// already tagged 'transfer-match:'. Returns { matches, ambiguous, unmatched, flags }.
export function matchTransfers(withdrawals, deposits, options = {}) {
  const { dateWindowDays = 3, amountTolerance = 0 } = options;

  // Pre-filter already-matched rows out of the pool; they pass through untouched.
  const preMatched = [];
  const openW = [];
  for (const w of withdrawals || []) {
    if (w && alreadyTransferMatched(w)) preMatched.push(w);
    else openW.push(w);
  }
  const openD = [];
  for (const d of deposits || []) {
    if (d && alreadyTransferMatched(d)) preMatched.push(d);
    else openD.push(d);
  }

  const result = runMatch(openW, openD, {
    amountTolerance,
    kind: 'transfer',
    reason: 'multiple equal-amount transfer candidates in window; confirm the pair',
    isEligible: (w, d) => {
      if (d.day < w.day - 1) return false;
      if (d.day > w.day + dateWindowDays) return false;
      if (w.row.account != null && d.row.account != null && w.row.account === d.row.account) {
        return false; // same own account: a correction, not a transfer
      }
      return true;
    },
  });

  result.unmatched = result.unmatched.concat(preMatched);
  return result;
}

// Match reimbursements: a reimbursable outlay (a withdrawal tagged 'reimbursable',
// not yet tagged 'reimbursed') against the deposit that pays it back. A deposit is
// eligible when it is on or after the outlay date and within dateWindowDays after it,
// with cents-equal amount within tolerance. Same uniqueness rule as transfers: only
// pairs unique on both sides auto-match. Returns { matches (kind 'reimbursement'),
// ambiguous, unmatched, flags }.
export function matchReimbursements(reimbursableWithdrawals, deposits, options = {}) {
  const { dateWindowDays = 60, amountTolerance = 0 } = options;

  // Outlays already marked repaid pass through untouched.
  const preMatched = [];
  const openW = [];
  for (const w of reimbursableWithdrawals || []) {
    if (w && alreadyReimbursed(w)) preMatched.push(w);
    else openW.push(w);
  }

  const result = runMatch(openW, deposits, {
    amountTolerance,
    kind: 'reimbursement',
    reason: 'multiple equal-amount repayment candidates in window; confirm the pair',
    isEligible: (w, d) => {
      if (d.day < w.day) return false; // a repayment cannot predate the outlay
      if (d.day > w.day + dateWindowDays) return false;
      return true;
    },
  });

  result.unmatched = result.unmatched.concat(preMatched);
  return result;
}
