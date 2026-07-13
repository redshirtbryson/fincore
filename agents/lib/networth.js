// Net worth engine: pure, deterministic, unit-tested. No I/O, no model.
//
// Net worth = Firefly account balances (assets positive, liabilities negative)
// + Schwab positions market value + oracle account valuations. Manual assets are
// Firefly manual accounts, so they arrive through the accounts input; investment
// value arrives ONLY through positions (Schwab, symbol-level) and valuations
// (SimpleFIN balance oracle, account-level, SPEC 19 as amended 2026-07-13). No
// overlap by construction: an oracle-tracked account never exists in Firefly.
// Dirty inputs are flagged, never guessed around (SPEC section 11).

// accounts: [{ id, name, type: 'asset'|'liability'|..., currentBalance, currencyCode,
//              includeNetWorth, active }]
// positions: [{ symbol, marketValue }]
// valuations: [{ accountName, balance, currency }]
// Returns { netWorth, assetsTotal, liabilitiesTotal, positionsTotal, valuationsTotal,
//           counted, flags }. netWorth is null when an input is too broken to sum honestly.
export function computeNetWorth({ accounts = [], positions = [], valuations = [] }, { currency = 'USD' } = {}) {
  const flags = [];
  let assetsTotal = 0;
  let liabilitiesTotal = 0;
  let counted = 0;
  let broken = false;

  for (const a of accounts) {
    if (!a || a.active === false) continue;
    if (a.includeNetWorth === false) continue;
    if (a.type !== 'asset' && a.type !== 'liability' && a.type !== 'liabilities') continue;

    const balance = a.currentBalance;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) {
      flags.push(`account "${a.name}" (${a.id}) has no usable balance; net worth cannot be computed`);
      broken = true;
      continue;
    }
    if (a.currencyCode && a.currencyCode !== currency) {
      flags.push(`account "${a.name}" is in ${a.currencyCode}, not ${currency}; net worth cannot be computed`);
      broken = true;
      continue;
    }

    if (a.type === 'asset') {
      assetsTotal += balance;
    } else {
      // Firefly reports liability balances as negative numbers (amount owed).
      // A positive liability balance is suspicious: flag it but sum as reported,
      // since inverting it silently would be a guess.
      if (balance > 0) {
        flags.push(`liability "${a.name}" has a positive balance (${balance}); check its sign in Firefly`);
      }
      liabilitiesTotal += balance;
    }
    counted += 1;
  }

  let positionsTotal = 0;
  for (const p of positions) {
    if (!p) continue;
    if (typeof p.marketValue !== 'number' || !Number.isFinite(p.marketValue)) {
      flags.push(`position "${p.symbol ?? 'unknown'}" has no usable market value; net worth cannot be computed`);
      broken = true;
      continue;
    }
    positionsTotal += p.marketValue;
  }

  let valuationsTotal = 0;
  for (const v of valuations) {
    if (!v) continue;
    if (typeof v.balance !== 'number' || !Number.isFinite(v.balance)) {
      flags.push(`valuation "${v.accountName ?? 'unknown'}" has no usable balance; net worth cannot be computed`);
      broken = true;
      continue;
    }
    if (v.currency && v.currency !== currency) {
      flags.push(`valuation "${v.accountName}" is in ${v.currency}, not ${currency}; net worth cannot be computed`);
      broken = true;
      continue;
    }
    valuationsTotal += v.balance;
  }

  if (counted === 0 && positions.length === 0 && valuations.length === 0) {
    flags.push('no accounts, positions, or valuations to sum; net worth cannot be computed');
    broken = true;
  }

  return {
    netWorth: broken ? null : assetsTotal + liabilitiesTotal + positionsTotal + valuationsTotal,
    assetsTotal,
    liabilitiesTotal,
    positionsTotal,
    valuationsTotal,
    counted,
    flags,
  };
}
