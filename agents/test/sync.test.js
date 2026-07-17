// Money-grade tests for the SimpleFIN to Firefly transform. Uses the real nyDateStr
// from ../lib/firefly.js so the NY-timezone date conversion is exercised end to end,
// not against a stub that could hide a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformTransactions, epochWindow } from '../lib/sync.js';
import { nyDateStr } from '../lib/firefly.js';

// posted epoch for 2026-07-15T02:00:00Z, which is 2026-07-14 22:00 in New_York (EDT).
const POSTED_2026_07_14_NY = Math.floor(Date.parse('2026-07-15T02:00:00Z') / 1000);

function mapOf(entries) {
  return new Map(entries);
}

function oneMappedAccount(transactions) {
  return [
    {
      id: 'ACT-1',
      name: 'Checking',
      org: { name: 'Bank' },
      currency: 'USD',
      transactions,
    },
  ];
}

const MAP = mapOf([['ACT-1', { fireflyAccountId: '10', fireflyAccountName: 'Everyday Checking' }]]);

test('negative amount maps to a withdrawal off the mapped account', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-1', posted: POSTED_2026_07_14_NY, amount: '-12.34', payee: 'Grocer' },
  ]);
  const { creates } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(creates.length, 1);
  const c = creates[0];
  assert.equal(c.type, 'withdrawal');
  assert.equal(c.sourceId, '10');
  assert.equal(c.destinationName, 'Grocer');
  assert.equal(c.destinationId, undefined);
  assert.equal(c.sourceName, undefined);
  assert.equal(c.amount, '12.34');
  assert.equal(c.externalId, 'TRN-1');
  assert.equal(c.txnId, 'TRN-1');
  assert.equal(c.accountName, 'Everyday Checking');
  assert.deepEqual(c.tags, ['simplefin-sync']);
});

test('positive amount maps to a deposit into the mapped account', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-2', posted: POSTED_2026_07_14_NY, amount: '2500.00', payee: 'Employer' },
  ]);
  const { creates } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(creates.length, 1);
  const c = creates[0];
  assert.equal(c.type, 'deposit');
  assert.equal(c.destinationId, '10');
  assert.equal(c.sourceName, 'Employer');
  assert.equal(c.sourceId, undefined);
  assert.equal(c.destinationName, undefined);
  assert.equal(c.amount, '2500.00');
});

test('string amount rounds through cents and emits a 2-decimal string', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-A', posted: POSTED_2026_07_14_NY, amount: '12.340000000000', payee: 'A' },
    { id: 'TRN-B', posted: POSTED_2026_07_14_NY, amount: '-4.999999999', payee: 'B' },
  ]);
  const { creates } = transformTransactions(accounts, MAP, { nyDateStr });
  const a = creates.find((c) => c.txnId === 'TRN-A');
  const b = creates.find((c) => c.txnId === 'TRN-B');
  assert.equal(a.amount, '12.34');
  assert.equal(a.type, 'deposit');
  assert.equal(b.amount, '5.00');
  assert.equal(b.type, 'withdrawal');
});

test('counterparty prefers payee, then description, then Unknown', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-P', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: '  Payee Co  ', description: 'desc' },
    { id: 'TRN-D', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: '   ', description: '  Fallback Desc  ' },
    { id: 'TRN-U', posted: POSTED_2026_07_14_NY, amount: '-1.00' },
  ]);
  const { creates } = transformTransactions(accounts, MAP, { nyDateStr });
  const p = creates.find((c) => c.txnId === 'TRN-P');
  const d = creates.find((c) => c.txnId === 'TRN-D');
  const u = creates.find((c) => c.txnId === 'TRN-U');
  assert.equal(p.destinationName, 'Payee Co');
  assert.equal(d.destinationName, 'Fallback Desc');
  assert.equal(u.destinationName, 'Unknown');
  // description falls back to counterparty when its own field is empty.
  assert.equal(u.description, 'Unknown');
  assert.equal(d.description, 'Fallback Desc');
});

test('date is the NY calendar day for the posted epoch (crosses UTC midnight)', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-NY', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'X' },
  ]);
  const { creates } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(creates[0].date, '2026-07-14');
});

test('seen ids are skipped and counted', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-SEEN', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'X' },
    { id: 'TRN-NEW', posted: POSTED_2026_07_14_NY, amount: '-2.00', payee: 'Y' },
  ]);
  const seenIds = new Set(['TRN-SEEN']);
  const { creates, skippedSeen } = transformTransactions(accounts, MAP, { seenIds, nyDateStr });
  assert.equal(skippedSeen, 1);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].txnId, 'TRN-NEW');
});

test('pending transactions are skipped and counted', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-PEND', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'X', pending: true },
    { id: 'TRN-POST', posted: POSTED_2026_07_14_NY, amount: '-2.00', payee: 'Y', pending: false },
  ]);
  const { creates, skippedPending } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(skippedPending, 1);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].txnId, 'TRN-POST');
});

test('unmapped account transactions are counted, not flagged', () => {
  const accounts = [
    {
      id: 'ACT-UNMAPPED',
      name: 'Other',
      transactions: [
        { id: 'TRN-U1', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'X' },
        { id: 'TRN-U2', posted: POSTED_2026_07_14_NY, amount: '-2.00', payee: 'Y' },
      ],
    },
    ...oneMappedAccount([
      { id: 'TRN-M1', posted: POSTED_2026_07_14_NY, amount: '-3.00', payee: 'Z' },
    ]),
  ];
  const { creates, flags, skippedUnmapped } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(skippedUnmapped, 2);
  assert.equal(flags.length, 0);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].txnId, 'TRN-M1');
});

