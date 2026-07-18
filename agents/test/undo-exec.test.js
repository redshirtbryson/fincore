// Money-grade tests for the Phase 13 undo EXECUTOR (SPEC section 15). The executor is
// the one place a destructive reversal actually happens, so these assert both that it
// performs the plan's ops IN ORDER with the right args AND that it REFUSES — with
// nothing written — the instant a guard trips or an op type is unknown. A half-applied
// reversal is the worst outcome, so mid-flight failure is tested to leave no completion
// audit and no reversed_by mark.
//
// The ops under test are REAL plans from the REAL planReversal (lib/undo.js) against
// realistic audit entries (mirroring test/undo.test.js fixtures), so the executor is
// exercised against genuine op shapes rather than hand-built stand-ins. The store DB is
// a REAL in-memory openStore for the audit / markReversed / restoreStoreRow paths; only
// the Firefly (and the store.audit spy) side is faked, since network is the thing we
// must not touch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, audit } from '../lib/store.js';
import { planReversal } from '../lib/undo.js';
import {
  executeReversal,
  restoreStoreRow,
  loadAuditEntry,
  markReversed,
} from '../lib/undo-exec.js';

function memStore() {
  return openStore(':memory:');
}

// A fake firefly that RECORDS every call into arrays, returning configurable results.
// createResult lets a test control the id createTransaction hands back (needed to drive
// the restoreCategory follow-up). failOn makes a named method throw the Nth time it is
// called, to simulate a mid-flight failure without any network.
function fakeFirefly({ createResult = { id: 'new-777' }, failOn = null } = {}) {
  const calls = { createTransaction: [], setCategory: [], convertToWithdrawal: [], deleteTransaction: [] };
  const order = [];
  function maybeFail(method) {
    if (failOn && failOn.method === method) {
      failOn.count = (failOn.count || 0) + 1;
      if (failOn.count >= (failOn.nth || 1)) throw new Error(failOn.message || `${method} boom`);
    }
  }
  return {
    calls,
    order,
    async createTransaction(args) {
      calls.createTransaction.push(args);
      order.push('createTransaction');
      maybeFail('createTransaction');
      return createResult;
    },
    async setCategory(txId, journalId, category, opts) {
      calls.setCategory.push({ txId, journalId, category, opts });
      order.push('setCategory');
      maybeFail('setCategory');
      return {};
    },
    async convertToWithdrawal(txId, journalId, args) {
      calls.convertToWithdrawal.push({ txId, journalId, args });
      order.push('convertToWithdrawal');
      maybeFail('convertToWithdrawal');
      return {};
    },
    async deleteTransaction(id) {
      calls.deleteTransaction.push({ id });
      order.push('deleteTransaction');
      maybeFail('deleteTransaction');
      return {};
    },
  };
}

// A fake store whose audit() spies but still writes to the real db, so markReversed's
// FK to a real audit row is satisfiable. Records the audit payload for assertions.
function fakeStore() {
  const audited = [];
  return {
    audited,
    audit(db, entry) {
      audited.push(entry);
      return audit(db, entry);
    },
  };
}

// legSnapshot() shape as quality.js records it (mirrors test/undo.test.js).
function leg(over = {}) {
  return {
    tx_id: 't1', journal_id: 'j1', accountId: 'acct-checking', account: 'Checking',
    counterparty: 'Some Expense', amount: '123.45', date: '2026-07-10',
    description: 'INTERNET TFR', category: null, tags: [], currencyCode: 'USD', externalId: null,
    ...over,
  };
}

// A realistic transfer.convert audit entry (the destructive headline case), matching the
// convertEntry factory in test/undo.test.js.
function convertEntryFields() {
  const withdrawal = leg({ tx_id: 'wtx', journal_id: 'wj', accountId: 'acct-checking', counterparty: 'AMAZON', category: 'Shopping', tags: ['transfer-converted:wj-dj', 'keep-me'] });
  const deposit = leg({ tx_id: 'dtx', journal_id: 'dj', accountId: 'acct-savings', account: 'Savings', counterparty: 'PAYROLL CO', amount: '500.00', date: '2026-07-09', description: 'DIRECT DEPOSIT', category: 'Income', tags: ['ai-categorized'], externalId: 'ext-9' });
  return { withdrawal, deposit };
}

// Insert a real transfer.convert row and return its normalized loaded entry.
function seedConvertRow(db) {
  const { withdrawal, deposit } = convertEntryFields();
  const id = audit(db, {
    actor: 'matcher', action: 'transfer.convert',
    target: `firefly:tx:${withdrawal.tx_id}:${withdrawal.journal_id}`,
    before: { withdrawal, deposit },
    after: { type: 'transfer', deletedDepositTx: deposit.tx_id },
  });
  return loadAuditEntry(db, id);
}

