import test from 'node:test';
import assert from 'node:assert/strict';
import { isWindfallCandidate } from '../lib/quality.js';

const OPTS = {
  liabilityIds: new Set(['15', '14', '7']),
  minAmount: 1000,
  startDate: '2026-07-18',
  seenJournalIds: new Set(['seen-1']),
};

function deposit(over = {}) {
  return {
    type: 'deposit',
    accountId: '1', // Huntington Checking (asset)
    amount: '9742.04',
    date: '2026-07-20',
    tags: [],
    category: '',
    journal_id: 'j-1',
    ...over,
  };
}

test('a large untagged deposit to an asset account is a windfall candidate', () => {
  assert.equal(isWindfallCandidate(deposit(), OPTS), true);
});

test('a payment credit to a liability account is never a windfall', () => {
  // The 2026-07-25 false positive: $6,500 Discover payment credit imported as a
  // deposit to the card before the checking-side withdrawal arrived.
  const t = deposit({ accountId: '15', amount: '6500.00', description: 'INTERNET PAYMENT - THANK YOU' });
  assert.equal(isWindfallCandidate(t, OPTS), false);
});

test('Redshirt-tagged deposits are influxes, not windfalls', () => {
  const t = deposit({ tags: ['income-source:redshirt-cloud'] });
  assert.equal(isWindfallCandidate(t, OPTS), false);
});

test('Transfer and Refunds categories are excluded', () => {
  assert.equal(isWindfallCandidate(deposit({ category: 'Transfer' }), OPTS), false);
  assert.equal(isWindfallCandidate(deposit({ category: 'Refunds' }), OPTS), false);
});

test('below the minimum, before plan start, already seen, or non-deposit is excluded', () => {
  assert.equal(isWindfallCandidate(deposit({ amount: '999.99' }), OPTS), false);
  assert.equal(isWindfallCandidate(deposit({ date: '2026-07-17' }), OPTS), false);
  assert.equal(isWindfallCandidate(deposit({ journal_id: 'seen-1' }), OPTS), false);
  assert.equal(isWindfallCandidate(deposit({ type: 'withdrawal' }), OPTS), false);
});

test('boundary cases count: exactly the minimum and exactly the start date qualify', () => {
  assert.equal(isWindfallCandidate(deposit({ amount: '1000.00', date: '2026-07-18' }), OPTS), true);
});

test('unparseable amounts are excluded', () => {
  assert.equal(isWindfallCandidate(deposit({ amount: 'not-a-number' }), OPTS), false);
});
