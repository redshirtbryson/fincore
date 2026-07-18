// categorize-backlog: one-time bulk sweep of the uncategorized withdrawal residue.
//
// After the rule-based import pass, ~140 real expenses (restaurants, retail, gas,
// medical, ...) are left with no sub-category. This script hands that backlog to the
// SAME Haiku categorizer the daily loop uses (lib/anthropic.js: same prompt, same
// taxonomy, same output validation) instead of hand-writing merchant rules -- SPEC 3B,
// "deterministic in code, model on top".
//
// Usage:
//   node categorize-backlog.js            # DRY RUN: calls the model, prints proposals + tally, writes NOTHING
//   node categorize-backlog.js apply      # APPLY: sets categories in Firefly, tags each transaction
//
// Every model output is clamped to CATEGORY_SET (lib/categories.js). Anything the model
// invents -- or anything below the confidence threshold -- is LEFT UNCATEGORIZED, never
// guessed. Debt payments (destination_type Debt/Loan/Mortgage) are excluded up front:
// those are handled by the debt engine, not spend categorization.
//
// Hardening (SPEC 11/20): per-run cap, soft monthly cost ceiling with an 80% warning,
// per-item apply so one bad row can't sink the run, retry-with-backoff-then-skip inherited
// from categorizeBatch, and no partial writes on a failed setCategory (it either sets the
// category+tags or throws, and the failure is reported, not swallowed).
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { categorizeBatch } from './lib/anthropic.js';
import { CATEGORY_SET } from './lib/categories.js';

// ---- knobs (env-overridable) -------------------------------------------------
const APPLY = process.argv.slice(2).includes('apply');

// Per-run cap on how many transactions are sent to the model. A one-time backlog is
// ~140, so the default is generous; override with BACKLOG_CAP for a smaller smoke test.
const CAP = intEnv('BACKLOG_CAP', 500, 1);

// Confidence gate mirrors the daily loop: at or above -> apply; below -> leave for the
// human (here that just means "leave uncategorized", there is no Discord ask on a backlog).
const THRESHOLD = numEnv('CONFIDENCE_THRESHOLD', 0.8);

// How far back to scan. Wide by default because this is a historical backfill; the daily
// loop uses a 30-day window, this one covers the whole import.
const LOOKBACK = intEnv('BACKLOG_LOOKBACK_DAYS', 400, 1);

// Soft cost ceiling for THIS run (USD). There is no persistent monthly cost store in the
// agent layer yet, so this bounds the estimated spend of the single backlog run: warn at
// 80%, stop sending chunks once the estimate would exceed 100%. Haiku 4.5 pricing:
// $1.00 / 1M input tokens, $5.00 / 1M output tokens (2026-01 rates).
const COST_CEILING_USD = numEnv('BACKLOG_COST_CEILING_USD', 2.0);
const HAIKU_INPUT_PER_MTOK = 1.0;
const HAIKU_OUTPUT_PER_MTOK = 5.0;
// Rough per-transaction token budget: the payload row + the system prompt amortized across
// a chunk, plus the ~130-token JSON answer the daily loop budgets per item. Deliberately
// conservative (over-estimates), so the ceiling trips early rather than late.
const EST_INPUT_TOKENS_PER_TX = 220;
const EST_OUTPUT_TOKENS_PER_TX = 130;

// Firefly split destination_type values that mean "this withdrawal pays down a debt",
// not "this is spending to categorize". Case-insensitive substring match so "Loan account"
// / "Debt" / "Mortgage" all hit.
const DEBT_DESTINATION = /\b(debt|loan|mortgage)\b/i;

const RUN_TAG = `backlog-${firefly.nyDateStr()}`;
const MODEL_TAG = 'model-categorized';

function intEnv(name, dflt, min) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < min) {
    if (process.env[name] !== undefined) console.warn(`invalid ${name} "${process.env[name]}", using ${dflt}`);
    return dflt;
  }
  return Math.floor(raw);
}
function numEnv(name, dflt) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) {
    if (process.env[name] !== undefined) console.warn(`invalid ${name} "${process.env[name]}", using ${dflt}`);
    return dflt;
  }
  return raw;
}

