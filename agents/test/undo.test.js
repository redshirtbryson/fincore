// Money-grade tests for the Phase 13 undo core (SPEC section 15). planReversal is
// PURE and its output is DESTRUCTIVE-write instructions, so these assert the exact
// ops it emits (order, args, tags) and — just as important — that it REFUSES with a
// 'manual' plan whenever the stored before-state is incomplete or the action is
// unknown. A wrong reversal is worse than no reversal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planReversal, OP_TYPES } from '../lib/undo.js';

// legSnapshot() shape as quality.js records it, minimal factory.
function leg(over = {}) {
  return {
    tx_id: 't1',
    journal_id: 'j1',
    accountId: 'acct-checking',
    account: 'Checking',
    counterparty: 'Some Expense',
    amount: '123.45',
    date: '2026-07-10',
    description: 'INTERNET TFR',
    category: null,
    tags: [],
    currencyCode: 'USD',
    externalId: null,
    ...over,
  };
}

function convertEntry(over = {}) {
  const withdrawal = leg({ tx_id: 'wtx', journal_id: 'wj', accountId: 'acct-checking', counterparty: 'AMAZON', category: 'Shopping', tags: ['transfer-converted:wj-dj', 'keep-me'], ...(over.withdrawal || {}) });
  const deposit = leg({ tx_id: 'dtx', journal_id: 'dj', accountId: 'acct-savings', account: 'Savings', counterparty: 'PAYROLL CO', amount: '500.00', date: '2026-07-09', description: 'DIRECT DEPOSIT', category: 'Income', tags: ['ai-categorized'], externalId: 'ext-9', ...(over.deposit || {}) });
  return {
    id: 42,
    actor: 'matcher',
    action: 'transfer.convert',
    target: `firefly:tx:${withdrawal.tx_id}:${withdrawal.journal_id}`,
    before: { withdrawal, deposit },
    after: { type: 'transfer', deletedDepositTx: deposit.tx_id },
    reversalHandle: null,
    reversedBy: null,
    ...over,
  };
}

// ---- transfer.convert (the destructive, headline case) ----

test('transfer.convert reversal recreates the deleted deposit THEN reverts the withdrawal', () => {
  const plan = planReversal(convertEntry());
  assert.equal(plan.reversible, true);
  assert.equal(plan.kind, 'firefly');
  assert.equal(plan.ops.length, 2);

  // (1) recreate the deposit first (income-shaped op leads, mirroring the forward guard)
  const [recreate, revert] = plan.ops;
  assert.equal(recreate.type, 'firefly.createTransaction');
  assert.equal(recreate.args.type, 'deposit');
  assert.equal(recreate.args.amount, '500.00');
  assert.equal(recreate.args.date, '2026-07-09');
  assert.equal(recreate.args.destinationId, 'acct-savings'); // money went INTO the own account
  assert.equal(recreate.args.sourceName, 'PAYROLL CO');      // revenue counterparty is the source
  assert.equal(recreate.args.externalId, 'ext-9');
  assert.deepEqual(recreate.args.tags, ['ai-categorized']);
  assert.equal(recreate.args.restoreCategory, 'Income');

  // (2) revert the withdrawal back to an expense, restoring category and stripping the marker
  assert.equal(revert.type, 'firefly.convertToWithdrawal');
  assert.equal(revert.txId, 'wtx');
  assert.equal(revert.journalId, 'wj');
  assert.equal(revert.args.sourceId, 'acct-checking');
  assert.equal(revert.args.destinationName, 'AMAZON');
  assert.equal(revert.args.restoreCategory, 'Shopping');
  // the transfer-converted marker is dropped; unrelated tags survive
  assert.deepEqual(revert.args.tags, ['keep-me']);

  // the recreated-id caveat is surfaced
  assert.ok(plan.warnings.some((w) => /new Firefly transaction id/.test(w)));
});

test('transfer.convert refuses when the deposit snapshot is incomplete', () => {
  const plan = planReversal(convertEntry({ before: { withdrawal: leg(), deposit: leg({ amount: null }) } }));
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
  assert.match(plan.warnings[0], /deposit/);
});

test('transfer.convert refuses when the withdrawal lost its original expense counterparty', () => {
  const plan = planReversal(convertEntry({ before: { withdrawal: leg({ counterparty: '' }), deposit: leg({ amount: '5', date: '2026-01-01', accountId: 'x' }) } }));
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
  assert.match(plan.warnings[0], /counterparty/);
});

test('transfer.convert refuses when a before leg is missing entirely', () => {
  const plan = planReversal(convertEntry({ before: { withdrawal: leg() } }));
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
});

// ---- category-set family ----

test('transaction.categorize reversal restores the prior category (null clears it)', () => {
  const plan = planReversal({
    id: 1, action: 'transaction.categorize',
    target: 'firefly:tx:900:901',
    before: { category: null }, after: { category: 'Groceries' },
  });
  assert.equal(plan.reversible, true);
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].type, 'firefly.setCategory');
  assert.equal(plan.ops[0].txId, '900');
  assert.equal(plan.ops[0].journalId, '901');
  assert.equal(plan.ops[0].category, null); // was uncategorized before -> clear it
});

test('confirmed categorization reversal restores a prior non-null category', () => {
  const plan = planReversal({
    id: 2, action: 'transaction.categorize.confirmed',
    target: 'firefly:tx:900:901',
    before: { category: 'Dining' }, after: { category: 'Groceries' },
  });
  assert.equal(plan.ops[0].category, 'Dining');
});