// ---- full success path: transfer.convert (real plan, ops in order) ----

test('executeReversal runs a transfer.convert plan in order with the right args and records the undo', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const plan = planReversal(entry);
  assert.equal(plan.reversible, true);
  assert.equal(plan.ops.length, 2);

  const firefly = fakeFirefly({ createResult: { id: 'recreated-1' } });
  const store = fakeStore();

  const res = await executeReversal({ firefly, store }, db, entry, plan, { actor: 'bryson' });

  // Ops ran in plan order: recreate the deposit (create + restoreCategory follow-up) THEN
  // revert the withdrawal.
  assert.deepEqual(firefly.order, ['createTransaction', 'setCategory', 'convertToWithdrawal']);

  // createTransaction got the deposit-recreate args verbatim.
  assert.equal(firefly.calls.createTransaction.length, 1);
  const createArgs = firefly.calls.createTransaction[0];
  assert.equal(createArgs.type, 'deposit');
  assert.equal(createArgs.amount, '500.00');
  assert.equal(createArgs.destinationId, 'acct-savings');
  assert.equal(createArgs.sourceName, 'PAYROLL CO');

  // restoreCategory follow-up hit the NEW transaction id with the stored category.
  assert.equal(firefly.calls.setCategory.length, 1);
  const setCat = firefly.calls.setCategory[0];
  assert.equal(setCat.txId, 'recreated-1');
  assert.equal(setCat.journalId, null);
  assert.equal(setCat.category, 'Income');

  // convertToWithdrawal reverted the surviving leg with the plan's args.
  assert.equal(firefly.calls.convertToWithdrawal.length, 1);
  const conv = firefly.calls.convertToWithdrawal[0];
  assert.equal(conv.txId, 'wtx');
  assert.equal(conv.journalId, 'wj');
  assert.equal(conv.args.destinationName, 'AMAZON');
  assert.equal(conv.args.restoreCategory, 'Shopping');
  assert.deepEqual(conv.args.tags, ['keep-me']);

  // A completion audit row was written with the .undo action and the linkage payload.
  assert.equal(store.audited.length, 1);
  assert.equal(store.audited[0].action, 'transfer.convert.undo');
  assert.deepEqual(store.audited[0].before, { reversedAuditId: entry.id });
  assert.equal(store.audited[0].after.ops, 2);

  // The original row is now marked reversed_by the new row.
  const row = db.prepare('SELECT reversed_by FROM audit_log WHERE id = ?').get(entry.id);
  assert.equal(row.reversed_by, res.auditId);
  assert.equal(res.opsExecuted, 2);
});

test('a firefly.setCategory-only plan (transaction.categorize) executes and audits', async () => {
  const db = memStore();
  const id = audit(db, {
    actor: 'daily', action: 'transaction.categorize',
    target: 'firefly:tx:900:901',
    before: { category: 'Dining' }, after: { category: 'Groceries' },
  });
  const entry = loadAuditEntry(db, id);
  const plan = planReversal(entry);
  const firefly = fakeFirefly();
  const store = fakeStore();

  await executeReversal({ firefly, store }, db, entry, plan, { actor: 'bryson' });

  assert.equal(firefly.calls.setCategory.length, 1);
  const c = firefly.calls.setCategory[0];
  assert.equal(c.txId, '900');
  assert.equal(c.journalId, '901');
  assert.equal(c.category, 'Dining'); // prior category restored
  assert.equal(store.audited[0].action, 'transaction.categorize.undo');
});

// ---- refusal guards: nothing executes, no writes ----

test('executeReversal refuses a non-reversible plan and calls nothing', async () => {
  const db = memStore();
  const id = audit(db, { actor: 'x', action: 'baseline.lock', target: 'nw_dti_series:2026-01-01' });
  const entry = loadAuditEntry(db, id);
  const plan = planReversal(entry); // manual, reversible:false
  const firefly = fakeFirefly();
  const store = fakeStore();

  await assert.rejects(() => executeReversal({ firefly, store }, db, entry, plan, { actor: 'b' }), /not reversible/);
  assert.deepEqual(firefly.order, []);
  assert.equal(store.audited.length, 0);
});

test('executeReversal refuses an already-reversed entry', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const plan = planReversal(entry);
  // Mark it reversed before we try.
  const other = audit(db, { actor: 'x', action: 'noise' });
  markReversed(db, entry.id, other);
  const reloaded = loadAuditEntry(db, entry.id);

  const firefly = fakeFirefly();
  const store = fakeStore();
  await assert.rejects(
    () => executeReversal({ firefly, store }, db, reloaded, plan, { actor: 'b' }),
    /already reversed/
  );
  assert.deepEqual(firefly.order, []);
  assert.equal(store.audited.length, 0);
});

