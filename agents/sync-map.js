// SimpleFIN-to-Firefly account map management for the sync pass.
//
//   node sync-map.js                      show the current map and unmapped Bridge accounts
//   node sync-map.js auto                 DRY RUN: match live Bridge accounts to Firefly by name
//   node sync-map.js auto apply           write the auto-matched map
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

// Live-account matching rules: a Bridge account matches when its org contains
// `org` (case-insensitive) and, if given, its name contains `name`; it then maps
// to the Firefly account named `firefly`. Investment orgs are deliberately absent
// so they stay unmapped (the oracle owns them). Keep this in sync with the account
// names created in Firefly.
const AUTO_RULES = [
  { org: 'huntington', name: 'primary checking', firefly: 'Huntington Bank - Checking' },
  { org: 'huntington', name: 'premier savings', firefly: 'Huntington Bank - Savings' },
  { org: 'chase', name: 'chase auto', firefly: 'Chase - Auto' },
  { org: 'chase', name: 'amazon prime', firefly: 'Credit - Amazon Prime' },
  { org: 'chase', name: 'mortgage', firefly: 'Chase - Mortgage' },
  { org: 'city national', name: '', firefly: 'CNB - Joint' },
  { org: 'discover', name: '', firefly: 'Credit - Discover' },
  { org: 'apple card', name: '', firefly: 'Credit - Apple' },
  { org: 'synchrony', name: 'sleep outfitters', firefly: 'Credit - Synchrony (Sleep)' },
  { org: 'synchrony', name: 'reeds', firefly: 'Credit - Synchrony (Reeds)' },
];

// Orgs whose accounts are oracle-owned; never mapped (mapping would double-count).
const INVESTMENT_ORGS = ['empower', 'coinbase', 'schwab'];

async function autoSeed(db, apply) {
  if (!process.env.SIMPLEFIN_ACCESS_URL) {
    console.error('SIMPLEFIN_ACCESS_URL not set; cannot fetch Bridge accounts.');
    process.exit(1);
  }
  const accounts = await fetchBalances();
  const byName = await fireflyAccountsByName();
  const planned = [];
  const skippedInvestment = [];
  const unmatched = [];

  for (const a of accounts) {
    const org = (a.org?.name ?? '').toLowerCase();
    const nm = String(a.name ?? '').toLowerCase();
    if (INVESTMENT_ORGS.some((o) => org.includes(o))) {
      skippedInvestment.push(`${a.org?.name ?? ''} ${a.name ?? ''}`);
      continue;
    }
    const rule = AUTO_RULES.find((r) => org.includes(r.org) && (r.name === '' || nm.includes(r.name)));
    const ff = rule ? byName.get(rule.firefly.toLowerCase()) : null;
    if (ff) planned.push({ sfId: String(a.id), ffId: ff.id, ffName: ff.name, label: `${a.org?.name ?? ''} ${a.name ?? ''}`.trim() });
    else unmatched.push({ id: a.id, label: `${a.org?.name ?? ''} ${a.name ?? ''}`.trim(), reason: rule ? `no Firefly account "${rule.firefly}"` : 'no matching rule' });
  }

  console.log(`Planned mappings (${planned.length}):`);
  for (const p of planned) console.log(`  ${p.label.padEnd(52)} -> #${p.ffId} ${p.ffName}`);
  if (skippedInvestment.length) {
    console.log(`\nSkipped, oracle-owned (${skippedInvestment.length}): ${skippedInvestment.length} investment accounts`);
  }
  if (unmatched.length) {
    console.log(`\nUnmatched (map by hand with: node sync-map.js set <ACT-id> <fireflyId>):`);
    for (const u of unmatched) console.log(`  ${u.id}  ${u.label}  (${u.reason})`);
  }

  if (apply) {
    for (const p of planned) upsertSyncAccountMapEntry(db, { simplefinId: p.sfId, fireflyAccountId: p.ffId, fireflyAccountName: p.ffName });
    console.log(`\nWrote ${planned.length} mappings.`);
  } else {
    console.log('\nDry run. Re-run with "auto apply" to write.');
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
    else if (a === 'auto') await autoSeed(db, b === 'apply');
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
