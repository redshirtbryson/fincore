// CSV backfill transform: pure, deterministic, unit-tested. Parses a bank/card CSV
// export into Firefly transaction create-requests. This exists because the Firefly
// data importer's SimpleFIN flow is broken (date bug), and its CSV flow is a
// click-per-file slog that guesses date formats and sign conventions wrong. This
// module does it deterministically with an explicit per-file spec.
//
// Flag, do not guess (SPEC section 11): a row with an unparseable date or amount,
// or an amount that rounds to zero cents, is flagged and skipped, never coerced.
// Dates are parsed as US month/day/year (all the exports here use that) straight
// into a 'YYYY-MM-DD' string, so no timezone can shift a calendar day.

// Minimal RFC-4180-ish CSV parser: handles quoted fields, commas inside quotes,
// escaped double-quotes, and CRLF. Returns an array of row objects keyed by header.
export function parseCsv(text) {
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { record.push(field); field = ''; continue; }
    if (c === '\n') { record.push(field); rows.push(record); record = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || record.length > 0) { record.push(field); rows.push(record); }
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => !(r.length === 1 && r[0].trim() === '')) // drop blank trailing line
    .map((r) => {
      const o = {};
      headers.forEach((h, idx) => { o[h] = (r[idx] ?? '').trim(); });
      return o;
    });
}

// US month/day/year with 2- or 4-digit year to 'YYYY-MM-DD', or null. Validates the
// calendar date (rejects 2/31). No Date-object timezone risk: the string is built
// directly from the parsed parts.
export function parseUsDate(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(yr, mo - 1, d));
  if (check.getUTCFullYear() !== yr || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Signed decimal string/number to a finite Number, or null. Strips $ and commas.
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Transform parsed CSV rows into Firefly create-requests for ONE account.
// spec: { dateCol, amountCol, descCol, negate = false, endDate = null, tag = 'csv-backfill' }
//   negate:  true when the export uses positive = charge/debt-up (Apple, Discover);
//            false when negative = money out (Huntington, Amazon/Chase). After
//            negation the convention is uniform: negative cents = withdrawal from
//            the account (money out / debt up), positive = deposit (money in / debt down).
//   endDate: 'YYYY-MM-DD'; rows strictly after it are skipped so the sync owns the
//            recent window (no CSV-vs-sync double-count across the boundary).
// Returns { creates, flags, counts }. Each create is account-neutral
// ({ type, date, amount, description, counterparty }); the caller attaches the
// resolved Firefly account id as source (withdrawal) or destination (deposit).
export function transformRows(rows, { dateCol, amountCol, descCol, negate = false, endDate = null } = {}) {
  const creates = [];
  const flags = [];
  let skippedAfterEnd = 0;
  let withdrawals = 0;
  let deposits = 0;
  let totalOutCents = 0;
  let totalInCents = 0;

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // header is line 1
    const date = parseUsDate(row[dateCol]);
    if (!date) {
      flags.push(`row ${rowNum}: unparseable date "${row[dateCol]}"; skipped`);
      return;
    }
    if (endDate && date > endDate) {
      skippedAfterEnd += 1;
      return;
    }
    const raw = parseAmount(row[amountCol]);
    if (raw === null) {
      flags.push(`row ${rowNum}: unparseable amount "${row[amountCol]}"; skipped`);
      return;
    }
    const cents = Math.round((negate ? -raw : raw) * 100);
    if (cents === 0) {
      flags.push(`row ${rowNum} (${date}): zero amount; skipped`);
      return;
    }
    const type = cents < 0 ? 'withdrawal' : 'deposit';
    const amount = (Math.abs(cents) / 100).toFixed(2);
    const description = (row[descCol] || '').trim() || 'Unknown';
    creates.push({ type, date, amount, description, counterparty: description });
    if (type === 'withdrawal') { withdrawals += 1; totalOutCents += Math.abs(cents); }
    else { deposits += 1; totalInCents += Math.abs(cents); }
  });

  creates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    creates,
    flags,
    counts: {
      total: creates.length,
      withdrawals,
      deposits,
      skippedAfterEnd,
      totalOut: totalOutCents / 100,
      totalIn: totalInCents / 100,
      dateRange: creates.length ? [creates[0].date, creates[creates.length - 1].date] : [null, null],
    },
  };
}
