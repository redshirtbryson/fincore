// Shared money/text presentation for every Discord-bound string. Pure, no I/O.
//
// Why this exists (2026-07-19): Firefly amounts arrive as long-precision strings
// ('150.000000000000') and several message composers interpolated them raw, giving
// unreadable notifications. All human-facing money now flows through usd(), and
// tidyMoney() is the render-time backstop that repairs any long-precision dollar
// string already sitting in stored messages (the queue keeps old rows).

// Dollars, 2 decimals, thousands separators: usd(1499.9) -> '$1,499.90',
// usd('-150.000000000000') -> '-$150.00'. Unparseable input returns the raw string
// (never hide a value); null/undefined/'' returns 'n/a' (never a fabricated $0).
export function usd(v) {
  if (v === null || v === undefined || v === '') return 'n/a';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return String(v);
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Whole-dollar variant for dense lines (debt summaries): usd0(27056.7) -> '$27,057'.
export function usd0(v) {
  if (v === null || v === undefined || v === '') return 'n/a';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return String(v);
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
}

// Render-time repair for text that already contains long-precision dollar strings
// ('$150.000000000000' -> '$150.00'). Only touches digits beyond two decimals after
// a $ amount, so ordinary prose and correctly-formatted money pass through unchanged.
export function tidyMoney(text) {
  return String(text).replace(/\$(\d[\d,]*)\.(\d{2})\d+/g, '$$$1.$2');
}
