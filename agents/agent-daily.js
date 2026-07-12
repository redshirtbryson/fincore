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

async function maybeTriggerImport() {
  const url = process.env.IMPORTER_AUTOIMPORT_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.IMPORTER_AUTOIMPORT_SECRET || '' }),
    });
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

  const guesses = await categorizeBatch(items);
  const byId = new Map(guesses.map((g) => [g.tx_id, g]));

  let applied = 0;
  let asked = 0;
  const failures = [];

  for (const item of items) {
    const g = byId.get(item.tx_id);
    if (!g) continue;
    try {
      if (g.confidence >= THRESHOLD && g.category && g.category !== 'Uncategorized') {
        await firefly.applyConfirmed(item.tx_id, item.journal_id, g.category);
        applied += 1;
      } else {
        await firefly.markReview(item.tx_id, item.journal_id);
        await sendAsk(item, g);
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
