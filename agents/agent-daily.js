// agent-daily: runs each morning under PM2, categorizes new transactions.
// Deterministic categorization is already handled by Firefly III rules on import;
// this job only touches the residue Firefly could not categorize, sends it to Haiku,
// auto-applies confident answers, and asks on Discord when unsure.
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { categorizeBatch } from './lib/anthropic.js';
import { sendAsk, sendHeartbeat } from './lib/discord.js';

const THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.8);
const CAP = Number(process.env.CATEGORIZE_CAP || 40);
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 30);

// Trigger the Data Importer's autoimport endpoint: POST /autoimport?directory=..&secret=..
// with an empty body. Requires CAN_POST_AUTOIMPORT, AUTO_IMPORT_SECRET, and
// IMPORT_DIR_ALLOWLIST on the importer container (see firefly-stack/README.md).
// Fire-and-forget: the import runs asynchronously in the importer, so transactions it
// pulls may only be categorized on the next run. The lookback window absorbs that.
async function maybeTriggerImport() {
  const base = (process.env.IMPORTER_URL || '').replace(/\/+$/, '');
  const secret = process.env.IMPORTER_AUTOIMPORT_SECRET || '';
  if (process.env.IMPORTER_AUTOIMPORT_URL) {
    console.warn('IMPORTER_AUTOIMPORT_URL is no longer read; set IMPORTER_URL + IMPORTER_AUTOIMPORT_SECRET (see .env.example).');
  }
  if (!base && !secret) return;
  if (!base || !secret) {
    console.warn('autoimport trigger skipped: both IMPORTER_URL and IMPORTER_AUTOIMPORT_SECRET must be set.');
    return;
  }
  const dir = process.env.IMPORTER_AUTOIMPORT_DIR || '/import';
  const url = `${base}/autoimport?directory=${encodeURIComponent(dir)}&secret=${encodeURIComponent(secret)}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
    if (!res.ok) console.warn(`importer trigger -> ${res.status} (continuing)`);
  } catch (e) {
    console.warn('importer trigger failed (continuing):', e.message);
  }
}

async function main() {
  // Health check first so a bad token fails loudly and early.
  const about = await firefly.about();
  console.log('firefly ok:', about?.version);

  await maybeTriggerImport();

  const items = await firefly.getTransactionsNeedingReview({ lookbackDays: LOOKBACK, cap: CAP });
  if (items.length === 0) {
    await sendHeartbeat('Fincore daily: no new transactions to categorize.');
    return;
  }

  const { guesses, errors } = await categorizeBatch(items);
  // Keyed per split, not per transaction: a multi-split transaction yields several
  // items sharing one tx_id, and collapsing them would apply one split's guess to all.
  const byKey = new Map(guesses.map((g) => [`${g.tx_id}|${g.journal_id}`, g]));

  let applied = 0;
  let asked = 0;
  const failures = [...errors];

  for (const item of items) {
    const g = byKey.get(`${item.tx_id}|${item.journal_id}`);
    if (!g) continue;
    try {
      if (g.confidence >= THRESHOLD && g.category && g.category !== 'Uncategorized') {
        await firefly.applyConfirmed(item.tx_id, item.journal_id, g.category, {
          incomeSource: g.income_source,
          knownTags: item.existing_tags,
        });
        applied += 1;
      } else {
        // Ask first, then tag. The review tag makes future runs skip the transaction,
        // so it must never be applied unless the human was actually asked; a failed
        // tag after a sent ask just means a duplicate ask tomorrow, which is benign.
        await sendAsk(item, g);
        await firefly.markReview(item.tx_id, item.journal_id, { knownTags: item.existing_tags });
        asked += 1;
      }
    } catch (e) {
      failures.push(`${item.tx_id}: ${e.message}`);
    }
  }

  const overflow = items.length >= CAP ? ` Cap reached (${CAP}); more will process tomorrow.` : '';
  let summary = `Fincore daily: ${applied} auto-categorized, ${asked} need your review.${overflow}`;
  if (failures.length) summary += `\n${failures.length} errors: ${failures.slice(0, 5).join('; ')}`;
  await sendHeartbeat(summary);
  console.log(summary);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sendHeartbeat(`Fincore daily FAILED: ${e.message}`);
  } catch (_) {}
  process.exit(1);
});
