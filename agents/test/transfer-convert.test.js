// Money-grade tests for the transfer auto-conversion SAFETY GATES (SPEC section 15).
// Converting a matched leg-pair into a real Firefly transfer deletes a transaction,
// so autoConvertVerdict is the load-bearing guard that decides what may happen without
// a human. These assert the guard's DEFINITION: the deleted (deposit) leg must itself
// name an internal movement, both legs must be category-clean, both own-account ids
// must resolve, and neither leg may be part of a multi-split group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoConvertVerdict, multiSplitTxIds } from '../lib/quality.js';

// Minimal matched-pair factory. Only the fields the verdict reads are set.
function pair({ wDesc = 'SYNCHRONY BANK', dDesc = 'PAYMENT THANK YOU', wCat = '', dCat = '', wId = 'a1', dId = 'a2', wTx = 't1', dTx = 't2' } = {}) {
  return {
    withdrawal: { description: wDesc, category: wCat, accountId: wId, tx_id: wTx },
    deposit: { description: dDesc, category: dCat, accountId: dId, tx_id: dTx },
    dateDelta: 0,
  };
}

test('autoConvertVerdict passes a clean, corroborated, single-split internal pair', () => {
  assert.deepEqual(autoConvertVerdict(pair()), { ok: true });
  // A card payment is categorized Debt Payment by the rules; that is internal, not a conflict.
  assert.deepEqual(autoConvertVerdict(pair({ wCat: 'Debt Payment', dCat: 'Transfer' })), { ok: true });
});

test('autoConvertVerdict requires the DEPOSIT leg to name the internal movement', () => {
  // The deposit leg is the one deleted and the one that reads as income. A corroborated
  // withdrawal is not enough if the deposit could be real income into an asset account.
  const v = autoConvertVerdict(pair({ wDesc: 'INTERNET TFR', dDesc: 'PAYROLL DEPOSIT' }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /deposit leg/);
});

test('autoConvertVerdict converts a card payment whose deposit lands in a liability account', () => {
  // Path (2): the deposit ("DIRECTPAY MINIMUM PAYMENT" — not internal wording) lands in
  // a credit-card liability, and the withdrawal reads as a card payment. Money is never
  // paid into a card as income, so this is a safe conversion even without deposit wording.
  const m = pair({ wDesc: 'DISCOVER E-PAYMENT', dDesc: 'DIRECTPAY MINIMUM PAYMENT', dId: 'cc9' });
  assert.deepEqual(autoConvertVerdict(m, { liabilityIds: new Set(['cc9']) }), { ok: true });
  // Same pair WITHOUT the liability hint is not safe: it could be a real inbound payment.
  assert.equal(autoConvertVerdict(m).ok, false);
  // And a liability deposit whose WITHDRAWAL does not read as a payment stays unsafe.
  const m2 = pair({ wDesc: 'ZELLE FROM BOB', dDesc: 'DIRECTPAY MINIMUM PAYMENT', dId: 'cc9' });
  assert.equal(autoConvertVerdict(m2, { liabilityIds: new Set(['cc9']) }).ok, false);
});

test('autoConvertVerdict refuses a pair where a leg has a real category', () => {
  const v = autoConvertVerdict(pair({ dCat: 'Income' }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /category/);
});

test('autoConvertVerdict refuses when an own-account id is missing', () => {
  const v = autoConvertVerdict(pair({ dId: null }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /own-account id/);
});

test('autoConvertVerdict refuses a leg belonging to a multi-split group', () => {
  const v = autoConvertVerdict(pair({ dTx: 'tSplit' }), { multiSplit: new Set(['tSplit']) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /multi-split/);
});

test('multiSplitTxIds flags only groups with more than one journal', () => {
  const items = [
    { tx_id: 'g1', journal_id: 'j1' },
    { tx_id: 'g1', journal_id: 'j2' }, // g1 is a 2-split group
    { tx_id: 'g2', journal_id: 'j3' }, // g2 is single-split
    { tx_id: 'g2', journal_id: 'j3' }, // same journal repeated (paging) does not count
  ];
  const multi = multiSplitTxIds(items);
  assert.equal(multi.has('g1'), true);
  assert.equal(multi.has('g2'), false);
});