function money(n) {
  return `$${n.toFixed(2)}`;
}

function estRunCost(txCount) {
  const inputCost = (txCount * EST_INPUT_TOKENS_PER_TX * HAIKU_INPUT_PER_MTOK) / 1_000_000;
  const outputCost = (txCount * EST_OUTPUT_TOKENS_PER_TX * HAIKU_OUTPUT_PER_MTOK) / 1_000_000;
  return inputCost + outputCost;
}

// Page ?type=withdrawal, keeping only splits that are genuinely uncategorized spend:
// no category, not already tagged done/review, and NOT a debt/loan/mortgage payment.
// Returns the same item shape lib/anthropic.js expects, plus merchant/account for display.
async function fetchUncategorizedWithdrawals({ lookbackDays, cap }) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const startStr = firefly.nyDateStr(start);
  const endStr = firefly.nyDateStr(end);

  const items = [];
  let page = 1;
  const maxPages = 100; // safety bound; 100 * 50 = 5000 splits
  let skippedDebt = 0;

  while (page <= maxPages && items.length < cap) {
    // Reuse the same REST surface the client uses; the private api() helper is not
    // exported, so go through fetch here with the documented v6 shape.
    const rows = await listWithdrawalPage({ startStr, endStr, page });
    if (rows.length === 0) break;

    for (const row of rows) {
      const splits = row?.attributes?.transactions || [];
      for (const s of splits) {
        const hasCategory = s.category_name && s.category_name.trim() !== '';
        if (hasCategory) continue;
        const tags = s.tags || [];
        if (tags.includes(firefly.TAG_DONE) || tags.includes(firefly.TAG_REVIEW)) continue;
        if (DEBT_DESTINATION.test(s.destination_type || '')) {
          skippedDebt += 1;
          continue;
        }
        items.push({
          tx_id: String(row.id),
          journal_id: String(s.transaction_journal_id),
          type: 'withdrawal',
          description: s.description || '',
          merchant: s.destination_name || '',
          amount: s.amount,
          currency: s.currency_code || '',
          date: (s.date || '').slice(0, 10),
          account: s.source_name || '',
          existing_tags: tags,
        });
        if (items.length >= cap) break;
      }
      if (items.length >= cap) break;
    }
    if (rows.length < 50) break; // short page: no more results
    page += 1;
  }
  return { items, skippedDebt, capped: items.length >= cap };
}

