// SimpleFIN-to-Firefly account map management for the sync pass.
//
//   node sync-map.js                      show the current map and unmapped Bridge accounts
//   node sync-map.js <importer-config>    seed the map from a data-importer config JSON
//   node sync-map.js set <ACT-id> <ffId>  map one Bridge account to a Firefly account id
//
// Seeding logic: config "accounts" entries with a nonzero Firefly id map directly;
// zero entries (create-new in importer terms) resolve by exact name match from the
// config's "new_accounts" against existing Firefly accounts. Anything unresolved is
// printed for a manual `set`. Only mapped accounts ever sync; investment accounts
// (Schwab, Coinbase, Empower) stay unmapped by design: the oracle owns them.
import 'dotenv/config';
import fs from 'node:fs';
import * as firefly from './lib/firefly.js';
import { openStore, getSyncAccountMap, upsertSyncAccountMapEntry } from './lib/store.js';
import { fetchBalances } from './lib/simplefin.js';

async function fireflyAccountsByName() {
  const [assets, liabilities] = await Promise.all([
    firefly.getAccounts('asset'),
    firefly.getAccounts('liabilities'),
  ]);
  const byName = new Map();
  for (const a of [...assets, ...liabilities]) byName.set(a.name.toLowerCase(), a);
  return byName;
}

async function show(db) {
  const map = getSyncAccountMap(db);
  console.log(`Mapped accounts (${map.size}):`);
  for (const [sfId, m] of map) console.log(`  ${sfId} -> ${m.fireflyAccountId} (${m.fireflyAccountName ?? '?'})`);
  if (process.env.SIMPLEFIN_ACCESS_URL) {
    const accounts = await fetchBalances();
    const unmapped = accounts.filter((a) => !map.has(String(a.id)));
    console.log(`\nBridge accounts not mapped (${unmapped.length}; investment accounts belong here):`);
    for (const a of unmapped) console.log(`  ${a.id}  ${a.org?.name ?? ''} ${a.name ?? ''}`);
  }
}

async function seed(db, configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const accounts = cfg.accounts ?? {};
  const newAccounts = cfg.new_accounts ?? {};
  const byName = await fireflyAccountsByName();
  const unresolved = [];

  const byId = new Map([...byName.values()].map((a) => [String(a.id), a]));
  for (const [sfId, ffId] of Object.entries(accounts)) {
    if (Number(ffId) > 0) {
      const resolved = byId.get(String(ffId));
      upsertSyncAccountMapEntry(db, {
        simplefinId: sfId,
        fireflyAccountId: String(ffId),
        fireflyAccountName: resolved?.name ?? null,
      });
      console.log(`mapped ${sfId} -> ${ffId} (${resolved?.name ?? 'name unknown'}, from config)`);
      continue;
    }
    const wanted = newAccounts[sfId]?.name?.trim();
    const match = wanted ? byName.get(wanted.toLowerCase()) : null;
    if (match) {
      upsertSyncAccountMapEntry(db, { simplefinId: sfId, fireflyAccountId: match.id, fireflyAccountName: match.name });
      console.log(`mapped ${sfId} -> ${match.id} (${match.name}, by name)`);
    } else {
      unresolved.push({ sfId, wanted });
    }
  }
  if (unresolved.length) {
    console.log('\nUnresolved (create the Firefly account, then: node sync-map.js set <ACT-id> <fireflyId>):');
    for (const u of unresolved) console.log(`  ${u.sfId}  wanted name: ${u.wanted ?? '(none in config)'}`);
  }
}

async function setOne(db, sfId, ffId) {
  const byName = await fireflyAccountsByName();
  const match = [...byName.values()].find((a) => String(a.id) === String(ffId));
  if (!match) {
    console.error(`No Firefly account with id ${ffId}; check the account URL in the Firefly UI.`);
    process.exit(1);
  }
  upsertSyncAccountMapEntry(db, { simplefinId: sfId, fireflyAccountId: match.id, fireflyAccountName: match.name });
  console.log(`mapped ${sfId} -> ${match.id} (${match.name})`);
}

async function main() {
  const db = openStore();
  const [a, b, c] = process.argv.slice(2);
  try {
    if (!a) await show(db);
    else if (a === 'set' && b && c) await setOne(db, b, c);
    else await seed(db, a);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
