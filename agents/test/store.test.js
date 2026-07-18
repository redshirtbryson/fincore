// Tests for the fincore.db store: schema, audit, baseline lock invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openStore,
  getMeta,
  setMeta,
  getPref,
  setPrefAudited,
  audit,
  auditedWrite,
  reversalHandleFor,
  baselineState,
  lockBaseline,
  correctBaseline,
  upsertSeriesRow,
  latestPaystub,
  touchFeed,
  BASELINE_CORRECTION_DAYS,
} from '../lib/store.js';

function memStore() {
  return openStore(':memory:');
}

test('schema creates every SPEC 10.3 table', () => {
  const db = memStore();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const t of [
    'meta', 'goals', 'constraints', 'decisions', 'recommendations', 'preferences',
    'nw_dti_series', 'value_created', 'paystubs', 'positions', 'audit_log',
    'feed_freshness', 'credit_score', 'obligations', 'income_sources', 'notification_queue',
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal(db.pragma('user_version', { simple: true }), 6);
});

test('meta get/set round-trips and upserts', () => {
  const db = memStore();
  assert.equal(getMeta(db, 'nope'), null);
  setMeta(db, 'k', 'v1');
  setMeta(db, 'k', 'v2');
  assert.equal(getMeta(db, 'k'), 'v2');
});

test('audit rows capture before/after and return an id', () => {
  const db = memStore();
  const id = audit(db, {
    actor: 'test',
    action: 'thing.change',
    target: 'thing:1',
    before: { a: 1 },
    after: { a: 2 },
    reversalHandle: 'thing:1:a=1',
  });
  const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  assert.equal(row.actor, 'test');
  assert.deepEqual(JSON.parse(row.before_json), { a: 1 });
  assert.deepEqual(JSON.parse(row.after_json), { a: 2 });
  assert.equal(row.reversal_handle, 'thing:1:a=1');
});

test('baseline lock: once only, corrections inside the window, frozen after', () => {
  const db = memStore();
  const t0 = new Date('2026-07-12T12:00:00Z');

  assert.equal(baselineState(db, t0).locked, false);

  lockBaseline(db, {
    snapshotDate: '2026-07-12',
    netWorth: 10000,
    dti: 0.35,
    dtiBasis: 'test',
    inputs: { x: 1 },
    actor: 'test',
  }, t0);

  const st = baselineState(db, t0);
  assert.equal(st.locked, true);
  assert.equal(st.correctable, true);

  // Cannot lock twice.
  assert.throws(() => lockBaseline(db, { snapshotDate: '2026-07-13', netWorth: 1, dti: 0.1, actor: 'test' }, t0), /already locked/);

  // Correction inside the window rewrites the SAME baseline row and audits it.
  const t10 = new Date(t0.getTime() + 10 * 86400000);
  correctBaseline(db, { netWorth: 9500, dti: 0.36, dtiBasis: 'found account', reason: 'late account', actor: 'test' }, t10);
  const row = db.prepare("SELECT * FROM nw_dti_series WHERE is_baseline = 1").get();
  assert.equal(row.snapshot_date, '2026-07-12');
  assert.equal(row.net_worth, 9500);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'baseline.correct'").get().c === 1);

  // Frozen after the window.
  const tLate = new Date(t0.getTime() + (BASELINE_CORRECTION_DAYS + 1) * 86400000);
  assert.equal(baselineState(db, tLate).correctable, false);
  assert.throws(() => correctBaseline(db, { netWorth: 1, dti: 0.1, reason: 'x', actor: 'test' }, tLate), /frozen/);
});

test('the locked baseline row is write-protected against plain snapshots', () => {
  const db = memStore();
  lockBaseline(db, { snapshotDate: '2026-07-12', netWorth: 100, dti: 0.4, dtiBasis: 'b', actor: 'test' });

  // A same-day snapshot must NOT rewrite the frozen "before".
  const result = upsertSeriesRow(db, { snapshotDate: '2026-07-12', netWorth: 120, dti: 0.39 });
  assert.equal(result.skippedBaseline, true);
  const row = db.prepare("SELECT * FROM nw_dti_series WHERE snapshot_date = '2026-07-12'").get();
  assert.equal(row.net_worth, 100);
  assert.equal(row.is_baseline, 1);

  // Only the baseline functions may write it (they pass allowBaselineWrite).
  correctBaseline(db, { netWorth: 95, dti: 0.41, dtiBasis: 'c', reason: 'late account', actor: 'test' });
  assert.equal(db.prepare("SELECT net_worth FROM nw_dti_series WHERE snapshot_date = '2026-07-12'").get().net_worth, 95);

  // Ordinary rows still upsert normally.
  upsertSeriesRow(db, { snapshotDate: '2026-07-13', netWorth: 110, dti: 0.4 });
  const r2 = upsertSeriesRow(db, { snapshotDate: '2026-07-13', netWorth: 111, dti: 0.4 });
  assert.equal(r2.skippedBaseline, false);
  assert.equal(db.prepare("SELECT net_worth FROM nw_dti_series WHERE snapshot_date = '2026-07-13'").get().net_worth, 111);
});

test('series rows persist machine-readable partial and flags columns', () => {
  const db = memStore();
  upsertSeriesRow(db, {
    snapshotDate: '2026-07-13',
    netWorth: 100,
    dti: 0.4,
    partialBasis: 1,
    flags: ['income source "X" has no usable figure'],
  });
  const row = db.prepare("SELECT * FROM nw_dti_series WHERE snapshot_date = '2026-07-13'").get();
  assert.equal(row.partial_basis, 1);
  assert.deepEqual(JSON.parse(row.flags_json), ['income source "X" has no usable figure']);
});

test('preferences are separate from meta and audited with reversal handles', () => {
  const db = memStore();
  setPrefAudited(db, 'tax_setaside_rate', 25, 'test');
  setPrefAudited(db, 'tax_setaside_rate', 28, 'test');
  assert.equal(getPref(db, 'tax_setaside_rate'), '28');
  assert.equal(getMeta(db, 'tax_setaside_rate'), null); // never bleeds into meta

  const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'preferences.set' ORDER BY id").all();
  assert.equal(rows.length, 2);
  const handle = JSON.parse(rows[1].reversal_handle);
  assert.equal(handle.table, 'preferences');
  assert.deepEqual(handle.before, { value: '25' });
});

test('auditedWrite is atomic: a failed write leaves no audit row', () => {
  const db = memStore();
  assert.throws(() =>
    auditedWrite(
      db,
      { actor: 'test', action: 'x.y', target: 'x:1', after: { a: 1 } },
      () => {
        db.prepare("INSERT INTO constraints (name, value) VALUES ('k', 'v')").run();
        throw new Error('boom');
      }
    )
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM constraints').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM audit_log').get().c, 0);
});