// Thin page fetch. Kept local (not in lib/firefly.js) because it needs destination_type,
// which the shared getRecentTransactions does not surface, and this is a one-time script.
async function listWithdrawalPage({ startStr, endStr, page }) {
  const base = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
  const pat = process.env.FIREFLY_III_PAT;
  const url = `${base}/api/v1/transactions?type=withdrawal&start=${startStr}&end=${endStr}&limit=50&page=${page}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firefly GET withdrawals page ${page} -> ${res.status} ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  return j?.data || [];
}

async function main() {
  const about = await firefly.about();
  console.log(`firefly ok: ${about?.version}  |  mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);

  const { items, skippedDebt, capped } = await fetchUncategorizedWithdrawals({ lookbackDays: LOOKBACK, cap: CAP });
  console.log(
    `Found ${items.length} uncategorized withdrawal split(s) to process` +
      `${skippedDebt ? `; skipped ${skippedDebt} debt/loan/mortgage payment(s)` : ''}` +
      `${capped ? ` (cap ${CAP} reached; rerun to continue)` : ''}.`
  );
  if (items.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Soft cost ceiling. The estimate is per-run and conservative; refuse to send more than
  // the ceiling allows, and warn at 80%.
  const fullEstimate = estRunCost(items.length);
  console.log(`Estimated model cost for this run: ~${money(fullEstimate)} (ceiling ${money(COST_CEILING_USD)}).`);
  let toProcess = items;
  if (fullEstimate > COST_CEILING_USD) {
    const affordable = Math.max(
      0,
      Math.floor(items.length * (COST_CEILING_USD / fullEstimate))
    );
    console.warn(
      `Estimated cost ${money(fullEstimate)} exceeds ceiling ${money(COST_CEILING_USD)}; ` +
        `trimming to ${affordable} transaction(s) (~${money(estRunCost(affordable))}). ` +
        `Raise BACKLOG_COST_CEILING_USD to process more in one run.`
    );
    toProcess = items.slice(0, affordable);
    if (toProcess.length === 0) {
      console.error('Ceiling too low to process even one transaction; aborting.');
      return;
    }
  } else if (fullEstimate >= 0.8 * COST_CEILING_USD) {
    console.warn(`Warning: estimated cost is at ${((fullEstimate / COST_CEILING_USD) * 100).toFixed(0)}% of the ceiling.`);
  }

  // Same engine as the daily loop: chunked, retried, output clamped to CATEGORY_SET.
  const { guesses, errors } = await categorizeBatch(toProcess);
  const byKey = new Map(guesses.map((g) => [`${g.tx_id}|${g.journal_id}`, g]));

  const tally = new Map();
  const proposals = []; // { item, category, confidence, willApply }
  let leftUncategorized = 0;

  for (const item of toProcess) {
    const g = byKey.get(`${item.tx_id}|${item.journal_id}`);
    // No guess (chunk failed / dropped), invalid category, Uncategorized, or low confidence
    // -> leave it alone. Never guess. normalizeGuess already forced invented categories to
    // 'Uncategorized' at confidence 0, so CATEGORY_SET membership is the final gate.
    const valid =
      g && CATEGORY_SET.has(g.category) && g.category !== 'Uncategorized' && g.confidence >= THRESHOLD;
    const category = valid ? g.category : null;
    if (!valid) leftUncategorized += 1;
    else tally.set(category, (tally.get(category) || 0) + 1);
    proposals.push({ item, category, confidence: g?.confidence ?? 0, willApply: valid });
  }

  // Preview lines (both modes print these; only APPLY writes).
  for (const p of proposals) {
    const label = p.willApply ? p.category : 'UNCATEGORIZED (left as-is)';
    const merchant = p.item.merchant || p.item.description || '(no payee)';
    console.log(
      `  ${p.item.date}  ${money(Number(p.item.amount))}  ${truncate(merchant, 40)}  ->  ${label}  (conf ${p.confidence.toFixed(2)})`
    );
  }

  console.log('\nProposed category tally:');
  for (const [cat, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${n}`);
  }
  console.log(`  (left uncategorized: ${leftUncategorized})`);
  if (errors.length) console.log(`\n${errors.length} chunk error(s): ${errors.slice(0, 5).join('; ')}`);

  if (!APPLY) {
    console.log('\nDRY RUN complete. No categories written. Re-run with `apply` to write.');
    return;
  }

  // APPLY: per-item write so one bad row cannot sink the run. Idempotent -- setCategory
  // merges tags and re-running skips anything now carrying TAG_DONE (via the fetch filter),
  // and re-setting the same category is a no-op.
  console.log('\nApplying...');
  let applied = 0;
  const applyFailures = [];
  for (const p of proposals) {
    if (!p.willApply) continue;
    try {
      // Mirror the daily loop's tagging: TAG_DONE + any policy tags a category implies
      // (Business Expense -> reimbursable, SPEC 11), plus this run's provenance tags.
      // Income-source tags never apply here (withdrawals only). One write, no partial state.
      await firefly.setCategory(p.item.tx_id, p.item.journal_id, p.category, {
        addTags: [firefly.TAG_DONE, MODEL_TAG, RUN_TAG, ...firefly.extraTagsFor(p.category)],
        removeTags: [firefly.TAG_REVIEW],
        knownTags: p.item.existing_tags,
      });
      applied += 1;
    } catch (e) {
      applyFailures.push(`${p.item.tx_id}/${p.item.journal_id}: ${e.message}`);
    }
  }
  console.log(
    `Applied ${applied} categor${applied === 1 ? 'y' : 'ies'}; ` +
      `${leftUncategorized} left uncategorized; ${applyFailures.length} write error(s).`
  );
  if (applyFailures.length) console.log(`Errors: ${applyFailures.slice(0, 10).join('; ')}`);
  console.log(`Tagged with '${MODEL_TAG}' and '${RUN_TAG}'.`);
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
