// Tests for the CSV backfill transform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseUsDate, parseAmount, transformRows } from '../lib/csv-backfill.js';

test('parseCsv handles headers, quoted fields, commas-in-quotes, escaped quotes', () => {
  const text =
    'Date,Description,Amount\n' +
    '07/16/2026,"MENARDS, BARBOURSVILLE (RETURN)",-146.27\n' +
    '07/01/2026,"GOOGLE ""WORKSPACE""",18.15\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Description, 'MENARDS, BARBOURSVILLE (RETURN)');
  assert.equal(rows[0].Amount, '-146.27');
  assert.equal(rows[1].Description, 'GOOGLE "WORKSPACE"');
});

test('parseCsv drops a blank trailing line', () => {
  const rows = parseCsv('Date,Amount\n1/1/26,5\n\n');
  assert.equal(rows.length, 1);
});

test('parseUsDate handles 2- and 4-digit years, validates the calendar', () => {
  assert.equal(parseUsDate('1/5/26'), '2026-01-05');
  assert.equal(parseUsDate('07/16/2026'), '2026-07-16');
  assert.equal(parseUsDate('12/31/2026'), '2026-12-31');
  assert.equal(parseUsDate('2/31/2026'), null); // not a real date
  assert.equal(parseUsDate('13/1/2026'), null); // bad month
  assert.equal(parseUsDate('2026-07-16'), null); // wrong shape
  assert.equal(parseUsDate(''), null);
});

test('parseAmount strips symbols and rejects junk', () => {
  assert.equal(parseAmount('-927.66'), -927.66);
  assert.equal(parseAmount('$1,499.90'), 1499.9);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('n/a'), null);
});

test('transformRows: Huntington/Amazon convention (negative = money out)', () => {
  const rows = [
    { Date: '1/12/26', Description: 'INTERNET TFR FRM CHECKING', Amount: '2000.0' },
    { Date: '1/21/26', Description: 'EXT Transfer', Amount: '-12000.0' },
  ];
  const { creates, counts } = transformRows(rows, { dateCol: 'Date', amountCol: 'Amount', descCol: 'Description', negate: false });
  const dep = creates.find((c) => c.description.includes('TFR FRM'));
  const wd = creates.find((c) => c.description === 'EXT Transfer');
  assert.equal(dep.type, 'deposit');
  assert.equal(dep.amount, '2000.00');
  assert.equal(wd.type, 'withdrawal');
  assert.equal(wd.amount, '12000.00');
  assert.equal(counts.deposits, 1);
  assert.equal(counts.withdrawals, 1);
});

test('transformRows: Apple/Discover convention (negate: positive = charge)', () => {
  const rows = [
    { d: '07/09/2026', desc: 'APPLE.COM/BILL', a: '3.17' }, // purchase, debt up
    { d: '07/08/2026', desc: 'ACH DEPOSIT PAYMENT', a: '-927.66' }, // payment, debt down
    { d: '06/30/2026', desc: 'INTEREST CHARGE', a: '85.39' }, // charge, debt up
  ];
  const { creates } = transformRows(rows, { dateCol: 'd', amountCol: 'a', descCol: 'desc', negate: true });
  const purchase = creates.find((c) => c.description === 'APPLE.COM/BILL');
  const payment = creates.find((c) => c.description === 'ACH DEPOSIT PAYMENT');
  const interest = creates.find((c) => c.description === 'INTEREST CHARGE');
  assert.equal(purchase.type, 'withdrawal'); // charge increases debt = money out of the card
  assert.equal(payment.type, 'deposit'); // payment reduces debt = money into the card
  assert.equal(interest.type, 'withdrawal');
  assert.equal(payment.amount, '927.66');
});

test('transformRows: endDate skips rows after the boundary, dates sorted', () => {
  const rows = [
    { Date: '7/15/26', Description: 'after', Amount: '-1' },
    { Date: '7/10/26', Description: 'before', Amount: '-2' },
    { Date: '7/13/26', Description: 'edge', Amount: '-3' },
  ];
  const { creates, counts } = transformRows(rows, { dateCol: 'Date', amountCol: 'Amount', descCol: 'Description', negate: false, endDate: '2026-07-13' });
  assert.equal(counts.skippedAfterEnd, 1);
  assert.deepEqual(creates.map((c) => c.description), ['before', 'edge']); // 7/15 dropped, sorted
  assert.deepEqual(counts.dateRange, ['2026-07-10', '2026-07-13']);
});

test('transformRows: flags unparseable and zero rows, never coerces', () => {
  const rows = [
    { Date: 'garbage', Description: 'x', Amount: '-5' },
    { Date: '1/1/26', Description: 'y', Amount: 'oops' },
    { Date: '1/2/26', Description: 'z', Amount: '0.00' },
    { Date: '1/3/26', Description: 'good', Amount: '-9.99' },
  ];
  const { creates, flags } = transformRows(rows, { dateCol: 'Date', amountCol: 'Amount', descCol: 'Description', negate: false });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].description, 'good');
  assert.equal(flags.length, 3);
  assert.ok(flags.some((f) => f.includes('unparseable date')));
  assert.ok(flags.some((f) => f.includes('unparseable amount')));
  assert.ok(flags.some((f) => f.includes('zero amount')));
});
