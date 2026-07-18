// One-off (baseline audit 2026-07-18): move the two Chase loans from transaction
// sync to balance truing, and delete the escrow line that corrupted the mortgage.
//
//   node unmap-loans.js          DRY RUN
//   node unmap-loans.js apply    switch modes, delete the bad txn, run the truing pass
//
// Why: feed transaction lines on loans (escrow, insurance) are not balance-affecting
// upstream; syncing the $34.14 MORTGAGE INSURANCE line pushed Firefly's mortgage
// $34.14 past the feed's figure. Loans are balance-authoritative from the feed:
// mode='balance' entries are excluded from transaction sync and freshness, and the
// daily runLoanBalancePass trues their opening balance to the feed instead.
import 'dotenv/config';
import * as firefly from './lib/firefly.js';
import { openStore, getSyncAccountMap, setSyncAccountMode } from './lib/store.js';
import { runLoanBalancePass } from './lib/quality.js';

const apply = process.argv[2] === 'apply';
const LOAN_FIREFLY_IDS = new Set(['5', '18']); // Chase - Auto, Chase - Mortgage
const BAD_TX = { id: '1102', descContains: 'MORTGAGE INSURANCE', cents: 3414 };

async function main() {
  console.log(`unmap-loans — mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  const db = openStore();

  const map = getSyncAccountMap(db);
  const targets = [...map.entries()].filter(([, m]) => LOAN_FIREFLY_IDS.has(String(m.fireflyAccountId)));
  for (const [sfid, m] of targets) {
    console.log(`  ${m.fireflyAccountName} (firefly ${m.fireflyAccountId}): mode ${m.mode} -> balance`);
  }
  if (targets.length !== LOAN_FIREFLY_IDS.size) {
    console.log(`  WARNING: expected ${LOAN_FIREFLY_IDS.size} loan entries in the sync map, found ${targets.length}`);
  }

  // Verify the bad transaction precisely before proposing its deletion.
  let badOk = false;
  try {
    const s = await firefly.getSplit(BAD_TX.id);
    const cents = Math.round(parseFloat(s.amount) * 100);
    badOk = (s.description || '').toUpperCase().includes(BAD_TX.descContains) && cents === BAD_TX.cents;
    console.log(`  tx${BAD_TX.id}: "${s.description}" $${parseFloat(s.amount).toFixed(2)} -> ${badOk ? 'DELETE (escrow line, not balance-affecting)' : 'MISMATCH — will NOT delete'}`);
  } catch (e) {
    console.log(`  tx${BAD_TX.id}: not found (${e.message}) — nothing to delete`);
  }

  if (!apply) {
    console.log('\nDRY RUN. Re-run with "apply".');
    db.close();
    return;
  }

  for (const [sfid, m] of targets) {
    if (m.mode !== 'balance') setSyncAccountMode(db, { simplefinId: sfid, mode: 'balance', actor: 'unmap-loans' });
  }
  console.log(`[1] ${targets.length} loan entr${targets.length === 1 ? 'y' : 'ies'} set to mode=balance.`);

  if (badOk) {
    await firefly.deleteTransaction(BAD_TX.id);
    console.log(`[2] deleted tx${BAD_TX.id} (escrow line).`);
  } else {
    console.log('[2] escrow line not deleted (missing or mismatched).');
  }

  const r = await runLoanBalancePass(db);
  console.log(`[3] truing pass: ${r.trued} trued.${r.line ? ' ' + r.line : ''}`);
  for (const f of r.flags) console.log('    flag: ' + f);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
