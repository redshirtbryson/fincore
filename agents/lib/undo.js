// Phase 13 undo core (SPEC section 15: "an `undo <action-id>` Discord command
// reverses a logged, reversible action from the stored prior value").
//
// This module is PURE: given one audit_log entry it computes a REVERSAL PLAN as
// data. It performs no I/O — no network, no clock, no DB. The Discord/agent layer
// takes the plan and executes each op through the real Firefly / store clients,
// then writes a new audit row linking back via reversed_by. Keeping the reasoning
// here, unit-tested, is what makes a DESTRUCTIVE reversal safe to trust: the plan
// can be inspected and asserted on before any money-shaped write happens.
//
// A plan is: { reversible, kind, ops, describe, warnings }.
//   reversible : boolean. false => nothing may be executed; kind is 'manual' or 'noop'.
//   kind       : 'firefly' | 'store' | 'noop' | 'manual'.
//   ops        : ordered list of operations the executor performs, or [] .
//   describe   : one-line human summary for the Discord confirm prompt.
//   warnings   : notes the executor should surface (e.g. an id that cannot be undone).
//
// Firefly op shapes (executor maps op.type -> lib/firefly.js call):
//   { type: 'firefly.createTransaction', args: {...createTransaction args...} }
//   { type: 'firefly.convertInternalLeg', txId, journalId, args: {...} }
//   { type: 'firefly.setCategory', txId, journalId, category, addTags, removeTags }
//   { type: 'firefly.deleteTransaction', id }
// Store op shape (executor maps to a lib/store.js write):
//   { type: 'store.restore', table, key, before }   // before:null => delete/deactivate
//
// The cardinal rule: an action type we do not understand, or a reversible one whose
// stored before-state is incomplete, yields a { reversible:false, kind:'manual' }
// plan with an explanation. Never guess a destructive reversal.

// Actions that only ever mutated fincore.db and already carry the store reversal
// handle convention {table,key,before}. Reversing them is a single store.restore.
const STORE_ACTIONS = new Set([
  'preferences.set',
  'obligations.upsert',
  'obligations.rekind',
  'obligations.deactivate',
  'goals.insert',
  'constraints.upsert',
  'income_sources.upsert',
  'simplefin_account_map.upsert',
]);

// Actions with no meaningful reversal (informational or self-protecting). Undo is a
// no-op, reported as such rather than as a failure.
const NOOP_ACTIONS = new Set([
  'series.snapshot',
]);

// --- helpers (pure) ---

function manual(reason, extra = {}) {
  return { reversible: false, kind: 'manual', ops: [], describe: `Manual reversal required: ${reason}`, warnings: [reason], ...extra };
}

function noop(reason) {
  return { reversible: false, kind: 'noop', ops: [], describe: reason, warnings: [] };
}

// Parse a JSON column that may be null, a string, or already an object. Audit rows
// store JSON strings; tests and some callers may pass parsed objects. Returns
// { value } on success or { error } on malformed input, never throws.
function parseJson(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === 'object') return { value: v };
  try {
    return { value: JSON.parse(v) };
  } catch {
    return { error: true };
  }
}

// The tags a leg should be restored to when we revert a conversion: the leg's own
// prior tag set MINUS the convert tag we added. The convert added exactly
// `transfer-converted:<w.journal>-<d.journal>`; strip any tag of that family so a
// re-undo cannot leave the marker behind.
function tagsWithoutConvertMarker(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return list.filter((t) => typeof t === 'string' && !t.startsWith('transfer-converted:'));
}

// --- reversal builders, one per understood action ---