test('missing id is flagged and skipped', () => {
  const accounts = oneMappedAccount([
    { posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'X' },
    { id: '   ', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'Y' },
    { id: 'TRN-OK', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'Z' },
  ]);
  const { creates, flags } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(flags.length, 2);
  assert.ok(flags.every((f) => /no id/.test(f)));
  assert.ok(flags.every((f) => /Everyday Checking/.test(f)));
  assert.equal(creates.length, 1);
  assert.equal(creates[0].txnId, 'TRN-OK');
});

test('zero amount is flagged and skipped', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-ZERO', posted: POSTED_2026_07_14_NY, amount: '0.00', payee: 'X' },
    { id: 'TRN-ZERO2', posted: POSTED_2026_07_14_NY, amount: '-0.0000001', payee: 'Y' },
  ]);
  const { creates, flags } = transformTransactions(accounts, MAP, { nyDateStr });
  // Both round to zero cents and are rejected as unusable.
  assert.equal(creates.length, 0);
  assert.equal(flags.length, 2);
  assert.ok(flags.every((f) => /TRN-ZERO/.test(f)));
});

test('unparseable amount is flagged and skipped', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-BAD', posted: POSTED_2026_07_14_NY, amount: 'not-a-number', payee: 'X' },
    { id: 'TRN-EMPTY', posted: POSTED_2026_07_14_NY, amount: '', payee: 'Y' },
  ]);
  const { creates, flags } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(creates.length, 0);
  assert.equal(flags.length, 2);
  assert.ok(flags.some((f) => /TRN-BAD/.test(f)));
  assert.ok(flags.some((f) => /TRN-EMPTY/.test(f)));
});

test('missing or invalid posted is flagged and skipped', () => {
  const accounts = oneMappedAccount([
    { id: 'TRN-NOPOST', amount: '-1.00', payee: 'X' },
    { id: 'TRN-STRPOST', posted: '1700000000', amount: '-1.00', payee: 'Y' },
    { id: 'TRN-NEGPOST', posted: -5, amount: '-1.00', payee: 'Z' },
  ]);
  const { creates, flags } = transformTransactions(accounts, MAP, { nyDateStr });
  assert.equal(creates.length, 0);
  assert.equal(flags.length, 3);
  assert.ok(flags.every((f) => /posted/.test(f)));
});

test('output order is deterministic under input shuffling', () => {
  const base = [
    { id: 'TRN-c', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'c' },
    { id: 'TRN-a', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'a' },
    { id: 'TRN-b', posted: Math.floor(Date.parse('2026-07-10T12:00:00Z') / 1000), amount: '-1.00', payee: 'b' },
    { id: 'TRN-d', posted: POSTED_2026_07_14_NY, amount: '-1.00', payee: 'd' },
  ];
  const order1 = transformTransactions(oneMappedAccount(base), MAP, { nyDateStr }).creates.map((c) => c.txnId);
  const shuffled = [base[3], base[0], base[2], base[1]];
  const order2 = transformTransactions(oneMappedAccount(shuffled), MAP, { nyDateStr }).creates.map((c) => c.txnId);
  assert.deepEqual(order1, order2);
  // Earlier date sorts first, then ids lexically within the same date.
  assert.deepEqual(order1, ['TRN-b', 'TRN-a', 'TRN-c', 'TRN-d']);
});

test('missing nyDateStr throws RangeError', () => {
  assert.throws(() => transformTransactions(oneMappedAccount([]), MAP, {}), RangeError);
  assert.throws(() => transformTransactions(oneMappedAccount([]), MAP, { nyDateStr: 'nope' }), RangeError);
});

test('empty and missing inputs are handled without throwing', () => {
  const r1 = transformTransactions(undefined, MAP, { nyDateStr });
  assert.deepEqual(r1, { creates: [], flags: [], skippedSeen: 0, skippedPending: 0, skippedUnmapped: 0 });
  const r2 = transformTransactions([], undefined, { nyDateStr });
  assert.deepEqual(r2.creates, []);
});

test('epochWindow computes end floored to seconds and start lookbackDays earlier', () => {
  const now = new Date('2026-07-17T12:00:00.750Z');
  const { startEpoch, endEpoch } = epochWindow({ now, lookbackDays: 90 });
  const expectedEnd = Math.floor(now.getTime() / 1000);
  assert.equal(endEpoch, expectedEnd);
  assert.equal(startEpoch, expectedEnd - 90 * 86400);
});

test('epochWindow validation throws on bad now and out-of-range lookbackDays', () => {
  assert.throws(() => epochWindow({ now: 'nope', lookbackDays: 30 }), RangeError);
  assert.throws(() => epochWindow({ now: new Date('invalid'), lookbackDays: 30 }), RangeError);
  assert.throws(() => epochWindow({ now: new Date(), lookbackDays: 0 }), RangeError);
  assert.throws(() => epochWindow({ now: new Date(), lookbackDays: -1 }), RangeError);
  assert.throws(() => epochWindow({ now: new Date(), lookbackDays: 401 }), RangeError);
  assert.throws(() => epochWindow({ now: new Date(), lookbackDays: Infinity }), RangeError);
  assert.throws(() => epochWindow({ now: new Date(), lookbackDays: NaN }), RangeError);
  // Boundary: 400 is allowed.
  assert.doesNotThrow(() => epochWindow({ now: new Date(), lookbackDays: 400 }));
});
