// fincore.db: the memory and outcomes store (SPEC 10.3). Single SQLite file,
// better-sqlite3 (synchronous), schema managed by user_version migrations so a
// pull-to-prod upgrade migrates on first open. Every consequential write goes
// through audit() (SPEC section 15).
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, '..', 'fincore.db');

// Each entry migrates the schema from its index to index+1. Append only; never
// edit a shipped migration. Baseline data is irreplaceable (SPEC section 11), so
// destructive migrations are not an option here.
const MIGRATIONS = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    target_amount REAL,
    target_date TEXT,
    piggy_bank_id TEXT,
    priority INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'abandoned')),
    notes TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE constraints (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    notes TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    decided_on TEXT NOT NULL,
    topic TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    source TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE recommendations (
    id INTEGER PRIMARY KEY,
    made_on TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    projected_value REAL,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed', 'confirmed', 'acted', 'declined', 'expired')),
    realized_value REAL,
    notes TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE nw_dti_series (
    id INTEGER PRIMARY KEY,
    snapshot_date TEXT NOT NULL UNIQUE,
    net_worth REAL,
    dti REAL,
    dti_basis TEXT,
    partial_basis INTEGER NOT NULL DEFAULT 0,
    flags_json TEXT,
    inputs_json TEXT,
    stale_feeds TEXT,
    is_baseline INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE value_created (
    id INTEGER PRIMARY KEY,
    logged_on TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('savings', 'interest_avoided', 'discipline')),
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    recommendation_id INTEGER REFERENCES recommendations(id),
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE paystubs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    pay_cadence TEXT NOT NULL CHECK (pay_cadence IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
    gross REAL NOT NULL,
    federal_tax REAL,
    state_tax REAL,
    local_tax REAL,
    fica_ss REAL,
    fica_medicare REAL,
    healthcare_premium REAL,
    retirement_contribution REAL,
    other_deductions TEXT,
    net_pay REAL,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE positions (
    id INTEGER PRIMARY KEY,
    as_of TEXT NOT NULL,
    symbol TEXT NOT NULL,
    quantity REAL,
    cost_basis REAL,
    market_value REAL,
    account TEXT,
    raw_json TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    before_json TEXT,
    after_json TEXT,
    reversal_handle TEXT,
    reversed_by INTEGER REFERENCES audit_log(id)
  );

  CREATE TABLE feed_freshness (
    feed TEXT PRIMARY KEY,
    last_seen TEXT,
    status TEXT,
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE credit_score (
    id INTEGER PRIMARY KEY,
    recorded_on TEXT NOT NULL UNIQUE,
    score INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE obligations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('debt_minimum', 'housing', 'other')),
    monthly_amount REAL NOT NULL,
    firefly_account_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE income_sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    treatment TEXT NOT NULL CHECK (treatment IN ('w2', 'self_employment')),
    cadence TEXT CHECK (cadence IN ('weekly', 'biweekly', 'semimonthly', 'monthly', 'irregular')),
    declared_monthly_gross REAL,
    withheld INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    updated TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE notification_queue (
    id INTEGER PRIMARY KEY,
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    delivered_at TEXT
  );
  `,
];

export function openStore(dbPath = process.env.FINCORE_DB_PATH || DEFAULT_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    const apply = db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    });
    apply();
  }
}

// --- meta (SYSTEM STATE only: baseline lock, run bookkeeping) ---
// User-editable configuration lives in the preferences table, never here, so the
// assistant can later be granted preference writes without touching lock state.

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// --- preferences (USER CONFIGURATION: tax rate, autonomy threshold, housing situation) ---

export function getPref(db, key) {
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key);
  return row ? row.value : null;
}

// Audited, atomic preference write with a uniform payload shape.
export function setPrefAudited(db, key, value, actor) {
  const before = getPref(db, key);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO preferences (key, value, updated) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = datetime('now')`
    ).run(key, String(value));
    audit(db, {
      actor,
      action: 'preferences.set',
      target: `preferences:${key}`,
      before: before === null ? null : { value: before },
      after: { value: String(value) },
      reversalHandle: reversalHandleFor('preferences', key, before === null ? null : { value: before }),
    });
  });
  tx();
}

// --- audit (SPEC section 15: every action, with before/after and a reversal handle) ---
// Reversal handle convention, consumed by Phase 13's `undo <action-id>`:
// a JSON string {"table": <table>, "key": <row identifier>, "before": <prior state|null>}.
// null handle means not reversible. `before: null` means the reversal is a delete
// or deactivation of what the action created.

export function reversalHandleFor(table, key, before) {
  return JSON.stringify({ table, key, before: before ?? null });
}

// Run a write and its audit entry atomically: either both land or neither does.
export function auditedWrite(db, auditEntry, writeFn) {
  const tx = db.transaction(() => {
    writeFn();
    audit(db, auditEntry);
  });
  tx();
}

export function audit(db, { actor, action, target = null, before = null, after = null, reversalHandle = null }) {
  const info = db
    .prepare(
      `INSERT INTO audit_log (actor, action, target, before_json, after_json, reversal_handle)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      actor,
      action,
      target,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reversalHandle
    );
  return info.lastInsertRowid;
}

// --- baseline lock (SPEC section 20) ---
// The baseline locks only on explicit confirmation. A 30-day correction window
// allows a later-found account to adjust it; after the window it is frozen.

export const BASELINE_CORRECTION_DAYS = 30;

export function baselineState(db, now = new Date()) {
  const lockedAt = getMeta(db, 'baseline_locked_at');
  if (!lockedAt) return { locked: false, correctable: false, lockedAt: null, windowEndsAt: null };
  const windowEndsAt = new Date(new Date(lockedAt).getTime() + BASELINE_CORRECTION_DAYS * 86400000);
  return {
    locked: true,
    correctable: now < windowEndsAt,
    lockedAt,
    windowEndsAt: windowEndsAt.toISOString(),
  };
}

export function lockBaseline(db, { snapshotDate, netWorth, dti, dtiBasis, inputs, actor }, now = new Date()) {
  const state = baselineState(db, now);
  if (state.locked) {
    throw new Error(`baseline already locked at ${state.lockedAt}; corrections go through correctBaseline`);
  }
  const tx = db.transaction(() => {
    upsertSeriesRow(db, {
      snapshotDate,
      netWorth,
      dti,
      dtiBasis,
      inputs,
      staleFeeds: null,
      isBaseline: 1,
    }, { allowBaselineWrite: true });
    setMeta(db, 'baseline_locked_at', now.toISOString());
    setMeta(db, 'baseline_snapshot_date', snapshotDate);
    audit(db, {
      actor,
      action: 'baseline.lock',
      target: `nw_dti_series:${snapshotDate}`,
      after: { snapshotDate, netWorth, dti, dtiBasis },
    });
  });
  tx();
}

// Correct the locked baseline inside the window (e.g. a later-found account).
// Refuses after the window: a frozen baseline is what makes the ROI claim honest.
export function correctBaseline(db, { netWorth, dti, dtiBasis, inputs, reason, actor }, now = new Date()) {
  const state = baselineState(db, now);
  if (!state.locked) throw new Error('no baseline locked; use lockBaseline');
  if (!state.correctable) {
    throw new Error(`baseline correction window closed at ${state.windowEndsAt}; the baseline is frozen`);
  }
  const snapshotDate = getMeta(db, 'baseline_snapshot_date');
  const before = db
    .prepare('SELECT net_worth, dti, dti_basis FROM nw_dti_series WHERE snapshot_date = ?')
    .get(snapshotDate);
  const tx = db.transaction(() => {
    upsertSeriesRow(
      db,
      { snapshotDate, netWorth, dti, dtiBasis, inputs, staleFeeds: null, isBaseline: 1 },
      { allowBaselineWrite: true }
    );
    audit(db, {
      actor,
      action: 'baseline.correct',
      target: `nw_dti_series:${snapshotDate}`,
      before,
      after: { netWorth, dti, dtiBasis, reason },
    });
  });
  tx();
}

// --- series ---

// Upsert one series row. The locked baseline row is WRITE-PROTECTED here, at the
// lowest write path: once locked, only lockBaseline/correctBaseline (which pass
// allowBaselineWrite and carry their own window checks and audit actions) may touch
// its values. A plain snapshot on the baseline's date is a silent no-op that reports
// {skippedBaseline: true}; anything else would let a same-day snapshot rewrite the
// "before" the whole system is judged against.
export function upsertSeriesRow(
  db,
  { snapshotDate, netWorth, dti, dtiBasis, partialBasis = 0, flags, inputs, staleFeeds, isBaseline = 0 },
  { allowBaselineWrite = false } = {}
) {
  if (!allowBaselineWrite) {
    const existing = db
      .prepare('SELECT is_baseline FROM nw_dti_series WHERE snapshot_date = ?')
      .get(snapshotDate);
    if (existing?.is_baseline === 1) return { skippedBaseline: true };
  }
  db.prepare(
    `INSERT INTO nw_dti_series (snapshot_date, net_worth, dti, dti_basis, partial_basis, flags_json, inputs_json, stale_feeds, is_baseline)
     VALUES (@snapshotDate, @netWorth, @dti, @dtiBasis, @partialBasis, @flags, @inputs, @staleFeeds, @isBaseline)
     ON CONFLICT(snapshot_date) DO UPDATE SET
       net_worth = excluded.net_worth,
       dti = excluded.dti,
       dti_basis = excluded.dti_basis,
       partial_basis = excluded.partial_basis,
       flags_json = excluded.flags_json,
       inputs_json = excluded.inputs_json,
       stale_feeds = excluded.stale_feeds,
       is_baseline = MAX(nw_dti_series.is_baseline, excluded.is_baseline)`
  ).run({
    snapshotDate,
    netWorth,
    dti,
    dtiBasis: dtiBasis ?? null,
    partialBasis: partialBasis ? 1 : 0,
    flags: flags && flags.length ? JSON.stringify(flags) : null,
    inputs: inputs === undefined || inputs === null ? null : JSON.stringify(inputs),
    staleFeeds: staleFeeds ?? null,
    isBaseline,
  });
  return { skippedBaseline: false };
}

// The in-effect paystub template for a source (latest by effective date). Shared by
// onboarding and the outcomes engine so both always agree on which template applies.
export function latestPaystub(db, source) {
  return (
    db
      .prepare(
        `SELECT * FROM paystubs WHERE source = ? ORDER BY effective_from DESC, id DESC LIMIT 1`
      )
      .get(source) || null
  );
}

export function touchFeed(db, feed, { status = 'ok' } = {}) {
  db.prepare(
    `INSERT INTO feed_freshness (feed, last_seen, status, updated)
     VALUES (?, datetime('now'), ?, datetime('now'))
     ON CONFLICT(feed) DO UPDATE SET last_seen = datetime('now'), status = excluded.status, updated = datetime('now')`
  ).run(feed, status);
}