// transfer.convert: the forward action deleted the deposit leg and re-pointed the
// withdrawal leg (into a transfer for an asset destination, or a withdrawal into a
// liability for a card payment). The audit `before` holds BOTH original legs as
// legSnapshot() records them (quality.js legSnapshot). Reversal is therefore:
//   (1) recreate the deleted deposit leg from before.deposit, exactly as the feed
//       delivered it — a deposit FROM its original revenue counterparty INTO its own
//       account, same amount/date/description/category/tags/currency/externalId; then
//   (2) revert the withdrawal leg back to a plain withdrawal into its original expense
//       account (before.withdrawal.counterparty), restoring its prior category and
//       stripping the convert marker tag.
// Order matters and mirrors the forward guard: recreate the (income-shaped) deposit
// FIRST, so a mid-undo failure re-adds income rather than leaving a deleted deposit
// and a still-converted withdrawal. Both legs must be present and complete or we
// refuse — a half-known before-state is exactly when a wrong guess corrupts data.
function reverseTransferConvert(before) {
  const w = before?.withdrawal;
  const d = before?.deposit;
  if (!w || !d) return manual('transfer.convert audit lacks both before legs');
  // The deposit recreate needs enough to reconstruct the leg faithfully.
  if (d.amount == null || !d.date || !d.accountId) {
    return manual('deleted deposit leg snapshot is missing amount, date, or own-account id; recreate by hand');
  }
  // The withdrawal revert needs its own account and its original expense counterparty
  // (the destination it pointed at before it was converted). Without the counterparty
  // we cannot name the expense account to send it back to.
  if (!w.accountId || !w.counterparty) {
    return manual('withdrawal leg snapshot is missing its own account or original expense counterparty; revert by hand');
  }

  const ops = [];

  // (1) Recreate the deleted deposit leg. Its own account received the money, so it is
  // the DESTINATION of a deposit; the revenue counterparty is the SOURCE. We recreate
  // by NAME on the counterparty side (the revenue account) and by ID on the own side,
  // matching how the feed's original deposit was shaped. Tags/category/externalId are
  // restored verbatim so the recreated leg is indistinguishable from the original.
  ops.push({
    type: 'firefly.createTransaction',
    args: {
      type: 'deposit',
      date: d.date,
      amount: String(d.amount),
      description: d.description ?? '',
      sourceName: d.counterparty || null,
      destinationId: d.accountId,
      externalId: d.externalId ?? null,
      tags: Array.isArray(d.tags) ? d.tags : [],
      // category is set via a follow-up field the executor passes through; createTransaction
      // does not take category directly, so carry it for a post-create setCategory.
      restoreCategory: d.category ?? null,
    },
  });

  // (2) Revert the withdrawal leg to a plain withdrawal into its original expense
  // account, restoring the prior category and dropping the convert marker tag.
  ops.push({
    type: 'firefly.convertToWithdrawal',
    txId: w.tx_id,
    journalId: w.journal_id,
    args: {
      sourceId: w.accountId,
      destinationName: w.counterparty,
      restoreCategory: w.category ?? null,
      tags: tagsWithoutConvertMarker(w.tags),
    },
  });

  return {
    reversible: true,
    kind: 'firefly',
    ops,
    describe:
      `Undo transfer conversion: recreate the deleted deposit of $${d.amount} into ${d.account || d.accountId} ` +
      `and revert the withdrawal (tx ${w.tx_id}) back to an expense into ${w.counterparty}.`,
    warnings: [
      // The recreated deposit gets a NEW Firefly id; the original id is gone forever.
      'The recreated deposit leg will have a new Firefly transaction id (the original was deleted).',
    ],
  };
}

// Category-set family: transaction.categorize (autonomous), transaction.categorize.confirmed,
// and transfer.match.repair all just set a category (and sometimes tags) on one split and
// stored the prior category in before.category. Reversal restores that prior category.
// A prior category of null means "clear the category" — Firefly setCategory(null) does that.
function reverseCategorySet(before, target) {
  const parsed = targetSplit(target);
  if (!parsed) return manual(`cannot parse Firefly split target "${target}"`);
  // before shape is { category: <string|null> } for categorize actions; the repair
  // action stores { category } too.
  if (before === null || typeof before !== 'object' || !('category' in before)) {
    return manual('category action audit lacks a before.category to restore');
  }
  const prior = before.category ?? null;
  return {
    reversible: true,
    kind: 'firefly',
    ops: [
      {
        type: 'firefly.setCategory',
        txId: parsed.txId,
        journalId: parsed.journalId,
        category: prior, // null clears; string restores
        addTags: [],
        removeTags: [],
      },
    ],
    describe: `Undo categorization on tx ${parsed.txId}: restore category to ${prior === null ? '(none)' : `"${prior}"`}.`,
    warnings: [],
  };
}

// reimbursement.match tagged both legs (a `reimbursement-match:<w.journal>` tag on the
// deposit, a `reimbursed` tag on the withdrawal) and changed no categories or amounts.
// Reversal removes exactly those two tags. before holds the prior tag arrays so we can
// verify, but the safe minimal reversal is to strip the tags the action added.
function reverseReimbursementMatch(before, after, target) {
  // target: firefly:tx:<wTx>:<wJournal>+<dTx>:<dJournal>
  const m = /^firefly:tx:([^:]+):([^+]+)\+([^:]+):(.+)$/.exec(String(target || ''));
  if (!m) return manual(`cannot parse reimbursement.match target "${target}"`);
  const [, wTx, wJournal, dTx, dJournal] = m;
  const tag = after && typeof after === 'object' ? after.tag : null;
  if (!tag) return manual('reimbursement.match audit lacks the applied match tag');
  return {
    reversible: true,
    kind: 'firefly',
    ops: [
      { type: 'firefly.setCategory', txId: dTx, journalId: dJournal, category: undefined, addTags: [], removeTags: [tag] },
      { type: 'firefly.setCategory', txId: wTx, journalId: wJournal, category: undefined, addTags: [], removeTags: ['reimbursed'] },
    ],
    describe: `Undo reimbursement match: remove the "${tag}" tag from the deposit and "reimbursed" from the withdrawal.`,
    warnings: [],
  };
}