test('executeReversal validates ALL op types BEFORE executing any op', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const plan = planReversal(entry);
  // Corrupt the SECOND op's type. A naive executor would run op 1 then fail on op 2,
  // leaving a half-reversed state; the guard must reject the whole plan up front.
  plan.ops[1] = { ...plan.ops[1], type: 'firefly.notARealOp' };

  const firefly = fakeFirefly();
  const store = fakeStore();
  await assert.rejects(
    () => executeReversal({ firefly, store }, db, entry, plan, { actor: 'b' }),
    /unknown type "firefly.notARealOp"/
  );
  // Zero fake calls: op 1 must not have run.
  assert.deepEqual(firefly.order, []);
  assert.equal(store.audited.length, 0);
  const row = db.prepare('SELECT reversed_by FROM audit_log WHERE id = ?').get(entry.id);
  assert.equal(row.reversed_by, null);
});

test('executeReversal refuses an empty-ops plan', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const firefly = fakeFirefly();
  const store = fakeStore();
  await assert.rejects(
    () => executeReversal({ firefly, store }, db, entry, { reversible: true, ops: [], describe: 'x' }, { actor: 'b' }),
    /no ops/
  );
  assert.deepEqual(firefly.order, []);
});

// ---- mid-flight failure: names the op, writes nothing, leaves the original un-reversed ----

test('mid-flight failure names the failed op and does NOT record the undo or mark reversed', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const plan = planReversal(entry); // op1 create(+setCategory), op2 convertToWithdrawal

  // Make op 2 (convertToWithdrawal) throw. Op 1 (create + its setCategory follow-up) runs.
  const firefly = fakeFirefly({ failOn: { method: 'convertToWithdrawal', message: 'firefly 500' } });
  const store = fakeStore();

  await assert.rejects(
    () => executeReversal({ firefly, store }, db, entry, plan, { actor: 'b' }),
    (err) => {
      assert.match(err.message, /reversal partially applied/);
      assert.match(err.message, /op 2 failed/);
      assert.match(err.message, /ops 1-1 of 2 done/);
      assert.match(err.message, /firefly 500/);
      return true;
    }
  );

  // Op 1 did run (create + follow-up setCategory), op 2 failed.
  assert.deepEqual(firefly.order, ['createTransaction', 'setCategory', 'convertToWithdrawal']);
  // No completion audit, original NOT marked reversed.
  assert.equal(store.audited.length, 0);
  const row = db.prepare('SELECT reversed_by FROM audit_log WHERE id = ?').get(entry.id);
  assert.equal(row.reversed_by, null);
});

test('a failure on the FIRST op reports "ops none of N done"', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const plan = planReversal(entry);
  const firefly = fakeFirefly({ failOn: { method: 'createTransaction', message: 'nope' } });
  const store = fakeStore();
  await assert.rejects(
    () => executeReversal({ firefly, store }, db, entry, plan, { actor: 'b' }),
    /ops none of 2 done, op 1 failed: nope/
  );
});

// ---- restoreStoreRow: preferences (null + value) and the unsupported-table throw ----

test('restoreStoreRow deletes a preference when before is null (row was created)', () => {
  const db = memStore();
  db.prepare(`INSERT INTO preferences (key, value) VALUES ('theme', 'dark')`).run();
  restoreStoreRow(db, { type: 'store.restore', table: 'preferences', key: 'theme', before: null });
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get('theme');
  assert.equal(row, undefined);
});

test('restoreStoreRow restores a preference prior value when before is non-null', () => {
  const db = memStore();
  db.prepare(`INSERT INTO preferences (key, value) VALUES ('autonomy_dollar_threshold', '75')`).run();
  restoreStoreRow(db, {
    type: 'store.restore', table: 'preferences', key: 'autonomy_dollar_threshold',
    before: { value: '50' },
  });
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get('autonomy_dollar_threshold');
  assert.equal(row.value, '50');
});

test('restoreStoreRow restores a simplefin_account_map row from its full before snapshot', () => {
  const db = memStore();
  db.prepare(
    `INSERT INTO simplefin_account_map (simplefin_id, firefly_account_id, firefly_account_name, active, mode)
     VALUES ('sf-1', '999', 'New Name', 1, 'balance')`
  ).run();
  restoreStoreRow(db, {
    type: 'store.restore', table: 'simplefin_account_map', key: 'sf-1',
    before: { simplefin_id: 'sf-1', firefly_account_id: '111', firefly_account_name: 'Old Name', active: 1, mode: 'txn' },
  });
  const row = db.prepare('SELECT * FROM simplefin_account_map WHERE simplefin_id = ?').get('sf-1');
  assert.equal(row.firefly_account_id, '111');
  assert.equal(row.firefly_account_name, 'Old Name');
  assert.equal(row.mode, 'txn');
});

