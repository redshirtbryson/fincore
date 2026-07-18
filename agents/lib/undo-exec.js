// Phase 13 undo EXECUTOR (SPEC section 15). This is the impure-but-thin layer that
// takes a REVERSAL PLAN from the pure engine (lib/undo.js planReversal) and performs
// it: it maps each op to a real Firefly / store write, then records a completion audit
// row and marks the original action reversed via reversed_by.
//
// All I/O flows through INJECTED deps ({ firefly, store }) so the whole executor is
// testable with fakes and no network. Production callers pass the real modules. This
// module NEVER imports lib/firefly.js directly — dependency injection is the point.
//
// Two invariants make a destructive reversal safe to trust:
//   1. VALIDATE EVERYTHING BEFORE EXECUTING ANYTHING. All guards, and validation of
//      every op's type, happen up front. An unknown op discovered mid-flight would
//      leave a half-reversed state; catching it before the first write cannot.
//   2. NEVER SILENTLY SWALLOW A MID-FLIGHT FAILURE. If op N throws after ops 1..N-1
//      already ran, we throw an error naming which op failed and which already ran,
//      and we do NOT write the completion audit row or mark the original reversed —
//      the caller (Discord bot) surfaces the partial state to Bryson.

import { OP_TYPES } from './undo.js';

const KNOWN_OPS = new Set(OP_TYPES);

// --- audit row helpers (own the reversed_by linkage) ---

// Mark the original audit row reversed by pointing reversed_by at the completion row.
// Guarded UPDATE: only flips when reversed_by IS NULL, so a concurrent or repeated
// reversal cannot double-apply (the row's own already-reversed state is the lock).
// Throws if the row is missing or already reversed — the caller must not proceed as
// if the mark succeeded.
export function markReversed(db, originalId, reversedByAuditId) {
  const row = db.prepare('SELECT id, reversed_by FROM audit_log WHERE id = ?').get(originalId);
  if (!row) throw new Error(`cannot mark reversed: audit row ${originalId} not found`);
  if (row.reversed_by != null) {
    throw new Error(`audit row ${originalId} is already reversed by audit #${row.reversed_by}`);
  }
  const info = db
    .prepare('UPDATE audit_log SET reversed_by = ? WHERE id = ? AND reversed_by IS NULL')
    .run(reversedByAuditId, originalId);
  if (info.changes !== 1) {
    // Lost a race between the SELECT and the UPDATE: someone else marked it first.
    throw new Error(`audit row ${originalId} was reversed concurrently; refusing to double-mark`);
  }
}

// Load one audit row and normalize it to the shape planReversal expects. before/after/
// reversalHandle are left as the raw stored JSON strings (or null); planReversal parses
// them itself. Returns null if the row is missing.
export function loadAuditEntry(db, id) {
  const row = db
    .prepare(
      'SELECT id, actor, action, target, before_json, after_json, reversal_handle, reversed_by FROM audit_log WHERE id = ?'
    )
    .get(id);
  if (!row) return null;
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    before: row.before_json,
    after: row.after_json,
    reversalHandle: row.reversal_handle,
    reversedBy: row.reversed_by,
  };
}

// --- store.restore: the table-specific write for a store-backed reversal ---

// Perform a single store.restore op. before:null means the forward action CREATED the
// row, so the reversal removes/deactivates it; a non-null before restores the prior
// values. Only tables whose schema we KNOW are handled: any other table throws, because
// guessing a schema write on irreplaceable data is exactly the failure mode this system
// exists to avoid.
export function restoreStoreRow(db, op) {
  const { table, key, before } = op;
  switch (table) {
    case 'preferences':
      if (before == null) {
        // The action created this preference; remove it.
        db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
      } else {
        // Restore the prior value. before is { value: <string> } per setPrefAudited.
        const value = before && typeof before === 'object' && 'value' in before ? before.value : before;
        db.prepare(
          `INSERT INTO preferences (key, value, updated) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = datetime('now')`
        ).run(key, String(value));
      }
      return;

    case 'simplefin_account_map':
      if (before == null) {
        // The action created this mapping; deactivate it (soft-delete: the map's own
        // convention is active=0, and other rows may FK-reference the id downstream).
        db.prepare(
          `UPDATE simplefin_account_map SET active = 0, updated = datetime('now') WHERE simplefin_id = ?`
        ).run(key);
      } else {
        // Restore the prior row verbatim. before is the full SELECT * row the audit
        // captured (firefly_account_id, firefly_account_name, active, mode, ...).
        db.prepare(
          `INSERT INTO simplefin_account_map
             (simplefin_id, firefly_account_id, firefly_account_name, active, mode, updated)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(simplefin_id) DO UPDATE SET
             firefly_account_id = excluded.firefly_account_id,
             firefly_account_name = excluded.firefly_account_name,
             active = excluded.active,
             mode = excluded.mode,
             updated = datetime('now')`
        ).run(
          key,
          String(before.firefly_account_id),
          before.firefly_account_name ?? null,
          before.active != null ? before.active : 1,
          before.mode || 'txn'
        );
      }
      return;

    default:
      // Never guess a schema write for a table we do not know how to restore.
      throw new Error(`manual restore required for table ${table}`);
  }
}