test('latestPaystub returns the in-effect template by effective date', () => {
  const db = memStore();
  const ins = db.prepare(
    "INSERT INTO paystubs (source, effective_from, pay_cadence, gross) VALUES ('Blenko', ?, 'biweekly', ?)"
  );
  ins.run('2026-01-01', 2000);
  ins.run('2026-06-01', 2200);
  assert.equal(latestPaystub(db, 'Blenko').gross, 2200);
  assert.equal(latestPaystub(db, 'Nope'), null);
});

test('reversalHandleFor emits the documented undo contract', () => {
  const h = JSON.parse(reversalHandleFor('obligations', 'Rent', { monthly_amount: 900 }));
  assert.deepEqual(h, { table: 'obligations', key: 'Rent', before: { monthly_amount: 900 } });
  assert.deepEqual(JSON.parse(reversalHandleFor('goals', 'g', null)).before, null);
});

test('feed freshness upserts', () => {
  const db = memStore();
  touchFeed(db, 'firefly');
  touchFeed(db, 'firefly', { status: 'ok' });
  const rows = db.prepare('SELECT * FROM feed_freshness').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feed, 'firefly');
  assert.ok(rows[0].last_seen);
});

test('schema constraints reject junk where it matters', () => {
  const db = memStore();
  // value_created.kind is constrained.
  assert.throws(() =>
    db.prepare("INSERT INTO value_created (logged_on, kind, amount, description) VALUES ('2026-07-12', 'vibes', 10, 'x')").run()
  );
  // paystubs.pay_cadence is constrained (the cadence decision is enforced at the schema).
  assert.throws(() =>
    db.prepare("INSERT INTO paystubs (source, effective_from, pay_cadence, gross) VALUES ('Blenko', '2026-07-12', 'fortnightly', 100)").run()
  );
  // obligations.kind is constrained.
  assert.throws(() =>
    db.prepare("INSERT INTO obligations (name, kind, monthly_amount) VALUES ('x', 'misc', 10)").run()
  );
});
