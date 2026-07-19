// Phase 4 quality passes (SPEC section 11): I/O orchestration around the pure
// matching, freshness, and reconciliation engines. Each pass is independently
// try/caught (skip-and-report); math lives in the engines.
import * as firefly from './firefly.js';
import { matchTransfers, matchReimbursements, parseAmount, isInternalTransferDescription } from './matching.js';
import { assessFreshness, staleSummaryLine } from './freshness.js';
import { reconcileNetWorth, reconcilePaystubDeposits } from './reconcile.js';
import {
  audit,
  reversalHandleFor,
  latestPaystub,
  recordFeedStatus,
  getPref,
  getMeta,
  upsertValuation,
  getSyncAccountMap,
  seenTxnIds,
  markTxnSeen,
} from './store.js';
import { fetchBalances, fetchTransactions, normalizeValuation, matchesValuationRule, parseMatchRules, overlapsFireflyAccount } from './simplefin.js';
import { transformTransactions, epochWindow } from './sync.js';
import { computeLoanTruing } from './loan-truing.js';
import { usd, usd0 } from './format.js';
import { computeAllocation, avalanche } from './allocation.js';
import { monthlyInterest } from './debt-engine.js';
import { taxOwed, checkpointStatus } from './tax-tracker.js';
import { droughtStatus, bufferRunway } from './influx-watch.js';
import {
  seenInfluxJournalIds,
  planInfluxCount,
  influxDates,
  recordInfluxAllocation,
  setMeta,
} from './store.js';

const MATCH_LOOKBACK_DAYS = Number(process.env.MATCH_LOOKBACK_DAYS) > 0 ? Number(process.env.MATCH_LOOKBACK_DAYS) : 90;
const MATCH_WRITE_CAP = Number(process.env.MATCH_WRITE_CAP) > 0 ? Number(process.env.MATCH_WRITE_CAP) : 20;
const FRESHNESS_THRESHOLD_DAYS = Number(process.env.FRESHNESS_THRESHOLD_DAYS) > 0 ? Number(process.env.FRESHNESS_THRESHOLD_DAYS) : 7;

// Autonomy tier boundary (SPEC section 15): autonomous writes only below the
// dollar threshold Bryson set in onboarding. Recategorizing a material
// transaction is Confirm-tier, so pairs above the threshold are queued, not written.
const DEFAULT_AUTONOMY_THRESHOLD = 50;