test('category reversal accepts JSON-string before/after as stored in the DB', () => {
  const plan = planReversal({
    id: 3, action: 'transaction.categorize',
    target: 'firefly:tx:5:6',
    before: JSON.stringify({ category: 'Utilities' }),
    after: JSON.stringify({ category: 'Groceries' }),
  });
  assert.equal(plan.reversible, true);
  assert.equal(plan.ops[0].category, 'Utilities');
});

test('category reversal refuses an unparseable target', () => {
  const plan = planReversal({ id: 4, action: 'transaction.categorize', target: 'not-a-target', before: { category: 'X' } });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
});

test('transfer.match.repair reverses as a category restore', () => {
  const plan = planReversal({
    id: 5, action: 'transfer.match.repair',
    target: 'firefly:tx:10:11',
    before: { category: 'Debt Payment' }, after: { category: 'Transfer' },
  });
  assert.equal(plan.reversible, true);
  assert.equal(plan.ops[0].category, 'Debt Payment');
});

// ---- reimbursement.match ----

test('reimbursement.match reversal strips exactly the two tags it added', () => {
  const plan = planReversal({
    id: 6, action: 'reimbursement.match',
    target: 'firefly:tx:wTx:wJ+dTx:dJ',
    before: { withdrawalTags: [], depositTags: [] },
    after: { tag: 'reimbursement-match:wJ' },
  });
  assert.equal(plan.reversible, true);
  assert.equal(plan.ops.length, 2);
  const [depOp, wOp] = plan.ops;
  assert.equal(depOp.txId, 'dTx');
  assert.equal(depOp.journalId, 'dJ');
  assert.deepEqual(depOp.removeTags, ['reimbursement-match:wJ']);
  assert.equal(depOp.category, undefined); // tags-only, no category change
  assert.equal(wOp.txId, 'wTx');
  assert.deepEqual(wOp.removeTags, ['reimbursed']);
});

test('reimbursement.match refuses when the applied tag is absent from after', () => {
  const plan = planReversal({ id: 7, action: 'reimbursement.match', target: 'firefly:tx:a:b+c:d', before: {}, after: {} });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
});

// ---- store-backed actions ----

test('preferences.set reversal restores the prior value via a store.restore op', () => {
  const plan = planReversal({
    id: 8, action: 'preferences.set', target: 'preferences:autonomy_dollar_threshold',
    before: { value: '50' }, after: { value: '75' },
    reversalHandle: JSON.stringify({ table: 'preferences', key: 'autonomy_dollar_threshold', before: { value: '50' } }),
  });
  assert.equal(plan.reversible, true);
  assert.equal(plan.kind, 'store');
  assert.equal(plan.ops[0].type, 'store.restore');
  assert.equal(plan.ops[0].table, 'preferences');
  assert.equal(plan.ops[0].key, 'autonomy_dollar_threshold');
  assert.deepEqual(plan.ops[0].before, { value: '50' });
});

test('store action with a null before means the reversal deletes the created row', () => {
  const plan = planReversal({
    id: 9, action: 'goals.insert', target: 'goals:3',
    before: null, after: { name: 'Emergency fund' },
    reversalHandle: JSON.stringify({ table: 'goals', key: 3, before: null }),
  });
  assert.equal(plan.reversible, true);
  assert.equal(plan.ops[0].before, null);
  assert.match(plan.describe, /remove the row/);
});

test('store action with an unusable reversal handle degrades to manual', () => {
  const plan = planReversal({ id: 10, action: 'preferences.set', target: 'preferences:x', reversalHandle: null });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
});

// ---- guardrails: refusals and no-ops ----

test('an already-reversed action is not reversible again', () => {
  const plan = planReversal(convertEntry({ reversedBy: 99 }));
  assert.equal(plan.reversible, false);
  assert.match(plan.describe, /already reversed/);
});

test('series.snapshot is a no-op, not a failure', () => {
  const plan = planReversal({ id: 11, action: 'series.snapshot', target: 'nw_dti_series:2026-07-10' });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'noop');
});

test('baseline.lock is deliberately not undoable through undo', () => {
  const plan = planReversal({ id: 12, action: 'baseline.lock', target: 'nw_dti_series:2026-01-01' });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
  assert.match(plan.warnings[0], /baseline/);
});

test('transfer.convert.begin is not directly undoable (write-ahead marker)', () => {
  const plan = planReversal({ id: 13, action: 'transfer.convert.begin', target: 'firefly:tx:1:2', before: {} });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
});

test('an unknown action degrades to a clearly-marked manual plan, never a guess', () => {
  const plan = planReversal({ id: 14, action: 'some.future.action', target: 'x' });
  assert.equal(plan.reversible, false);
  assert.equal(plan.kind, 'manual');
  assert.match(plan.warnings[0], /unknown action/);
});

test('malformed input never throws; it degrades to manual', () => {
  assert.equal(planReversal(null).kind, 'manual');
  assert.equal(planReversal({}).kind, 'manual');
  assert.equal(planReversal({ action: 'transfer.convert', before: '{not json' }).reversible, false);
});

test('every op a plan can emit is in the declared OP_TYPES vocabulary', () => {
  const plans = [
    planReversal(convertEntry()),
    planReversal({ id: 1, action: 'transaction.categorize', target: 'firefly:tx:1:2', before: { category: 'X' } }),
    planReversal({ id: 6, action: 'reimbursement.match', target: 'firefly:tx:a:b+c:d', before: {}, after: { tag: 'reimbursement-match:b' } }),
    planReversal({ id: 8, action: 'preferences.set', target: 'preferences:k', reversalHandle: JSON.stringify({ table: 'preferences', key: 'k', before: { value: '1' } }) }),
  ];
  for (const p of plans) {
    for (const op of p.ops) assert.ok(OP_TYPES.includes(op.type), `unexpected op type ${op.type}`);
  }
});
