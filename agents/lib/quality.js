// Phase 4 quality passes (SPEC section 11): I/O orchestration around the pure
// matching, freshness, and reconciliation engines. Each pass is independently
// try/caught (skip-and-report); math lives in the engines.
import * as firefly from './firefly.js';
import { matchTransfers, matchReimbursements, parseAmount } from './matching.js';
import { assessFreshness, staleSummaryLine } from './freshness.js';
import { reconcileNetWorth, reconcilePaystubDeposits } from './reconcile.js';
import { audit, reversalHandleFor, latestPaystub, recordFeedStatus, getPref, getMeta, upsertValuation } from './store.js';
import { fetchBalances, normalizeValuation, matchesValuationRule, parseMatchRules, overlapsFireflyAccount } from './simplefin.js';

const MATCH_LOOKBACK_DAYS = Number(process.env.MATCH_LOOKBACK_DAYS) > 0 ? Number(process.env.MATCH_LOOKBACK_DAYS) : 90;
const MATCH_WRITE_CAP = Number(process.env.MATCH_WRITE_CAP) > 0 ? Number(process.env.MATCH_WRITE_CAP) : 20;
const FRESHNESS_THRESHOLD_DAYS = Number(process.env.FRESHNESS_THRESHOLD_DAYS) > 0 ? Number(process.env.FRESHNESS_THRESHOLD_DAYS) : 7;

// Autonomy tier boundary (SPEC section 15): autonomous writes only below the
// dollar threshold Bryson set in onboarding. Recategorizing a material
// transaction is Confirm-tier, so pairs above the threshold are queued, not written.
const DEFAULT_AUTONOMY_THRESHOLD = 50;

