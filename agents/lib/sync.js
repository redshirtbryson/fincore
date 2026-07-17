// SimpleFIN to Firefly transaction transform: pure, deterministic, unit-tested.
// No I/O, no model, no clock. The caller fetches the SimpleFIN payload, supplies
// the account map and the seen-ledger, and writes the resulting create-requests to
// Firefly. This module only shapes the transform so it can be reasoned about and
// tested in isolation.
//
// Why this exists: fincore runs its own SimpleFIN sync because the third-party
// importer has a fatal date bug. This is the transform at the center of that sync.
//
// Flag, do not guess (SPEC section 11): a transaction with no id, an unparseable or
// zero amount, or a missing posted timestamp is put on a flags array and skipped,
// never ingested with a coerced value. An unidentifiable transaction can never be
// deduplicated against the seen-ledger, so it must never enter the ledger at all.
//
// Posted-only sync: pending rows are skipped. Pending transactions change amount and
// get renumbered when they post, which would ghost-duplicate against the posted row.

const SYNC_TAG = 'simplefin-sync';

// A signed decimal string (or number) to a finite Number, or null if unparseable.
// SimpleFIN amounts are strings like '-4.99'; negative means money out. Direction is
// carried by the sign here (unlike matching.js), so a negative value is valid.
function parseSignedAmount(v) {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Absolute value rounded to whole cents and emitted as a fixed 2-decimal string.
// Rounding through cents keeps float noise (4.9e-15, 0.1 + 0.2) out of the payload;
// Firefly takes the amount as a string, so we never hand it a raw float.
function absCentsString(n) {
  const cents = Math.round(Math.abs(n) * 100);
  return (cents / 100).toFixed(2);
}

// Prefer the payee, then the description, then a literal 'Unknown'. Both fields are
// trimmed; an all-whitespace field counts as empty.
function counterpartyOf(txn) {
  const payee = typeof txn.payee === 'string' ? txn.payee.trim() : '';
  if (payee) return payee;
  const desc = typeof txn.description === 'string' ? txn.description.trim() : '';
  if (desc) return desc;
  return 'Unknown';
}

// Deterministic sort key: date first, then the SimpleFIN txn id. Applied to the
// creates so the same input in any order produces the same output order.
function byDateThenTxnId(a, b) {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  if (a.txnId < b.txnId) return -1;
  if (a.txnId > b.txnId) return 1;
  return 0;
}

// Transform a SimpleFIN /accounts payload into Firefly transaction create-requests
// for the mapped accounts only, skipping transaction ids already in seenIds.
//
// accountMap: Map of simplefinId -> { fireflyAccountId, fireflyAccountName }. Only
// accounts present in the map flow; transactions of unmapped accounts are counted in
// skippedUnmapped and are NOT flagged one by one (an unmapped account is a
// configuration choice, not a data error).
//
// nyDateStr: injected Date -> 'YYYY-MM-DD' formatter (America/New_York), so this
// module stays pure and the caller controls the clock. Required; throws otherwise.
//
// Returns { creates, flags, skippedSeen, skippedPending, skippedUnmapped }.
export function transformTransactions(accounts, accountMap, { seenIds = new Set(), nyDateStr } = {}) {
  if (typeof nyDateStr !== 'function') {
    throw new RangeError('transformTransactions requires a nyDateStr(Date) formatter');
  }

  const map = accountMap instanceof Map ? accountMap : new Map();
  const creates = [];
  const flags = [];
  let skippedSeen = 0;
  let skippedPending = 0;
  let skippedUnmapped = 0;

  for (const account of accounts || []) {
    const acctId = account && account.id;
    // Map keys are SQLite TEXT; normalize so a numerically-typed feed id can never
    // silently classify a mapped account as unmapped.
    const mapping = acctId != null ? map.get(String(acctId)) : undefined;
    const txns = (account && Array.isArray(account.transactions)) ? account.transactions : [];

    if (!mapping) {
      // Unmapped account: count its transactions and move on. No per-row flags.
      skippedUnmapped += txns.length;
      continue;
    }

    const { fireflyAccountId, fireflyAccountName } = mapping;
    const acctLabel = fireflyAccountName || fireflyAccountId || acctId;

    for (const txn of txns) {
      const id = typeof txn?.id === 'string' ? txn.id.trim() : (txn?.id != null ? String(txn.id).trim() : '');
      if (!id) {
        // Never ingest an unidentifiable transaction: with no id it can never be
        // deduplicated. Name the account and posted date so a human can find it.
        flags.push(`account ${acctLabel} has a transaction with no id (posted ${txn?.posted ?? '(none)'}); skipped`);
        continue;
      }

      if (seenIds.has(id)) {
        skippedSeen += 1;
        continue;
      }

      if (txn.pending === true) {
        skippedPending += 1;
        continue;
      }

      const amount = parseSignedAmount(txn.amount);
      // Reject not just an exact zero but anything that rounds to zero cents: a
      // '0.00' amount is meaningless and Firefly rejects it. Round through cents so
      // the guard matches the amount we would actually emit.
      if (amount === null || Math.round(Math.abs(amount) * 100) === 0) {
        flags.push(`txn ${id} has unusable amount (${txn.amount}); skipped`);
        continue;
      }

      const posted = txn.posted;
      if (typeof posted !== 'number' || !Number.isFinite(posted) || posted <= 0) {
        flags.push(`txn ${id} has missing or invalid posted timestamp (${posted}); skipped`);
        continue;
      }

      const counterparty = counterpartyOf(txn);
      const desc = typeof txn.description === 'string' ? txn.description.trim() : '';
      const description = desc || counterparty;
      const date = nyDateStr(new Date(posted * 1000));
      const amountStr = absCentsString(amount);

      const create = {
        type: amount < 0 ? 'withdrawal' : 'deposit',
        amount: amountStr,
        date,
        description,
        externalId: id,
        tags: [SYNC_TAG],
        // Carried for the caller's bookkeeping (seen-ledger write, logging).
        txnId: id,
        accountName: fireflyAccountName,
      };

      if (amount < 0) {
        create.sourceId = fireflyAccountId;
        create.destinationName = counterparty;
      } else {
        create.destinationId = fireflyAccountId;
        create.sourceName = counterparty;
      }

      creates.push(create);
    }
  }

  creates.sort(byDateThenTxnId);
  return { creates, flags, skippedSeen, skippedPending, skippedUnmapped };
}

// Compute the [startEpoch, endEpoch] unix-second window for a SimpleFIN pull.
// endEpoch is now floored to whole seconds; startEpoch is lookbackDays before it.
// The caller decides the lookback; this only does the arithmetic and the guards.
// Throws RangeError on a bad clock or an out-of-range lookback so a malformed pull
// never silently fetches the wrong window.
export function epochWindow({ now, lookbackDays } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('epochWindow requires a valid Date for now');
  }
  if (typeof lookbackDays !== 'number' || !Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > 400) {
    throw new RangeError('epochWindow requires lookbackDays to be a finite number in (0, 400]');
  }
  const endEpoch = Math.floor(now.getTime() / 1000);
  const startEpoch = Math.floor(endEpoch - lookbackDays * 86400);
  return { startEpoch, endEpoch };
}