function autonomyThreshold(db) {
  const v = Number(getPref(db, 'autonomy_dollar_threshold'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_AUTONOMY_THRESHOLD;
}

// Queue a durable item for the Discord confirm flow (Phase 13 consumes this table).
// Deduped on the exact unresolved message so daily reruns do not stack copies.
// payload carries the machine-executable pending action, e.g. { kind:
// 'transfer-pair', m } for a matched pair the bot can convert on Confirm; absent
// payload means acknowledge-only.
function queueNotification(db, severity, message, { payload = null } = {}) {
  // Dedupe against unresolved copies AND previously-DISMISSED copies: a dismissal
  // means "this suggestion is wrong, permanently" (e.g. a coincidental pair that is
  // not a transfer) — re-queueing it daily would train the human to ignore the
  // channel. Acknowledged/confirmed items may legitimately re-queue if the
  // condition recurs.
  const exists = db
    .prepare(`SELECT 1 FROM notification_queue WHERE message = ? AND (resolution IS NULL OR resolution = 'dismissed')`)
    .get(message);
  if (!exists) {
    db.prepare('INSERT INTO notification_queue (severity, message, payload_json) VALUES (?, ?, ?)').run(
      severity,
      message,
      payload === null ? null : JSON.stringify(payload)
    );
  }
}

function pairLabel(w, d) {
  return `${w.date} ${w.account} -> ${d.account} ${usd(w.amount)} (tx ${w.tx_id}/${d.tx_id})`;
}

// Complete half-written pairs from a prior crashed run. A transfer-match tag names
// both journal ids; a row wearing the tag whose counterpart lacks it means the
// second write never landed. The counterpart is found in the fetched window (both
// legs sit within days of each other); anything outside it is flagged.
async function repairHalfMatches(db, txns, flags) {
  const byJournal = new Map(txns.map((t) => [t.journal_id, t]));
  const tagOwners = new Map(); // tag -> rows wearing it
  for (const t of txns) {
    for (const tag of t.tags) {
      if (tag.startsWith('transfer-match:')) {
        if (!tagOwners.has(tag)) tagOwners.set(tag, []);
        tagOwners.get(tag).push(t);
      }
    }
  }
  let repaired = 0;
  for (const [tag, owners] of tagOwners) {
    if (owners.length !== 1) continue;
    const ids = tag.slice('transfer-match:'.length).split('-');
    const missingId = ids.find((id) => id !== owners[0].journal_id);
    const counterpart = missingId ? byJournal.get(missingId) : null;
    if (!counterpart) {
      flags.push(`half-matched pair ${tag}: counterpart journal ${missingId ?? '?'} not in window; needs manual review`);
      continue;
    }
    await firefly.setCategory(counterpart.tx_id, counterpart.journal_id, 'Transfer', {
      addTags: [tag],
      knownTags: counterpart.tags,
    });
    audit(db, {
      actor: 'matcher',
      action: 'transfer.match.repair',
      target: `firefly:tx:${counterpart.tx_id}:${counterpart.journal_id}`,
      before: { category: counterpart.category || null },
      after: { category: 'Transfer', tag },
      reversalHandle: reversalHandleFor('firefly_transfer_match', tag, { category: counterpart.category || null }),
    });
    counterpart.tags = [...counterpart.tags, tag]; // keep the in-memory pool consistent
    repaired += 1;
  }
  return repaired;
}

// Categories that are themselves internal movements, so their presence on a matched
// pair is not a reason to withhold auto-conversion (a card payment is categorized
// Debt Payment by the rules yet is exactly what should become a transfer). Any other
// category is a human signal to confirm rather than auto-delete.
const INTERNAL_CATEGORIES = new Set(['Transfer', 'Debt Payment']);

// Set of Firefly transaction (group) ids that carry more than one split in the
// fetched window. deleteTransaction removes an entire group and convertInternalLeg
// retypes one split, so a leg belonging to a multi-split group cannot be safely
// converted (it would destroy or mis-type the sibling splits). Sync and CSV rows are
// single-split; manual entries can be split. Such pairs are queued, never converted.
export function multiSplitTxIds(items) {
  const journalsByTx = new Map();
  for (const t of items || []) {
    if (!journalsByTx.has(t.tx_id)) journalsByTx.set(t.tx_id, new Set());
    journalsByTx.get(t.tx_id).add(t.journal_id);
  }
  const multi = new Set();
  for (const [txId, journals] of journalsByTx) if (journals.size > 1) multi.add(txId);
  return multi;
}

// Snapshot one leg for the audit trail: everything needed to reconstruct it by hand
// if a conversion ever has to be reversed (there is no automated undo yet).
function legSnapshot(s) {
  return {
    tx_id: s.tx_id,
    journal_id: s.journal_id,
    accountId: s.accountId,
    account: s.account,
    counterparty: s.counterparty,
    amount: s.amount,
    date: s.date,
    description: s.description,
    category: s.category || null,
    tags: Array.isArray(s.tags) ? s.tags : [],
    currencyCode: s.currencyCode ?? null,
    externalId: s.externalId ?? null,
  };
}

// Whether a matched transfer pair may be auto-converted without confirmation. The
// DEPOSIT leg is the one deleted and the one that reads as income, so the guard is
// built around never destroying real income. A deposit is safe to convert when EITHER:
//   (1) the deposit leg's own description names an internal movement
//       (isInternalTransferDescription), e.g. "INTERNET TFR FRM CHECKING"; OR
//   (2) the deposit lands in a LIABILITY (credit-card) account AND the withdrawal leg
//       names an internal movement. Money is never paid INTO a credit card as income;
//       a deposit there is a payment, and a card refund/statement-credit has no
//       matching own-account withdrawal, so a unique pair whose paying side reads like
//       a card payment ("DISCOVER E-PAYMENT") is unambiguously that.
// On top of the deposit test: both legs must be category-clean (empty or internal),
// both own-account ids must resolve, and neither leg may be part of a multi-split
// group. Anything else is a confirm-tier decision, not autonomous. liabilityIds is the
// set of Firefly liability account ids; omit it to disable path (2).
// Returns { ok: true } or { ok: false, reason }.
export function autoConvertVerdict(m, { multiSplit = new Set(), liabilityIds = new Set() } = {}) {
  const depositNamesInternal = isInternalTransferDescription(m.deposit.description);
  const depositIsCardPayment =
    liabilityIds.has(m.deposit.accountId) && isInternalTransferDescription(m.withdrawal.description);
  if (!depositNamesInternal && !depositIsCardPayment) {
    return { ok: false, reason: 'deposit leg is neither an internal movement nor a corroborated card payment' };
  }
  const categoriesInternal = [m.withdrawal, m.deposit].every(
    (s) => !s.category || INTERNAL_CATEGORIES.has(s.category)
  );
  if (!categoriesInternal) return { ok: false, reason: 'a leg has a real (non-internal) category' };
  if (!m.withdrawal.accountId || !m.deposit.accountId) {
    return { ok: false, reason: 'could not resolve own-account ids' };
  }
  if (multiSplit.has(m.withdrawal.tx_id) || multiSplit.has(m.deposit.tx_id)) {
    return { ok: false, reason: 'a leg is part of a multi-split transaction' };
  }
  return { ok: true };
}

// Execute a vetted conversion: collapse a withdrawal+deposit leg-pair into one correct
// internal movement (a transfer for an asset destination, a withdrawal into the
// liability for a card payment; see firefly.convertInternalLeg). A begin-audit is
// written BEFORE the destructive delete so a hard crash between the two writes still
// leaves a durable record of both original legs; the completion audit follows. That
// begin-without-completion row is also what the `repair` path uses to finish a pair
// whose convert failed after the delete. On failure a durable notification is queued
// (an in-memory flag alone would not survive a process death) and the error is
// rethrown. Order is delete-deposit-then-convert-withdrawal so a mid-flight failure
// overstates expense, never income. Returns nothing; throws on failure.
export async function convertPairToTransfer(db, m, { actor, liabilityIds = new Set() }) {
  const tag = `transfer-converted:${m.withdrawal.journal_id}-${m.deposit.journal_id}`;
  const destinationIsLiability = liabilityIds.has(m.deposit.accountId);
  const before = { withdrawal: legSnapshot(m.withdrawal), deposit: legSnapshot(m.deposit) };
  // Durable write-ahead intent: survives a crash between the delete and the convert.
  audit(db, {
    actor,
    action: 'transfer.convert.begin',
    target: `firefly:tx:${m.withdrawal.tx_id}:${m.withdrawal.journal_id}`,
    before,
    after: { plannedDeleteDepositTx: m.deposit.tx_id, tag, destinationIsLiability },
    reversalHandle: reversalHandleFor('firefly_transfer_convert', tag, before),
  });
  try {
    await firefly.deleteTransaction(m.deposit.tx_id);
    await firefly.convertInternalLeg(m.withdrawal.tx_id, m.withdrawal.journal_id, {
      sourceId: m.withdrawal.accountId,
      destinationId: m.deposit.accountId,
      destinationIsLiability,
      addTags: [tag],
      knownTags: m.withdrawal.tags,
    });
  } catch (e) {
    queueNotification(
      db,
      'error',
      `Transfer conversion failed mid-write for ${pairLabel(m.withdrawal, m.deposit)}: ${e.message}. ` +
        `Deposit leg ${m.deposit.tx_id} may be deleted with withdrawal leg ${m.withdrawal.tx_id} not yet converted (overstated expense). Run "cleanup-transfers.js repair".`
    );
    throw e;
  }
  audit(db, {
    actor,
    action: 'transfer.convert',
    target: `firefly:tx:${m.withdrawal.tx_id}:${m.withdrawal.journal_id}`,
    before,
    after: {
      type: destinationIsLiability ? 'withdrawal' : 'transfer',
      modeledAs: destinationIsLiability ? 'card-payment (withdrawal into liability)' : 'transfer',
      sourceId: m.withdrawal.accountId,
      destinationId: m.deposit.accountId,
      tag,
      dateDelta: m.dateDelta,
      deletedDepositTx: m.deposit.tx_id,
    },
    reversalHandle: reversalHandleFor('firefly_transfer_convert', tag, before),
  });
}

// Complete conversions whose delete succeeded but whose leg-convert failed (e.g. the
// first run hit Firefly's transfer-to-liability rejection). The write-ahead begin-audit
// recorded both legs; a matching completion audit means it finished. So any
// 'transfer.convert.begin' target with no 'transfer.convert' is an orphaned withdrawal
// leg (its deposit already deleted) still pointing at an expense account. Re-point it
// with convertInternalLeg using the recorded destination account. Idempotent: a fixed
// leg (already a transfer, or already pointing at the destination) is skipped, and a
// success writes the completion audit so it is not selected again. Returns a summary.
export async function repairIncompleteConversions(db, { actor = 'cleanup-transfers', liabilityIds = new Set() } = {}) {
  const rows = db
    .prepare(
      `SELECT target, before_json FROM audit_log
       WHERE action = 'transfer.convert.begin'
         AND target NOT IN (SELECT target FROM audit_log WHERE action = 'transfer.convert')
       ORDER BY id`
    )
    .all();

  let repaired = 0;
  let skipped = 0;
  const flags = [];
  for (const row of rows) {
    let before;
    try {
      before = JSON.parse(row.before_json);
    } catch {
      flags.push(`repair: could not parse before_json for ${row.target}`);
      continue;
    }
    const w = before?.withdrawal;
    const d = before?.deposit;
    if (!w?.tx_id || !w?.journal_id || !w?.accountId || !d?.accountId) {
      flags.push(`repair: incomplete snapshot for ${row.target}; skipped`);
      continue;
    }
    const destinationIsLiability = liabilityIds.has(d.accountId);
    const tag = `transfer-converted:${w.journal_id}-${d.journal_id}`;
    try {
      // Idempotency: if the leg is already converted (a transfer, or a withdrawal
      // already pointing at the destination), record completion and move on.
      const split = await firefly.getSplit(w.tx_id, w.journal_id);
      const curType = String(split?.type || '').toLowerCase();
      const curDest = split?.destination_id != null ? String(split.destination_id) : null;
      const already =
        (destinationIsLiability && curType === 'withdrawal' && curDest === String(d.accountId)) ||
        (!destinationIsLiability && curType === 'transfer' && curDest === String(d.accountId));
      if (!already) {
        await firefly.convertInternalLeg(w.tx_id, w.journal_id, {
          sourceId: w.accountId,
          destinationId: d.accountId,
          destinationIsLiability,
          addTags: [tag],
          knownTags: Array.isArray(w.tags) ? w.tags : null,
        });
      }
      audit(db, {
        actor,
        action: 'transfer.convert',
        target: row.target,
        before,
        after: {
          type: destinationIsLiability ? 'withdrawal' : 'transfer',
          modeledAs: destinationIsLiability ? 'card-payment (withdrawal into liability)' : 'transfer',
          sourceId: w.accountId,
          destinationId: d.accountId,
          tag,
          repaired: true,
          deletedDepositTx: d.tx_id,
        },
        reversalHandle: reversalHandleFor('firefly_transfer_convert', tag, before),
      });
      repaired += 1;
    } catch (e) {
      skipped += 1;
      flags.push(`repair: failed to complete ${row.target}: ${e.message}`);
    }
  }
  return { candidates: rows.length, repaired, skipped, flags };
}

const SYNC_LOOKBACK_DAYS = Number(process.env.SYNC_LOOKBACK_DAYS) > 0 ? Number(process.env.SYNC_LOOKBACK_DAYS) : 3;
const SYNC_CAP = Number(process.env.SYNC_CAP) > 0 ? Number(process.env.SYNC_CAP) : 200;

// fincore-owned SimpleFIN transaction sync (replaces the data importer's broken
// SimpleFIN fetch; the importer remains the CSV backfill tool). One request per
// run covers every Bridge account; only mapped accounts flow into Firefly.
// Idempotent three ways: the seen-ledger, Firefly's duplicate-hash guard, and
// failed creates are NOT marked seen so tomorrow retries them.
export async function runSyncPass(db, { now = new Date() } = {}) {
  const map = getSyncAccountMap(db, { mode: 'txn' });
  if (!process.env.SIMPLEFIN_ACCESS_URL || map.size === 0) {
    return { enabled: false, created: 0, flags: map.size === 0 && process.env.SIMPLEFIN_ACCESS_URL ? ['sync map empty: run node sync-map.js <importer-config.json> to seed it'] : [], line: '' };
  }

  const accounts = await fetchTransactions(epochWindow({ now, lookbackDays: SYNC_LOOKBACK_DAYS }));

  const candidateIds = [];
  for (const a of accounts) {
    if (!map.has(String(a?.id))) continue;
    for (const t of a?.transactions ?? []) if (t?.id) candidateIds.push(String(t.id));
  }
  const seen = seenTxnIds(db, candidateIds);
  const { creates, flags, skippedSeen, skippedPending } = transformTransactions(accounts, map, {
    seenIds: seen,
    nyDateStr: firefly.nyDateStr,
  });

  const capped = creates.slice(0, SYNC_CAP);
  if (creates.length > capped.length) {
    flags.push(`sync cap (${SYNC_CAP}) reached; ${creates.length - capped.length} transactions defer to the next run`);
  }

  let created = 0;
  let duplicates = 0;
  for (const c of capped) {
    try {
      const r = await firefly.createTransaction(c);
      if (r.duplicate) {
        // Firefly's duplicate hash only catches byte-identical journals, i.e. a
        // prior SYNC create (crash between create and mark-seen). It does NOT
        // deduplicate against CSV-imported rows, whose formatting differs; keep
        // the CSV backfill end-date at least SYNC_LOOKBACK_DAYS before the first
        // sync run (documented in the README) or duplicates are genuine.
        duplicates += 1;
        markTxnSeen(db, c.txnId, null);
      } else {
        created += 1;
        markTxnSeen(db, c.txnId, r.id);
      }
    } catch (e) {
      // Not marked seen: tomorrow retries. Per-item, so one bad row cannot sink the run.
      flags.push(`sync failed for ${c.accountName ?? c.txnId} on ${c.date}: ${e.message}`);
    }
  }

  // Status reflects whether writes LANDED: a batch where every create failed is a
  // stale feed even though the fetch succeeded.
  const landed = created > 0 || duplicates > 0 || capped.length === 0;
  recordFeedStatus(db, 'simplefin-sync', {
    lastSeen: landed ? firefly.nyDateStr(now) : null,
    status: landed ? 'ok' : 'stale',
  });
  const parts = [];
  if (created) parts.push(`${created} imported`);
  if (duplicates) parts.push(`${duplicates} already present`);
  if (skippedPending) parts.push(`${skippedPending} pending held back`);
  return {
    enabled: true,
    created,
    duplicates,
    skippedSeen,
    flags,
    line: parts.length ? `Sync: ${parts.join(', ')}.` : '',
  };
}

// Transfer and reimbursement matching. Conservative by design:
// - only pairs unique on both sides auto-match (the engine's rule);
// - a truncated fetch disables ALL auto-writes, because uniqueness cannot be
//   trusted over an incomplete candidate set;
// - pairs above the autonomy dollar threshold are queued for confirmation, never
//   written autonomously (SPEC 15 Confirm tier);
// - a side already carrying a category other than Transfer is never overwritten;
// - the deposit is written before the withdrawal, so a crash between the two
//   overstates expense rather than income, and the repair pass completes it next run.
export async function runMatchingPass(db, { fetched = null } = {}) {
  const { items: txns, truncated } = fetched ?? (await firefly.getRecentTransactions({ lookbackDays: MATCH_LOOKBACK_DAYS }));
  const withdrawals = txns.filter((t) => t.type === 'withdrawal');
  const deposits = txns.filter((t) => t.type === 'deposit');
  const flags = [];
  const threshold = autonomyThreshold(db);

  if (truncated) {
    return {
      transfersWritten: 0,
      reimbursementsWritten: 0,
      ambiguous: 0,
      flags,
      line: `Matching skipped: transaction window truncated at the fetch cap; uniqueness cannot be trusted. Raise the cap or shrink MATCH_LOOKBACK_DAYS.`,
      deposits,
    };
  }

  const repaired = await repairHalfMatches(db, txns, flags);

  let written = 0;
  let transfersWritten = 0;
  let reimbursementsWritten = 0;
  let queuedForConfirm = 0;
  const claimed = new Set(); // journal ids claimed by any match this run

  // Transfers. A matched pair is two independent legs the bank feed produced for one
  // internal movement (a withdrawal into an expense account plus a deposit out of a
  // revenue account). Left alone it double-counts as expense plus income and pollutes
  // the income view. The fix is to collapse the pair into ONE real Firefly transfer:
  // delete the deposit leg, then convert the withdrawal leg in place (see
  // convertPairToTransfer). Whether a pair is safe to auto-convert without a human is
  // decided by autoConvertVerdict; anything it rejects is queued for confirmation,
  // never auto-deleted, regardless of dollar amount.
  const multiSplit = multiSplitTxIds(txns);
  const liabilityIds = new Set((await firefly.getAccounts('liabilities')).map((a) => String(a.id)));
  const tRes = matchTransfers(withdrawals, deposits);
  flags.push(...tRes.flags);
  for (const m of tRes.matches) {
    if (written >= MATCH_WRITE_CAP) {
      flags.push(`match write cap (${MATCH_WRITE_CAP}) reached; remaining pairs process tomorrow`);
      break;
    }
    const verdict = autoConvertVerdict(m, { multiSplit, liabilityIds });
    if (!verdict.ok) {
      // Executable payload: on Confirm, the Discord bot runs convertPairToTransfer
      // with exactly these legs — the human supplies the judgment the gate refused
      // to automate, the machinery stays identical (SPEC 15 confirmed-write tier).
      queueNotification(
        db,
        'confirm',
        `Confirm transfer pair (${verdict.reason}): ${pairLabel(m.withdrawal, m.deposit)}`,
        { payload: { kind: 'transfer-pair', m: { withdrawal: legSnapshot(m.withdrawal), deposit: legSnapshot(m.deposit), dateDelta: m.dateDelta } } }
      );
      queuedForConfirm += 1;
      continue;
    }
    try {
      await convertPairToTransfer(db, m, { actor: 'matcher', liabilityIds });
      claimed.add(m.withdrawal.journal_id);
      claimed.add(m.deposit.journal_id);
      written += 1;
      transfersWritten += 1;
    } catch (e) {
      // convertPairToTransfer already queued a durable notice; surface it in the digest too.
      flags.push(`transfer pair ${pairLabel(m.withdrawal, m.deposit)} failed mid-convert: ${e.message} — needs a manual check`);
    }
  }

  // Reimbursements. The deposit pool excludes anything that is, or just became, a
  // transfer leg: one deposit must never be claimed by both passes.
  const reimbursable = withdrawals.filter((t) => t.tags.includes('reimbursable') && !claimed.has(t.journal_id));
  const openDeposits = deposits.filter(
    (d) =>
      !claimed.has(d.journal_id) &&
      !d.tags.some((t) => t.startsWith('reimbursement-match:') || t.startsWith('transfer-match:'))
  );
  const rRes = matchReimbursements(reimbursable, openDeposits);
  flags.push(...rRes.flags);
  for (const m of rRes.matches) {
    if (written >= MATCH_WRITE_CAP) break;
    const amount = parseAmount(m.withdrawal.amount);
    if (amount === null || amount > threshold) {
      queueNotification(db, 'confirm', `Confirm reimbursement pair: ${pairLabel(m.withdrawal, m.deposit)}`);
      queuedForConfirm += 1;
      continue;
    }
    const tag = `reimbursement-match:${m.withdrawal.journal_id}`;
    try {
      await firefly.setCategory(m.deposit.tx_id, m.deposit.journal_id, undefined, {
        addTags: [tag],
        knownTags: m.deposit.tags,
      });
      await firefly.setCategory(m.withdrawal.tx_id, m.withdrawal.journal_id, undefined, {
        addTags: ['reimbursed'],
        knownTags: m.withdrawal.tags,
      });
      audit(db, {
        actor: 'matcher',
        action: 'reimbursement.match',
        target: `firefly:tx:${m.withdrawal.tx_id}:${m.withdrawal.journal_id}+${m.deposit.tx_id}:${m.deposit.journal_id}`,
        before: { withdrawalTags: m.withdrawal.tags, depositTags: m.deposit.tags },
        after: { tag, dateDelta: m.dateDelta },
        reversalHandle: reversalHandleFor('firefly_reimbursement_match', tag, {
          withdrawalTags: m.withdrawal.tags,
          depositTags: m.deposit.tags,
        }),
      });
      claimed.add(m.withdrawal.journal_id);
      claimed.add(m.deposit.journal_id);
      written += 1;
      reimbursementsWritten += 1;
    } catch (e) {
      flags.push(`reimbursement pair ${pairLabel(m.withdrawal, m.deposit)} failed mid-write: ${e.message}`);
    }
  }

  // Ambiguous pairs are queued durably; the count alone is not actionable.
  for (const a of [...tRes.ambiguous, ...rRes.ambiguous]) {
    queueNotification(
      db,
      'confirm',
      `Ambiguous match for tx ${a.item.tx_id} (${a.item.date}, ${usd(a.item.amount)}): ${a.candidates.length} candidates. ${a.reason}`
    );
  }
  const ambiguous = tRes.ambiguous.length + rRes.ambiguous.length;

  const parts = [];
  if (transfersWritten) parts.push(`${transfersWritten} transfers matched`);
  if (reimbursementsWritten) parts.push(`${reimbursementsWritten} reimbursements matched`);
  if (repaired) parts.push(`${repaired} half-matched pairs repaired`);
  if (queuedForConfirm) parts.push(`${queuedForConfirm} queued for confirmation`);
  if (ambiguous) parts.push(`${ambiguous} ambiguous queued`);
  return {
    transfersWritten,
    reimbursementsWritten,
    ambiguous,
    flags,
    line: parts.length ? `Matching: ${parts.join(', ')}.` : '',
    deposits,
  };
}

// True upstream freshness: the newest imported transaction date per bank account,
// not API reachability. Per-item: one failing account is recorded stale (fail
// closed) without aborting the others. Feed keys carry the account id so renames
// and name collisions cannot corrupt rows; rows for accounts that no longer exist
// are pruned so they cannot alarm forever.
export async function runFreshnessPass(db, { now = new Date() } = {}) {
  // Judge ONLY feed-backed accounts. An account has a feed iff it is in the sync
  // map; manual assets (Home, Cash wallet, the Pokemon collection) are not, and
  // must not alarm as stale forever just because their only entry is an opening
  // balance. With no map seeded, freshness has nothing to judge, which is correct:
  // freshness is meaningless without knowing which accounts have a live feed.
  const feedIds = new Set([...getSyncAccountMap(db, { mode: 'txn' }).values()].map((m) => String(m.fireflyAccountId)));
  const accounts = (await firefly.getAccounts('asset')).filter(
    (a) => a.active !== false && feedIds.has(String(a.id))
  );
  const results = await Promise.allSettled(accounts.map((a) => firefly.getLatestTransactionDate(a.id)));

  const feeds = [];
  const fetchFailed = [];
  accounts.forEach((a, i) => {
    const key = `bank:${a.id}:${a.name}`;
    if (results[i].status === 'fulfilled') {
      // An account with no transaction EVER is not feed-backed (manual assets like
      // a cash wallet or the Pokemon collection): there is nothing to be stale
      // about, so it is skipped rather than alarming as never-seen forever. A real
      // bank feed acquires transactions on its first import, so a feed that dies
      // later still ages out through the threshold.
      if (results[i].value === null) return;
      feeds.push({ name: key, lastActivity: results[i].value });
    } else {
      fetchFailed.push({ name: key, reason: results[i].reason?.message || 'fetch failed' });
    }
  });

  const assessment = assessFreshness(feeds, { now, defaultThresholdDays: FRESHNESS_THRESHOLD_DAYS });
  // A feed we could not even ask about is stale by definition (fail closed).
  for (const f of fetchFailed) {
    assessment.stale.push({ name: f.name, daysSince: null, reason: `fetch failed: ${f.reason}` });
  }

  const currentKeys = new Set([...feeds.map((f) => f.name), ...fetchFailed.map((f) => f.name)]);
  const staleNames = new Set(assessment.stale.map((s) => s.name));
  for (const key of currentKeys) {
    const feed = feeds.find((f) => f.name === key);
    recordFeedStatus(db, key, { lastSeen: feed?.lastActivity ?? null, status: staleNames.has(key) ? 'stale' : 'ok' });
  }
  // Prune rows for accounts that no longer exist (renamed or closed).
  const known = db.prepare("SELECT feed FROM feed_freshness WHERE feed LIKE 'bank:%'").all();
  const stmt = db.prepare('DELETE FROM feed_freshness WHERE feed = ?');
  for (const { feed } of known) {
    if (!currentKeys.has(feed)) stmt.run(feed);
  }

  return { assessment, line: staleSummaryLine(assessment), flags: assessment.flags };
}

// SimpleFIN balance oracle (SPEC 19 as amended): daily balance snapshots for
// Bridge-connected accounts matched by VALUATION_ACCOUNT_MATCH that deliberately
// never exist in Firefly. Off when fully unconfigured; a HALF-configuration is
// almost certainly a mistake and is flagged.
export async function runValuationPass(db, { now = new Date() } = {}) {
  const rules = parseMatchRules(process.env.VALUATION_ACCOUNT_MATCH);
  const hasUrl = Boolean(process.env.SIMPLEFIN_ACCESS_URL);
  if (!hasUrl && rules.length === 0) {
    return { ingested: 0, flags: [], line: '', enabled: false };
  }
  if (!hasUrl || rules.length === 0) {
    return {
      ingested: 0,
      flags: [
        `valuation oracle half-configured: ${hasUrl ? 'VALUATION_ACCOUNT_MATCH is empty' : 'SIMPLEFIN_ACCESS_URL is not set'}; oracle is OFF`,
      ],
      line: '',
      enabled: false,
    };
  }

  const [accounts, fireflyAssets, fireflyLiabilities] = await Promise.all([
    fetchBalances(),
    firefly.getAccounts('asset'),
    firefly.getAccounts('liabilities'),
  ]);
  const fireflyNames = [...fireflyAssets, ...fireflyLiabilities].map((a) => a.name);

  const flags = [];
  let matched = 0;
  let ingested = 0;
  for (const account of accounts) {
    if (!matchesValuationRule(account, rules)) continue;
    matched += 1;
    const r = normalizeValuation(account, { nowMs: now.getTime() });
    if (r.error) {
      flags.push(r.error);
      continue;
    }
    // Double-count tripwire: a matched Bridge account overlapping a Firefly account
    // name is probably importer-mapped; ingesting it would count it twice.
    const overlap = overlapsFireflyAccount(r.valuation.accountName, fireflyNames);
    if (overlap) {
      flags.push(
        `valuation "${r.valuation.accountName}" overlaps Firefly account "${overlap}"; NOT ingested (possible double-count). Tighten VALUATION_ACCOUNT_MATCH or rename one.`
      );
      continue;
    }
    // Measurement-change guard: a brand-new valuation account after the baseline is
    // locked moves net worth without any real gain. Ingest it (the data is real)
    // but surface it loudly so the baseline gets corrected inside the window.
    const isNew = !db
      .prepare('SELECT 1 FROM account_valuations WHERE source = ? AND account_id = ? LIMIT 1')
      .get(r.valuation.source, r.valuation.accountId);
    if (isNew && getMeta(db, 'baseline_locked_at')) {
      const msg = `new valuation account "${r.valuation.accountName}" adds ${r.valuation.balance.toFixed(2)} to net worth AFTER the baseline lock; correct the baseline (npm run onboard) inside the window or this reads as a gain`;
      flags.push(msg);
      queueNotification(db, 'confirm', msg);
    }
    upsertValuation(db, r.valuation);
    ingested += 1;
  }

  if (ingested === 0) {
    flags.push(
      matched === 0
        ? `valuation oracle matched no Bridge accounts for rules "${rules.join(', ')}"; connect the accounts in the Bridge or fix VALUATION_ACCOUNT_MATCH`
        : `valuation oracle matched ${matched} account(s) but none had a usable balance today`
    );
  }
  // Feed status reflects whether DATA landed, not whether the request succeeded.
  // lastSeen passes null on a bad day so the previous good date is preserved.
  recordFeedStatus(db, 'simplefin-oracle', {
    lastSeen: ingested > 0 ? firefly.nyDateStr(now) : null,
    status: ingested > 0 ? 'ok' : 'stale',
  });

  return {
    ingested,
    flags,
    line: ingested > 0 ? `Valuations: ${ingested} account balance${ingested === 1 ? '' : 's'} ingested.` : '',
    enabled: true,
  };
}

// Schwab positions ingest (Phase 11's data path, SPEC 10.11): the Python sidecar
// owns OAuth via schwab-py; this pass invokes it, normalizes, and replaces today's
// positions rows. Off when SCHWAB_APP_KEY is unset. Schwab refresh tokens expire
// weekly; a token failure surfaces as an actionable flag plus a stale feed, never
// a silent freeze.
// Budget assignment (2026-07-18): map each categorized consumption withdrawal to its
// category's Firefly budget so the budget bars cover the whole income stream. This
// runs AFTER categorization (rules or model), so it catches everything with zero
// per-merchant rule sprawl. Only fills EMPTY budget slots — the Hobby merchant rules
// (and any manual assignment) always win. Non-consumption categories (Transfer,
// Taxes, Construction, Investment, Refunds, Income, Business Expense) are never
// budgeted. Debt Payment is deliberately ABSENT: that category mixes fixed debt
// service with payoff strikes (observed ~$7k/mo during the paydown), which no fixed
// budget can represent — strikes are the debt engine's domain. The genuinely fixed
// payments (auto loan, Synchrony) reach the Fixed Obligations bucket via dedicated
// strict merchant rules created by setup-budgets.js instead.
const BUDGET_FOR_CATEGORY = {
  Groceries: 'Groceries',
  Dining: 'Dining',
  Utilities: 'Utilities',
  Personal: 'Personal',
  Entertainment: 'Entertainment',
  'Software/SaaS': 'Software/SaaS',
  Healthcare: 'Healthcare',
  Transport: 'Transport',
  Housing: 'Housing',
};
const BUDGET_ASSIGN_CAP = Number(process.env.BUDGET_ASSIGN_CAP) > 0 ? Number(process.env.BUDGET_ASSIGN_CAP) : 100;

export async function runBudgetAssignPass(db, { fetched = null } = {}) {
  const { items } = fetched ?? (await firefly.getRecentTransactions({ types: ['withdrawal'], lookbackDays: 30 }));
  const todo = items.filter((t) => t.type === 'withdrawal' && !t.budgetId && BUDGET_FOR_CATEGORY[t.category]);
  const capped = todo.slice(0, BUDGET_ASSIGN_CAP);
  const flags = [];
  let assigned = 0;
  for (const t of capped) {
    try {
      await firefly.setBudget(t.tx_id, t.journal_id, BUDGET_FOR_CATEGORY[t.category]);
      assigned += 1;
    } catch (e) {
      flags.push(`budget assign failed for tx ${t.tx_id} (${t.category}): ${e.message}`);
    }
  }
  if (todo.length > capped.length) flags.push(`budget assign cap (${BUDGET_ASSIGN_CAP}) reached; ${todo.length - capped.length} defer to tomorrow`);
  if (assigned) {
    audit(db, {
      actor: 'budget-assign',
      action: 'budget.assign',
      target: 'firefly:transactions',
      before: null,
      after: { assigned, categories: [...new Set(capped.map((t) => t.category))] },
      reversalHandle: null,
    });
  }
  return { assigned, flags, line: assigned ? `Budgets: ${assigned} transaction(s) assigned.` : '' };
}

// --- Phase 6: deposit watcher + playbook heartbeat (playbook v2 is the spec) ---

// Plan constants (playbook v2, blessed 2026-07-18). Values that are genuinely plan
// policy live here, not in env: changing the plan should be a deliberate edit.
const PLAN = {
  startDate: '2026-07-18',
  bufferTier1Target: 6000,
  checkpointDate: '2027-01-15',
  roth: { target: 7500, windowStart: '2027-01-15', deadline: '2027-04-15' },
  taxRate: 0.30,
  monthlyGap: 2950, // the Blenko-only structural gap, for buffer runway
  // Strike debts by Firefly account id (Amazon is the daily driver, never struck).
  strikeDebtIds: { 15: 'Discover', 14: 'Apple', 7: 'Affirm' },
  influxMinAmount: 1000, // a Redshirt deposit below this is not an "influx"
  // The migrated recurring billers: any of these charging Discover after the
  // migration date is a straggler leaking new spend onto a frozen card.
  stragglerAfter: '2026-08-01',
  stragglerBillers: ['XFINITY', 'COMCAST', 'STATE FARM', 'AMERITAS', 'REPUBLIC SERVICES', 'USPS PO BOXES', 'YOUTUBEPREMIUM', 'GOOGLE *GOOGLE ONE', 'DOORDASHDASHPASS', 'DISCORD*', 'PRIVATEINTERNETACCESS', 'MICROSOFT', 'PATREON', 'NEXTDNS'],
};

export async function runPhase6Pass(db, { fetched = null, now = new Date() } = {}) {
  const lines = [];
  const flags = [];
  const todayStr = firefly.nyDateStr(now);

  const { items } = fetched ?? (await firefly.getRecentTransactions({ lookbackDays: 30 }));
  const [assets, liabilities] = await Promise.all([firefly.getAccounts('asset'), firefly.getAccounts('liabilities')]);
  const byName = new Map(assets.map((a) => [a.name, a]));
  const savings = byName.get('Huntington Bank - Savings');
  const cnb = byName.get('CNB - Joint');
  const cnbBase = Number(getMeta(db, 'plan_cnb_base') ?? 0);
  const bufferBalance = cnb?.currentBalance !== undefined ? Math.max(0, cnb.currentBalance - cnbBase) : 0;
  const debts = liabilities
    .filter((l) => PLAN.strikeDebtIds[l.id])
    .map((l) => ({ name: PLAN.strikeDebtIds[l.id], balance: Math.abs(l.currentBalance ?? 0), apr: l.interest ?? 0 }));

  // 1. DEPOSIT WATCHER: new Redshirt influxes since the last run.
  const seen = seenInfluxJournalIds(db);
  const influxes = items.filter(
    (t) =>
      t.type === 'deposit' &&
      t.tags.includes('income-source:redshirt-cloud') &&
      parseAmount(t.amount) !== null &&
      parseAmount(t.amount) >= PLAN.influxMinAmount &&
      t.date >= PLAN.startDate &&
      !seen.has(t.journal_id)
  );
  for (const dep of influxes) {
    const amount = parseAmount(dep.amount);
    // Running Redshirt total for the tax formula: seeded by seed-phase6.js, grown here.
    const priorReceived = Number(getMeta(db, 'redshirt_received_2026') ?? 0);
    const received = priorReceived + amount;
    const influxIndex = planInfluxCount(db) + 1;
    const alloc = computeAllocation({
      deposit: { amount, date: dep.date },
      influxIndex,
      bufferBalance,
      bufferTier1Target: PLAN.bufferTier1Target,
      taxAccruedTotal: PLAN.taxRate * received,
      taxHeld: savings?.currentBalance ?? 0,
      checkpointDate: PLAN.checkpointDate,
      roth: { funded: Number(getMeta(db, 'roth_2026_funded') ?? 0), ...PLAN.roth },
      debts,
    });
    if (alloc.flags.length && alloc.tranches.length === 0) {
      flags.push(`influx ${dep.date} ${usd(amount)}: allocation refused (${alloc.flags.join('; ')})`);
      continue;
    }
    setMeta(db, 'redshirt_received_2026', String(received));
    recordInfluxAllocation(db, {
      depositDate: dep.date,
      depositAmount: amount,
      fireflyTxId: dep.tx_id,
      fireflyJournalId: dep.journal_id,
      influxIndex,
      tranches: alloc.tranches,
    });
    const split = alloc.tranches.map((t) => `${usd(t.amount)} -> ${t.destination}`).join('  |  ');
    const msg = `INFLUX #${influxIndex} detected: ${usd(amount)} Redshirt on ${dep.date}. Playbook split: ${split}`;
    lines.push(msg);
    queueNotification(db, 'confirm', msg);
  }

  // 1b. WINDFALL WATCHER: a large deposit that is NOT a Redshirt influx (crypto sale
  // proceeds, a big misc check). Crucially different treatment: NO tax tranche — the
  // 30% formula applies to Redshirt income only (a loss-harvest sale owes nothing).
  // The suggestion is goal-stack routing (current avalanche target), and the human
  // decides; recorded in influx_allocations (influx_index 0, kind 'windfall') so it
  // is never re-flagged.
  const windfalls = items.filter(
    (t) =>
      t.type === 'deposit' &&
      !t.tags.some((x) => x.startsWith('income-source:')) &&
      !['Transfer', 'Refunds'].includes(t.category) &&
      parseAmount(t.amount) !== null &&
      parseAmount(t.amount) >= PLAN.influxMinAmount &&
      t.date >= PLAN.startDate &&
      !seen.has(t.journal_id)
  );
  for (const dep of windfalls) {
    const amount = parseAmount(dep.amount);
    const living = avalanche(debts);
    const bufferShort = Math.max(0, PLAN.bufferTier1Target - bufferBalance);
    const target = living.length ? living[0].name : 'CNB - Joint (reservoir)';
    const suggestion = living.length
      ? `goal stack says: ${usd(amount)} -> ${target} (${living[0].apr}% APR${bufferShort > 0 ? `; alternative: top buffer ${usd0(bufferShort)} first` : ''})`
      : `goal stack says: -> CNB - Joint (reservoir)`;
    recordInfluxAllocation(db, {
      depositDate: dep.date,
      depositAmount: amount,
      fireflyTxId: dep.tx_id,
      fireflyJournalId: dep.journal_id,
      influxIndex: 0,
      tranches: [{ destination: target, amount, purpose: 'windfall suggestion', kind: 'windfall' }],
      status: 'notified',
    });
    const msg = `WINDFALL detected: ${usd(amount)} on ${dep.date} (${dep.description.slice(0, 30)}) — not a Redshirt influx, NO tax tranche. ${suggestion}`;
    lines.push(msg);
    queueNotification(db, 'confirm', msg);
  }

  // 2. TAX TRACKER heartbeat line.
  const received = Number(getMeta(db, 'redshirt_received_2026') ?? 0);
  const tax = taxOwed({ redshirtReceivedTotal: received, rate: PLAN.taxRate, savingsBalance: savings?.currentBalance ?? 0 });
  if (!tax.flag) {
    const cp = checkpointStatus({ deficit: tax.deficit, today: todayStr, checkpointDate: PLAN.checkpointDate });
    if (cp.message) lines.push(`Tax set-aside: ${cp.message}`);
  }

  // 3. DROUGHT + RUNWAY.
  const dates = influxDates(db);
  const drought = droughtStatus({ depositDates: dates, today: todayStr });
  if (drought.level === 'watch' || drought.level === 'overdue') {
    const runway = bufferRunway({ bufferBalance, monthlyGap: PLAN.monthlyGap });
    lines.push(`Influx ${drought.level}: ${drought.message}${runway.weeks !== undefined ? ` Buffer runway ~${runway.weeks} weeks.` : ''}`);
  }

  // 4. DEBT heartbeat: living strike debts, avalanche order, interest burn.
  const living = avalanche(debts);
  if (living.length) {
    const parts = living.map((d) => `${d.name} ${usd0(d.balance)} (~${usd0(monthlyInterest(d.balance, d.apr) ?? 0)}/mo)`);
    lines.push(`Debts (avalanche): ${parts.join(' -> ')}. Next strike target: ${living[0].name}.`);
  } else {
    lines.push('Revolving strike debts: ALL DEAD.');
  }

  // 5. STRAGGLER WATCH: migrated billers still charging Discover.
  const stragglers = items.filter(
    (t) =>
      t.type === 'withdrawal' &&
      t.account === 'Credit - Discover' &&
      t.date >= PLAN.stragglerAfter &&
      PLAN.stragglerBillers.some((b) => t.description.toUpperCase().includes(b))
  );
  for (const s of stragglers) {
    flags.push(`STRAGGLER on Discover: ${s.date} ${usd(parseAmount(s.amount))} ${s.description.slice(0, 40)} — migrate this biller to the Amazon card`);
  }

  // 6. BUDGET STATUS (current month).
  try {
    const monthStart = todayStr.slice(0, 8) + '01';
    const budgets = await firefly.getBudgetStatus(monthStart, todayStr);
    const over = budgets.filter((b) => b.limit && b.spent > b.limit);
    const watch = budgets.filter((b) => b.limit && b.spent > 0.8 * b.limit && b.spent <= b.limit);
    if (over.length) lines.push(`Budgets OVER: ${over.map((b) => `${b.name} ${usd0(b.spent)}/${usd0(b.limit)}`).join(', ')}`);
    if (watch.length) lines.push(`Budgets >80%: ${watch.map((b) => `${b.name} ${usd0(b.spent)}/${usd0(b.limit)}`).join(', ')}`);
  } catch (e) {
    flags.push(`budget status unavailable: ${e.message}`);
  }

  return { influxesDetected: influxes.length, lines, flags };
}

// Loan balance truing (baseline audit 2026-07-18): loan accounts (mortgage, auto)
// are mapped mode='balance', never transaction-synced — feed lines on loans (escrow,
// insurance) are not balance-affecting upstream, so syncing them corrupts the
// liability. Instead, true each loan's OPENING balance so its computed balance lands
// exactly on the feed's balance (opening_new = opening_old + (feed - computed); math
// in lib/loan-truing.js, guarded: sign flips and drifts beyond the sanity cap are
// flagged, never written). Audited per account with a reversal handle.
const LOAN_TRUING_CAP = Number(process.env.LOAN_TRUING_CAP) > 0 ? Number(process.env.LOAN_TRUING_CAP) : 2500;

export async function runLoanBalancePass(db) {
  const entries = getSyncAccountMap(db, { mode: 'balance' });
  if (entries.size === 0 || !process.env.SIMPLEFIN_ACCESS_URL) {
    return { enabled: false, trued: 0, flags: [], line: '' };
  }

  const accounts = await fetchBalances();
  const bySfid = new Map(accounts.map((a) => [String(a.id), a]));
  const flags = [];
  let trued = 0;
  let noop = 0;

  for (const [sfid, m] of entries) {
    const label = m.fireflyAccountName || m.fireflyAccountId;
    try {
      const feed = bySfid.get(sfid);
      if (!feed) {
        flags.push(`loan truing: ${label} not in the SimpleFIN payload; feed missing or re-auth needed`);
        continue;
      }
      const detail = await firefly.getAccountDetail(m.fireflyAccountId);
      const verdict = computeLoanTruing({
        feedBalance: feed.balance,
        computedBalance: detail.currentBalance,
        opening: detail.openingBalance,
        capDollars: LOAN_TRUING_CAP,
      });
      if (verdict.action === 'noop') {
        noop += 1;
        continue;
      }
      if (verdict.action === 'flag') {
        flags.push(`loan truing: ${label}: ${verdict.reason}`);
        continue;
      }
      await firefly.setOpeningBalance(m.fireflyAccountId, {
        openingBalance: verdict.openingNew,
        openingBalanceDate: detail.openingBalanceDate,
        name: detail.name,
      });
      audit(db, {
        actor: 'loan-truing',
        action: 'loan.balance.true',
        target: `firefly:account:${m.fireflyAccountId}`,
        before: { opening: detail.openingBalance, computed: detail.currentBalance },
        after: { opening: verdict.openingNew, feedBalance: Number(feed.balance), drift: verdict.drift },
        reversalHandle: reversalHandleFor('firefly_opening_balance', String(m.fireflyAccountId), {
          opening: detail.openingBalance,
        }),
      });
      trued += 1;
    } catch (e) {
      // Per-item: one failing loan cannot sink the pass (SPEC 11).
      flags.push(`loan truing failed for ${label}: ${e.message}`);
    }
  }

  const parts = [];
  if (trued) parts.push(`${trued} loan balance(s) trued to the feed`);
  if (noop && !trued && !flags.length) parts.push(`${noop} loan balance(s) already exact`);
  return { enabled: true, trued, flags, line: parts.length ? `Loans: ${parts.join(', ')}.` : '' };
}

export async function runSchwabPass(db, { now = new Date() } = {}) {
  if (!process.env.SCHWAB_APP_KEY) return { ingested: 0, flags: [], line: '', enabled: false };
  const schwab = await import('./schwab.js');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(here, '..', '..', 'schwab', 'fetch_positions.py');
  const venvPython = path.join(here, '..', '..', 'schwab', '.venv', 'bin', 'python');
  const fs = await import('node:fs');
  const pythonBin = process.env.SCHWAB_PYTHON || (fs.existsSync(venvPython) ? venvPython : 'python3');

  const payload = await schwab.fetchSchwabPayload({ pythonBin, scriptPath });
  const { positions, flags } = schwab.normalizeSchwabPayload(payload);

  // Success/failure is judged on the FETCH, not the row count: a legitimately
  // empty account is a true zero snapshot that must be recorded (and must stop
  // yesterday's rows from being presented as the latest state).
  if (payload.ok !== true) {
    recordFeedStatus(db, 'schwab', { lastSeen: null, status: 'stale' });
    if (payload.tokenExpired) {
      // Analytics-only inconvenience, deliberately NOT a confirm-queue item: net
      // worth flows through the oracle, so a lapsed weekly token pauses position
      // detail (Phase 11 analysis) and nothing else.
      return {
        ingested: 0,
        flags: ['Schwab analytics token expired (net worth unaffected; positions detail paused). Renew when convenient: npm run schwab-auth', ...flags],
        line: '',
        enabled: true,
      };
    }
    return { ingested: 0, flags, line: '', enabled: true };
  }

  const asOf = firefly.nyDateStr(now);
  const count = schwab.ingestPositions(db, positions, asOf);
  recordFeedStatus(db, 'schwab', { lastSeen: asOf, status: 'ok' });
  return {
    ingested: count,
    flags,
    line: `Schwab: ${count === 0 ? 'accounts fetched, nothing to ingest' : `${count} position${count === 1 ? '' : 's'} ingested`}.`,
    enabled: true,
  };
}

// Reconciliation: our computed net worth against Firefly's own summary figure, and
// observed payroll deposits against the in-effect paystub template (the re-upload
// trigger from SPEC 10.9). Cannot-reconcile is a reported state, never silence.
export async function runReconcilePass(db, { computedNetWorth = null, deposits = [] } = {}) {
  const lines = [];
  const flags = [];

  const reference = await firefly.getSummaryNetWorth(firefly.nyDateStr());
  const nwRes = reconcileNetWorth({ computed: computedNetWorth, reference });
  if (nwRes.ok === false) {
    lines.push(`Reconcile: net worth drifts ${nwRes.driftDollars.toFixed(2)} from Firefly's own figure; investigate before trusting it.`);
  } else if (nwRes.ok === null) {
    lines.push(`Reconcile: cannot verify net worth today (${nwRes.flags[0] ?? 'missing input'}).`);
  }

  const w2s = db.prepare("SELECT name FROM income_sources WHERE treatment = 'w2' AND active = 1").all();
  for (const { name } of w2s) {
    const template = latestPaystub(db, name);
    if (!template) continue;
    const srcTag = firefly.incomeSourceTag(name);
    const observed = deposits.filter((d) => d.tags.includes(srcTag) && d.date >= template.effective_from);
    if (observed.length === 0) continue;
    const r = reconcilePaystubDeposits({ template, deposits: observed });
    if (r.drifted.length) {
      const worst = r.drifted.reduce((a, b) => (Math.abs(b.deltaDollars) > Math.abs(a.deltaDollars) ? b : a));
      lines.push(
        `Paystub: your ${name} deposit came in ${Math.abs(worst.deltaDollars).toFixed(2)} ${worst.deltaDollars > 0 ? 'above' : 'below'} the template net; upload the new stub when you can.`
      );
    }
    flags.push(...r.flags.filter((f) => !f.includes('drifted')));
  }

  return { nwRes, lines, flags };
}

// The passes that must run BEFORE the daily snapshot: matching cleans the data the
// snapshot will sum, and freshness writes the verdicts the snapshot row records.
// Reconciliation runs after the snapshot (it needs the computed figure); the caller
// owns that ordering. Each pass fails independently (skip-and-report per SPEC 11).
export async function runPreSnapshotPasses(db, { matchingEnabled = true } = {}) {
  const lines = [];
  let deposits = [];

  if (matchingEnabled) {
    try {
      const m = await runMatchingPass(db);
      deposits = m.deposits;
      if (m.line) lines.push(m.line);
      surfaceFlags(lines, 'Matching', m.flags);
    } catch (e) {
      lines.push(`Matching pass failed: ${e.message}`);
    }
  }

  try {
    const f = await runFreshnessPass(db);
    if (f.line) lines.push(f.line);
    surfaceFlags(lines, 'Freshness', f.flags);
  } catch (e) {
    lines.push(`Freshness pass failed: ${e.message}`);
  }

  try {
    const v = await runValuationPass(db);
    if (v.line) lines.push(v.line);
    surfaceFlags(lines, 'Valuations', v.flags);
  } catch (e) {
    lines.push(`Valuation pass failed: ${e.message}`);
  }

  try {
    const l = await runLoanBalancePass(db);
    if (l.line) lines.push(l.line);
    surfaceFlags(lines, 'Loans', l.flags);
  } catch (e) {
    lines.push(`Loan truing pass failed: ${e.message}`);
  }

  try {
    const b = await runBudgetAssignPass(db);
    if (b.line) lines.push(b.line);
    surfaceFlags(lines, 'Budgets', b.flags);
  } catch (e) {
    lines.push(`Budget assign pass failed: ${e.message}`);
  }

  try {
    const p6 = await runPhase6Pass(db);
    lines.push(...p6.lines);
    surfaceFlags(lines, 'Playbook', p6.flags);
  } catch (e) {
    lines.push(`Playbook pass failed: ${e.message}`);
  }

  try {
    const s = await runSchwabPass(db);
    if (s.line) lines.push(s.line);
    surfaceFlags(lines, 'Schwab', s.flags);
  } catch (e) {
    lines.push(`Schwab pass failed: ${e.message}`);
  }

  return { lines, deposits };
}

// Flags are surfaced, capped for heartbeat readability with an explicit remainder
// count; dropping them silently would disable the very checks they report on.
function surfaceFlags(lines, label, flags) {
  for (const f of flags.slice(0, 3)) lines.push(`${label} flag: ${f}`);
  if (flags.length > 3) lines.push(`${label}: ${flags.length - 3} more flags; see the audit log or run the pass manually.`);
}

export { surfaceFlags };
