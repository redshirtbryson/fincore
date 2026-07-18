// Loan balance truing: pure, deterministic, unit-tested. No I/O, no clock.
//
// Why this exists (baseline audit 2026-07-18): loan accounts (mortgage, auto) get
// their balance from the feed, not from transactions. Feed transaction lines on
// loans (escrow, insurance disbursements) are NOT balance-affecting upstream, so
// syncing them corrupts the liability. Instead the daily pass compares Firefly's
// computed balance to the feed's balance and adjusts the OPENING balance so the
// computed balance lands exactly on the feed:
//
//   opening_new = opening_old + (feed - computed)
//
// Flag, do not guess (SPEC section 11): unparseable inputs, a sign flip (a liability
// suddenly reading positive), or a drift beyond the sanity cap are flagged for a
// human, never written. Normal monthly drift on these loans is a payment
// (~$600-1,000); the default cap is well above that but far below a feed glitch
// like a zeroed balance.

// Signed decimal to finite Number or null. Same tolerance as the other engines.
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const roundCents = (n) => Math.round(n * 100) / 100;

// Decide what to do about one loan account. All amounts in dollars (liabilities
// negative). Returns:
//   { action: 'noop' }                                    computed already equals feed (to the cent)
//   { action: 'true', openingNew, drift }                 write opening_new
//   { action: 'flag', reason, drift? }                    do not write; surface to a human
export function computeLoanTruing({ feedBalance, computedBalance, opening, capDollars = 2500 } = {}) {
  const feed = num(feedBalance);
  const computed = num(computedBalance);
  const open = num(opening);
  if (feed === null || computed === null || open === null) {
    return { action: 'flag', reason: 'unparseable balance input; nothing written' };
  }
  const cap = num(capDollars);
  if (cap === null || cap <= 0) {
    return { action: 'flag', reason: 'invalid truing cap; nothing written' };
  }
  const drift = roundCents(feed - computed);
  if (Math.abs(drift) < 0.005) return { action: 'noop' };
  // Sign sanity: a tracked liability flipping to a positive feed balance is a feed
  // glitch or a paid-off-and-overpaid edge; either way a human should look first.
  if (computed < 0 && feed > 0) {
    return { action: 'flag', reason: `feed balance flipped sign (computed ${computed}, feed ${feed}); check the feed`, drift };
  }
  if (Math.abs(drift) > cap) {
    return { action: 'flag', reason: `drift ${drift} exceeds the ${cap} sanity cap; a feed glitch or a missed event — confirm by hand`, drift };
  }
  return { action: 'true', openingNew: roundCents(open + drift), drift };
}