test('restoreStoreRow deactivates a created simplefin_account_map row when before is null', () => {
  const db = memStore();
  db.prepare(
    `INSERT INTO simplefin_account_map (simplefin_id, firefly_account_id, active) VALUES ('sf-2', '222', 1)`
  ).run();
  restoreStoreRow(db, { type: 'store.restore', table: 'simplefin_account_map', key: 'sf-2', before: null });
  const row = db.prepare('SELECT active FROM simplefin_account_map WHERE simplefin_id = ?').get('sf-2');
  assert.equal(row.active, 0);
});

test('restoreStoreRow throws "manual restore required" for an unknown table, never guessing', () => {
  const db = memStore();
  assert.throws(
    () => restoreStoreRow(db, { type: 'store.restore', table: 'goals', key: 3, before: null }),
    /manual restore required for table goals/
  );
});

test('executeReversal runs a real store-backed plan (preferences.set) end to end', async () => {
  const db = memStore();
  db.prepare(`INSERT INTO preferences (key, value) VALUES ('autonomy_dollar_threshold', '75')`).run();
  const id = audit(db, {
    actor: 'assistant', action: 'preferences.set', target: 'preferences:autonomy_dollar_threshold',
    before: { value: '50' }, after: { value: '75' },
    reversalHandle: JSON.stringify({ table: 'preferences', key: 'autonomy_dollar_threshold', before: { value: '50' } }),
  });
  const entry = loadAuditEntry(db, id);
  const plan = planReversal(entry);
  assert.equal(plan.ops[0].type, 'store.restore');

  const firefly = fakeFirefly();
  const store = fakeStore();
  await executeReversal({ firefly, store }, db, entry, plan, { actor: 'bryson' });

  assert.equal(db.prepare('SELECT value FROM preferences WHERE key = ?').get('autonomy_dollar_threshold').value, '50');
  assert.deepEqual(firefly.order, []); // no firefly calls for a store reversal
  assert.equal(store.audited[0].action, 'preferences.set.undo');
});

// ---- loadAuditEntry round-trip ----

test('loadAuditEntry normalizes a row to the planReversal shape (JSON left as strings)', () => {
  const db = memStore();
  const id = audit(db, {
    actor: 'daily', action: 'transaction.categorize', target: 'firefly:tx:5:6',
    before: { category: 'Utilities' }, after: { category: 'Groceries' },
    reversalHandle: null,
  });
  const entry = loadAuditEntry(db, id);
  assert.equal(entry.id, id);
  assert.equal(entry.actor, 'daily');
  assert.equal(entry.action, 'transaction.categorize');
  assert.equal(entry.target, 'firefly:tx:5:6');
  // before/after stay JSON strings; planReversal parses them itself.
  assert.equal(typeof entry.before, 'string');
  assert.deepEqual(JSON.parse(entry.before), { category: 'Utilities' });
  assert.equal(entry.reversedBy, null);
  // The plan built from a loaded entry is genuinely reversible.
  assert.equal(planReversal(entry).reversible, true);
});

test('loadAuditEntry returns null for a missing row', () => {
  const db = memStore();
  assert.equal(loadAuditEntry(db, 99999), null);
});

// ---- double-execute protection ----

test('a second executeReversal throws because reversed_by is already set', async () => {
  const db = memStore();
  const entry = seedConvertRow(db);
  const plan = planReversal(entry);
  const firefly = fakeFirefly();
  const store = fakeStore();

  await executeReversal({ firefly, store }, db, entry, plan, { actor: 'b' });

  // Reload the (now reversed) entry and try again. planReversal itself would refuse, but
  // even bypassing it with the stale plan, markReversed's guard is the backstop.
  const reloaded = loadAuditEntry(db, entry.id);
  assert.notEqual(reloaded.reversedBy, null);
  await assert.rejects(
    () => executeReversal({ firefly, store }, db, reloaded, plan, { actor: 'b' }),
    /already reversed/
  );
});

test('markReversed throws on a missing row and on a double-mark', () => {
  const db = memStore();
  assert.throws(() => markReversed(db, 424242, 1), /not found/);
  const a = audit(db, { actor: 'x', action: 'a' });
  const b = audit(db, { actor: 'x', action: 'b' });
  markReversed(db, a, b);
  assert.throws(() => markReversed(db, a, b), /already reversed/);
});