// Store-backed reversal: the reversal_handle carries {table,key,before}. before:null
// means the action CREATED the row, so the reversal deletes/deactivates it; a non-null
// before means restore those prior values. The executor owns the table-specific write.
function reverseStoreAction(reversalHandle) {
  const parsed = parseJson(reversalHandle);
  if (parsed.error || parsed.value === null) {
    return manual('store action has no usable reversal handle');
  }
  const h = parsed.value;
  if (!h.table || h.key === undefined) return manual('store reversal handle is missing table or key');
  return {
    reversible: true,
    kind: 'store',
    ops: [{ type: 'store.restore', table: h.table, key: h.key, before: h.before ?? null }],
    describe:
      h.before == null
        ? `Undo ${h.table} change: remove the row this action created (key ${h.key}).`
        : `Undo ${h.table} change: restore ${h.table} key ${h.key} to its prior value.`,
    warnings: [],
  };
}

// --- target parsing ---

// A single-leg Firefly target is "firefly:tx:<txId>:<journalId>".
function targetSplit(target) {
  const m = /^firefly:tx:([^:]+):([^:]+)$/.exec(String(target || ''));
  if (!m) return null;
  return { txId: m[1], journalId: m[2] };
}

// --- public entry point ---

// planReversal(entry): entry is a normalized audit_log row. Fields:
//   { id, actor, action, target, before, after, reversalHandle, reversedBy }
// before/after/reversalHandle may be JSON strings (as stored) or parsed objects.
// Returns a plan object (see file header). Never throws on bad data — malformed input
// degrades to a 'manual' plan so the executor refuses rather than acting on garbage.
export function planReversal(entry) {
  if (!entry || typeof entry !== 'object') return manual('no audit entry supplied');

  // Already reversed: refuse, so an undo cannot be double-applied.
  if (entry.reversedBy != null) {
    return { reversible: false, kind: 'noop', ops: [], describe: `Action ${entry.id ?? ''} was already reversed by audit #${entry.reversedBy}.`, warnings: ['already reversed'] };
  }

  const action = entry.action;
  if (!action) return manual('audit entry has no action');

  const before = parseJson(entry.before).value;
  const after = parseJson(entry.after).value;

  if (NOOP_ACTIONS.has(action)) {
    return noop(`Action "${action}" has no reversible effect; nothing to undo.`);
  }

  // transfer.convert.begin is a write-ahead marker, not a completed change. If a
  // matching transfer.convert exists it is that row that gets undone; a lone begin
  // means the convert never completed and the repair path — not undo — owns it.
  if (action === 'transfer.convert.begin') {
    return manual('transfer.convert.begin is a write-ahead marker, not a completed action; undo the matching transfer.convert, or run the repair path if the convert never completed');
  }

  switch (action) {
    case 'transfer.convert':
      return reverseTransferConvert(before);
    case 'transaction.categorize':
    case 'transaction.categorize.confirmed':
    case 'transfer.match.repair':
      return reverseCategorySet(before, entry.target);
    case 'reimbursement.match':
      return reverseReimbursementMatch(before, after, entry.target);
    default:
      break;
  }

  if (STORE_ACTIONS.has(action)) {
    return reverseStoreAction(entry.reversalHandle);
  }

  // baseline.lock / baseline.correct are deliberately NOT auto-reversible: the baseline
  // is the honesty anchor (SPEC 20) and has its own correction window and path.
  if (action === 'baseline.lock' || action === 'baseline.correct') {
    return manual(`${action} is the baseline anchor; adjust it through the baseline correction path, not undo`);
  }

  return manual(`unknown action "${action}"; no reversal is defined for it`);
}

// Exposed for the executor and tests: the op-type vocabulary a plan can contain.
export const OP_TYPES = Object.freeze([
  'firefly.createTransaction',
  'firefly.convertToWithdrawal',
  'firefly.setCategory',
  'firefly.deleteTransaction',
  'store.restore',
]);