function autonomyThreshold(db) {
  const v = Number(getPref(db, 'autonomy_dollar_threshold'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_AUTONOMY_THRESHOLD;
}

// Queue a durable item for the (future) confirmation flow. Deduped on the exact
// undelivered message so daily reruns do not stack copies; Phase 8's digest and
// confirm loop consume this table.
function queueNotification(db, severity, message) {
  const exists = db
    .prepare('SELECT 1 FROM notification_queue WHERE message = ? AND delivered_at IS NULL')
    .get(message);
  if (!exists) {
    db.prepare('INSERT INTO notification_queue (severity, message) VALUES (?, ?)').run(severity, message);
  }
}

function pairLabel(w, d) {
  return `${w.date} ${w.account} -> ${d.account} $${w.amount} (tx ${w.tx_id}/${d.tx_id})`;
}

// Complete half-written pairs from a prior crashed run. A transfer-match tag names
// both journal ids; a row wearing the tag whose counterpart lacks it means the
// second write never landed. The counterpart is found in the fetched window (both
// legs sit within days of each other); anything outside it is flagged.
async function repairHalfMatches(db, txns, flags) {
  const byJournal = new Map(txns.map((t) => [t.journal_id, t]));
  const tagOwners = new Map(); // tag -> rows wearing it
  for (const t of txns) {
    for (const tag of t.tags) {
      if (tag.startsWith('transfer-match:')) {
        if (!tagOwners.has(tag)) tagOwners.set(tag, []);
        tagOwners.get(tag).push(t);
      }
    }
  }
  let repaired = 0;
  for (const [tag, owners] of tagOwners) {
    if (owners.length !== 1) continue;
    const ids = tag.slice('transfer-match:'.length).split('-');
    const missingId = ids.find((id) => id !== owners[0].journal_id);
    const counterpart = missingId ? byJournal.get(missingId) : null;
    if (!counterpart) {
      flags.push(`half-matched pair ${tag}: counterpart journal ${missingId ?? '?'} not in window; needs manual review`);
      continue;
    }
    await firefly.setCategory(counterpart.tx_id, counterpart.journal_id, 'Transfer', {
      addTags: [tag],
      knownTags: counterpart.tags,
    });
    audit(db, {
      actor: 'matcher',
      action: 'transfer.match.repair',
      target: `firefly:tx:${counterpart.tx_id}:${counterpart.journal_id}`,
      before: { category: counterpart.category || null },
      after: { category: 'Transfer', tag },
      reversalHandle: reversalHandleFor('firefly_transfer_match', tag, { category: counterpart.category || null }),
    });
    counterpart.tags = [...counterpart.tags, tag]; // keep the in-memory pool consistent
    repaired += 1;
  }
  return repaired;
}

// Transfer and reimbursement matching. Conservative by design:
// - only pairs unique on both sides auto-match (the engine's rule);
// - a truncated fetch disables ALL auto-writes, because uniqueness cannot be
//   trusted over an incomplete candidate set;
// - pairs above the autonomy dollar threshold are queued for confirmation, never
//   written autonomously (SPEC 15 Confirm tier);
// - a side already carrying a category other than Transfer is never overwritten;
// - the deposit is written before the withdrawal, so a crash between the two
//   overstates expense rather than income, and the repair pass completes it next run.
export async function runMatchingPass(db, { fetched = null } = {}) {
  const { items: txns, truncated } = fetched ?? (await firefly.getRecentTransactions({ lookbackDays: MATCH_LOOKBACK_DAYS }));
  const withdrawals = txns.filter((t) => t.type === 'withdrawal');
  const deposits = txns.filter((t) => t.type === 'deposit');
  const flags = [];
  const threshold = autonomyThreshold(db);

  if (truncated) {
    return {
      transfersWritten: 0,
      reimbursementsWritten: 0,
      ambiguous: 0,
      conflicts: 0,
      flags,
      line: `Matching skipped: transaction window truncated at the fetch cap; uniqueness cannot be trusted. Raise the cap or shrink MATCH_LOOKBACK_DAYS.`,
      deposits,
    };
  }

  const repaired = await repairHalfMatches(db, txns, flags);

  let written = 0;
  let transfersWritten = 0;
  let reimbursementsWritten = 0;
  let conflicts = 0;
  let queuedForConfirm = 0;
  const claimed = new Set(); // journal ids claimed by any match this run

  // Transfers.
  const tRes = matchTransfers(withdrawals, deposits);
  flags.push(...tRes.flags);
  for (const m of tRes.matches) {
    if (written >= MATCH_WRITE_CAP) {
      flags.push(`match write cap (${MATCH_WRITE_CAP}) reached; remaining pairs process tomorrow`);
      break;
    }
    const conflicted = [m.withdrawal, m.deposit].some((s) => s.category && s.category !== 'Transfer');
    if (conflicted) {
      conflicts += 1;
      continue;
    }
    const amount = parseAmount(m.withdrawal.amount);
    if (amount === null || amount > threshold) {
      queueNotification(db, 'confirm', `Confirm transfer pair: ${pairLabel(m.withdrawal, m.deposit)}`);
      queuedForConfirm += 1;
      continue;
    }
    const tag = `transfer-match:${m.withdrawal.journal_id}-${m.deposit.journal_id}`;
    try {
      // Deposit first: if the second write fails, expense is overstated rather
      // than income, the conservative direction, and repair completes it next run.
      await firefly.setCategory(m.deposit.tx_id, m.deposit.journal_id, 'Transfer', {
        addTags: [tag],
        knownTags: m.deposit.tags,
      });
      await firefly.setCategory(m.withdrawal.tx_id, m.withdrawal.journal_id, 'Transfer', {
        addTags: [tag],
        knownTags: m.withdrawal.tags,
      });
      audit(db, {
        actor: 'matcher',
        action: 'transfer.match',
        target: `firefly:tx:${m.withdrawal.tx_id}:${m.withdrawal.journal_id}+${m.deposit.tx_id}:${m.deposit.journal_id}`,
        before: { withdrawalCategory: m.withdrawal.category || null, depositCategory: m.deposit.category || null },
        after: { category: 'Transfer', tag, dateDelta: m.dateDelta },
        reversalHandle: reversalHandleFor('firefly_transfer_match', tag, {
          withdrawalCategory: m.withdrawal.category || null,
          depositCategory: m.deposit.category || null,
        }),
      });
      claimed.add(m.withdrawal.journal_id);
      claimed.add(m.deposit.journal_id);
      written += 1;
      transfersWritten += 1;
    } catch (e) {
      flags.push(`transfer pair ${pairLabel(m.withdrawal, m.deposit)} failed mid-write: ${e.message}; repair pass will complete it tomorrow`);
    }
  }

  // Reimbursements. The deposit pool excludes anything that is, or just became, a
  // transfer leg: one deposit must never be claimed by both passes.
  const reimbursable = withdrawals.filter((t) => t.tags.includes('reimbursable') && !claimed.has(t.journal_id));
  const openDeposits = deposits.filter(
    (d) =>
      !claimed.has(d.journal_id) &&
      !d.tags.some((t) => t.startsWith('reimbursement-match:') || t.startsWith('transfer-match:'))
  );
  const rRes = matchReimbursements(reimbursable, openDeposits);
  flags.push(...rRes.flags);
  for (const m of rRes.matches) {
    if (written >= MATCH_WRITE_CAP) break;
    const amount = parseAmount(m.withdrawal.amount);
    if (amount === null || amount > threshold) {
      queueNotification(db, 'confirm', `Confirm reimbursement pair: ${pairLabel(m.withdrawal, m.deposit)}`);
      queuedForConfirm += 1;
      continue;
    }
    const tag = `reimbursement-match:${m.withdrawal.journal_id}`;
    try {
      await firefly.setCategory(m.deposit.tx_id, m.deposit.journal_id, undefined, {
        addTags: [tag],
        knownTags: m.deposit.tags,
      });
      await firefly.setCategory(m.withdrawal.tx_id, m.withdrawal.journal_id, undefined, {
        addTags: ['reimbursed'],
        knownTags: m.withdrawal.tags,
      });
      audit(db, {
        actor: 'matcher',
        action: 'reimbursement.match',
        target: `firefly:tx:${m.withdrawal.tx_id}:${m.withdrawal.journal_id}+${m.deposit.tx_id}:${m.deposit.journal_id}`,
        before: { withdrawalTags: m.withdrawal.tags, depositTags: m.deposit.tags },
        after: { tag, dateDelta: m.dateDelta },
        reversalHandle: reversalHandleFor('firefly_reimbursement_match', tag, {
          withdrawalTags: m.withdrawal.tags,
          depositTags: m.deposit.tags,
        }),
      });
      claimed.add(m.withdrawal.journal_id);
      claimed.add(m.deposit.journal_id);
      written += 1;
      reimbursementsWritten += 1;
    } catch (e) {
      flags.push(`reimbursement pair ${pairLabel(m.withdrawal, m.deposit)} failed mid-write: ${e.message}`);
    }
  }

  // Ambiguous pairs are queued durably; the count alone is not actionable.
  for (const a of [...tRes.ambiguous, ...rRes.ambiguous]) {
    queueNotification(
      db,
      'confirm',
      `Ambiguous match for tx ${a.item.tx_id} (${a.item.date}, $${a.item.amount}): ${a.candidates.length} candidates. ${a.reason}`
    );
  }
  const ambiguous = tRes.ambiguous.length + rRes.ambiguous.length;

  const parts = [];
  if (transfersWritten) parts.push(`${transfersWritten} transfers matched`);
  if (reimbursementsWritten) parts.push(`${reimbursementsWritten} reimbursements matched`);
  if (repaired) parts.push(`${repaired} half-matched pairs repaired`);
  if (queuedForConfirm) parts.push(`${queuedForConfirm} above the $${threshold} autonomy threshold queued for confirmation`);
  if (ambiguous) parts.push(`${ambiguous} ambiguous queued`);
  if (conflicts) parts.push(`${conflicts} category conflicts left alone`);
  return {
    transfersWritten,
    reimbursementsWritten,
    ambiguous,
    conflicts,
    flags,
    line: parts.length ? `Matching: ${parts.join(', ')}.` : '',
    deposits,
  };
}

// True upstream freshness: the newest imported transaction date per bank account,
// not API reachability. Per-item: one failing account is recorded stale (fail
// closed) without aborting the others. Feed keys carry the account id so renames
// and name collisions cannot corrupt rows; rows for accounts that no longer exist
// are pruned so they cannot alarm forever.
export async function runFreshnessPass(db, { now = new Date() } = {}) {
  const accounts = (await firefly.getAccounts('asset')).filter((a) => a.active !== false);
  const results = await Promise.allSettled(accounts.map((a) => firefly.getLatestTransactionDate(a.id)));

  const feeds = [];
  const fetchFailed = [];
  accounts.forEach((a, i) => {
    const key = `bank:${a.id}:${a.name}`;
    if (results[i].status === 'fulfilled') {
      // An account with no transaction EVER is not feed-backed (manual assets like
      // a cash wallet or the Pokemon collection): there is nothing to be stale
      // about, so it is skipped rather than alarming as never-seen forever. A real
      // bank feed acquires transactions on its first import, so a feed that dies
      // later still ages out through the threshold.
      if (results[i].value === null) return;
      feeds.push({ name: key, lastActivity: results[i].value });
    } else {
      fetchFailed.push({ name: key, reason: results[i].reason?.message || 'fetch failed' });
    }
  });

  const assessment = assessFreshness(feeds, { now, defaultThresholdDays: FRESHNESS_THRESHOLD_DAYS });
  // A feed we could not even ask about is stale by definition (fail closed).
  for (const f of fetchFailed) {
    assessment.stale.push({ name: f.name, daysSince: null, reason: `fetch failed: ${f.reason}` });
  }

  const currentKeys = new Set([...feeds.map((f) => f.name), ...fetchFailed.map((f) => f.name)]);
  const staleNames = new Set(assessment.stale.map((s) => s.name));
  for (const key of currentKeys) {
    const feed = feeds.find((f) => f.name === key);
    recordFeedStatus(db, key, { lastSeen: feed?.lastActivity ?? null, status: staleNames.has(key) ? 'stale' : 'ok' });
  }
  // Prune rows for accounts that no longer exist (renamed or closed).
  const known = db.prepare("SELECT feed FROM feed_freshness WHERE feed LIKE 'bank:%'").all();
  const stmt = db.prepare('DELETE FROM feed_freshness WHERE feed = ?');
  for (const { feed } of known) {
    if (!currentKeys.has(feed)) stmt.run(feed);
  }

  return { assessment, line: staleSummaryLine(assessment), flags: assessment.flags };
}

// SimpleFIN balance oracle (SPEC 19 as amended): daily balance snapshots for
// Bridge-connected accounts matched by VALUATION_ACCOUNT_MATCH that deliberately
// never exist in Firefly. Off when fully unconfigured; a HALF-configuration is
// almost certainly a mistake and is flagged.
export async function runValuationPass(db, { now = new Date() } = {}) {
  const rules = parseMatchRules(process.env.VALUATION_ACCOUNT_MATCH);
  const hasUrl = Boolean(process.env.SIMPLEFIN_ACCESS_URL);
  if (!hasUrl && rules.length === 0) {
    return { ingested: 0, flags: [], line: '', enabled: false };
  }
  if (!hasUrl || rules.length === 0) {
    return {
      ingested: 0,
      flags: [
        `valuation oracle half-configured: ${hasUrl ? 'VALUATION_ACCOUNT_MATCH is empty' : 'SIMPLEFIN_ACCESS_URL is not set'}; oracle is OFF`,
      ],
      line: '',
      enabled: false,
    };
  }

  const [accounts, fireflyAssets, fireflyLiabilities] = await Promise.all([
    fetchBalances(),
    firefly.getAccounts('asset'),
    firefly.getAccounts('liabilities'),
  ]);
  const fireflyNames = [...fireflyAssets, ...fireflyLiabilities].map((a) => a.name);

  const flags = [];
  let matched = 0;
  let ingested = 0;
  for (const account of accounts) {
    if (!matchesValuationRule(account, rules)) continue;
    matched += 1;
    const r = normalizeValuation(account, { nowMs: now.getTime() });
    if (r.error) {
      flags.push(r.error);
      continue;
    }
    // Double-count tripwire: a matched Bridge account overlapping a Firefly account
    // name is probably importer-mapped; ingesting it would count it twice.
    const overlap = overlapsFireflyAccount(r.valuation.accountName, fireflyNames);
    if (overlap) {
      flags.push(
        `valuation "${r.valuation.accountName}" overlaps Firefly account "${overlap}"; NOT ingested (possible double-count). Tighten VALUATION_ACCOUNT_MATCH or rename one.`
      );
      continue;
    }
    // Measurement-change guard: a brand-new valuation account after the baseline is
    // locked moves net worth without any real gain. Ingest it (the data is real)
    // but surface it loudly so the baseline gets corrected inside the window.
    const isNew = !db
      .prepare('SELECT 1 FROM account_valuations WHERE source = ? AND account_id = ? LIMIT 1')
      .get(r.valuation.source, r.valuation.accountId);
    if (isNew && getMeta(db, 'baseline_locked_at')) {
      const msg = `new valuation account "${r.valuation.accountName}" adds ${r.valuation.balance.toFixed(2)} to net worth AFTER the baseline lock; correct the baseline (npm run onboard) inside the window or this reads as a gain`;
      flags.push(msg);
      queueNotification(db, 'confirm', msg);
    }
    upsertValuation(db, r.valuation);
    ingested += 1;
  }

  if (ingested === 0) {
    flags.push(
      matched === 0
        ? `valuation oracle matched no Bridge accounts for rules "${rules.join(', ')}"; connect the accounts in the Bridge or fix VALUATION_ACCOUNT_MATCH`
        : `valuation oracle matched ${matched} account(s) but none had a usable balance today`
    );
  }
  // Feed status reflects whether DATA landed, not whether the request succeeded.
  // lastSeen passes null on a bad day so the previous good date is preserved.
  recordFeedStatus(db, 'simplefin-oracle', {
    lastSeen: ingested > 0 ? firefly.nyDateStr(now) : null,
    status: ingested > 0 ? 'ok' : 'stale',
  });

  return {
    ingested,
    flags,
    line: ingested > 0 ? `Valuations: ${ingested} account balance${ingested === 1 ? '' : 's'} ingested.` : '',
    enabled: true,
  };
}

// Reconciliation: our computed net worth against Firefly's own summary figure, and
// observed payroll deposits against the in-effect paystub template (the re-upload
// trigger from SPEC 10.9). Cannot-reconcile is a reported state, never silence.
export async function runReconcilePass(db, { computedNetWorth = null, deposits = [] } = {}) {
  const lines = [];
  const flags = [];

  const reference = await firefly.getSummaryNetWorth(firefly.nyDateStr());
  const nwRes = reconcileNetWorth({ computed: computedNetWorth, reference });
  if (nwRes.ok === false) {
    lines.push(`Reconcile: net worth drifts ${nwRes.driftDollars.toFixed(2)} from Firefly's own figure; investigate before trusting it.`);
  } else if (nwRes.ok === null) {
    lines.push(`Reconcile: cannot verify net worth today (${nwRes.flags[0] ?? 'missing input'}).`);
  }

  const w2s = db.prepare("SELECT name FROM income_sources WHERE treatment = 'w2' AND active = 1").all();
  for (const { name } of w2s) {
    const template = latestPaystub(db, name);
    if (!template) continue;
    const srcTag = firefly.incomeSourceTag(name);
    const observed = deposits.filter((d) => d.tags.includes(srcTag) && d.date >= template.effective_from);
    if (observed.length === 0) continue;
    const r = reconcilePaystubDeposits({ template, deposits: observed });
    if (r.drifted.length) {
      const worst = r.drifted.reduce((a, b) => (Math.abs(b.deltaDollars) > Math.abs(a.deltaDollars) ? b : a));
      lines.push(
        `Paystub: your ${name} deposit came in ${Math.abs(worst.deltaDollars).toFixed(2)} ${worst.deltaDollars > 0 ? 'above' : 'below'} the template net; upload the new stub when you can.`
      );
    }
    flags.push(...r.flags.filter((f) => !f.includes('drifted')));
  }

  return { nwRes, lines, flags };
}

// The passes that must run BEFORE the daily snapshot: matching cleans the data the
// snapshot will sum, and freshness writes the verdicts the snapshot row records.
// Reconciliation runs after the snapshot (it needs the computed figure); the caller
// owns that ordering. Each pass fails independently (skip-and-report per SPEC 11).
export async function runPreSnapshotPasses(db, { matchingEnabled = true } = {}) {
  const lines = [];
  let deposits = [];

  if (matchingEnabled) {
    try {
      const m = await runMatchingPass(db);
      deposits = m.deposits;
      if (m.line) lines.push(m.line);
      surfaceFlags(lines, 'Matching', m.flags);
    } catch (e) {
      lines.push(`Matching pass failed: ${e.message}`);
    }
  }

  try {
    const f = await runFreshnessPass(db);
    if (f.line) lines.push(f.line);
    surfaceFlags(lines, 'Freshness', f.flags);
  } catch (e) {
    lines.push(`Freshness pass failed: ${e.message}`);
  }

  try {
    const v = await runValuationPass(db);
    if (v.line) lines.push(v.line);
    surfaceFlags(lines, 'Valuations', v.flags);
  } catch (e) {
    lines.push(`Valuation pass failed: ${e.message}`);
  }

  return { lines, deposits };
}

// Flags are surfaced, capped for heartbeat readability with an explicit remainder
// count; dropping them silently would disable the very checks they report on.
function surfaceFlags(lines, label, flags) {
  for (const f of flags.slice(0, 3)) lines.push(`${label} flag: ${f}`);
  if (flags.length > 3) lines.push(`${label}: ${flags.length - 3} more flags; see the audit log or run the pass manually.`);
}

export { surfaceFlags };