// --- the executor ---

// Validate a plan before ANY execution. Throws on the first structural problem so the
// caller gets a clean refusal with nothing written. Returns nothing; success is "did
// not throw".
function validatePlanOrThrow(entry, plan) {
  if (!plan || typeof plan !== 'object') throw new Error('no reversal plan supplied');
  if (plan.reversible !== true) {
    throw new Error(`plan is not reversible: ${plan.describe || 'no reason given'}`);
  }
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) {
    throw new Error('plan is marked reversible but has no ops to execute');
  }
  if (entry && entry.reversedBy != null) {
    throw new Error(`action ${entry.id ?? ''} was already reversed by audit #${entry.reversedBy}`);
  }
  // Validate ALL op types up front. An unknown op discovered mid-flight would leave a
  // half-reversed state, so we refuse the whole plan before touching anything.
  plan.ops.forEach((op, i) => {
    if (!op || typeof op !== 'object' || !KNOWN_OPS.has(op.type)) {
      throw new Error(`plan op ${i + 1} has unknown type "${op?.type}"; refusing to execute any op`);
    }
  });
}

// Execute one op through the injected firefly/store deps. Pure dispatch: no guards here
// (validatePlanOrThrow already vetted the type), just the op.type -> deps call mapping.
async function executeOp(deps, db, op) {
  switch (op.type) {
    case 'firefly.createTransaction': {
      const created = await deps.firefly.createTransaction(op.args);
      // undo.js encodes a category to restore on the recreated leg as op.args.restoreCategory
      // (createTransaction itself takes no category). If a category is carried AND the
      // create returned a real id, follow with setCategory on that new transaction so the
      // recreated leg is indistinguishable from the original.
      const restoreCategory = op.args ? op.args.restoreCategory : null;
      if (restoreCategory != null && created && created.id) {
        await deps.firefly.setCategory(created.id, null, restoreCategory, { addTags: [], removeTags: [] });
      }
      return;
    }
    case 'firefly.convertToWithdrawal':
      await deps.firefly.convertToWithdrawal(op.txId, op.journalId, op.args);
      return;
    case 'firefly.setCategory':
      await deps.firefly.setCategory(op.txId, op.journalId, op.category, {
        addTags: op.addTags || [],
        removeTags: op.removeTags || [],
      });
      return;
    case 'firefly.deleteTransaction':
      await deps.firefly.deleteTransaction(op.id);
      return;
    case 'store.restore':
      restoreStoreRow(db, op);
      return;
    default:
      // Unreachable: validatePlanOrThrow rejects unknown types before execution.
      throw new Error(`unhandled op type "${op.type}"`);
  }
}

// executeReversal: perform plan.ops IN ORDER through injected deps, then record the
// completion audit row and mark the original reversed. Returns { auditId, opsExecuted }.
//
// deps  = { firefly, store } (real modules in prod; fakes in tests).
// db    = the fincore.db handle (store.restore ops and the audit writes touch it).
// entry = the normalized original audit row being reversed.
// plan  = the plan planReversal(entry) produced.
export async function executeReversal(deps, db, entry, plan, { actor } = {}) {
  // All guards and full op-type validation BEFORE any write. Nothing partial.
  validatePlanOrThrow(entry, plan);

  // Execute in order. A failure mid-flight is re-thrown with an index-and-progress
  // message and NO completion audit / reversed_by mark, so the caller surfaces the
  // partial state rather than the system silently believing the undo finished.
  for (let i = 0; i < plan.ops.length; i += 1) {
    try {
      await executeOp(deps, db, plan.ops[i]);
    } catch (e) {
      const done = i === 0 ? 'none' : `1-${i}`;
      throw new Error(
        `reversal partially applied: ops ${done} of ${plan.ops.length} done, op ${i + 1} failed: ${e.message}`
      );
    }
  }

  // All ops landed. Record the completion audit row through the injected store, linking
  // back to the reversed action, then mark the original reversed by that new row's id.
  const auditId = deps.store.audit(db, {
    actor,
    action: `${entry.action}.undo`,
    target: entry.target,
    before: { reversedAuditId: entry.id },
    after: { ops: plan.ops.length, describe: plan.describe },
  });
  markReversed(db, entry.id, auditId);

  return { auditId, opsExecuted: plan.ops.length };
}
