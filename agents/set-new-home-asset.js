// Capitalize the new-home spend into a tracked asset. The land development and the
// blueprints left CNB / Discover as ordinary outflows; without a matching asset they
// just drop out of net worth. This creates a "New Home" asset account and converts
// those two outflows into TRANSFERS into it, so the money is recorded as property
// (net-worth-neutral: cash/credit out, asset in) rather than consumed.
//
//   node set-new-home-asset.js         DRY RUN
//   node set-new-home-asset.js apply   create the account + convert the two outflows
//
// Only the NEW-home outflows are capitalized. The current-home improvements (HVAC,
// bathroom, window) stay Construction expenses for now (they raise the value of the
// already-tracked Home asset; revisit that figure separately).
import 'dotenv/config';
import * as firefly from './lib/firefly.js';

const apply = process.argv[2] === 'apply';
const cents = (a) => Math.round(parseFloat(a) * 100);
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const H = { Authorization: 'Bearer ' + process.env.FIREFLY_III_PAT, Accept: 'application/json', 'Content-Type': 'application/json' };
async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: H });
  const b = await r.text();
  if (!r.ok) { const e = new Error(r.status + ' ' + b.slice(0, 200)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

const ACCOUNT_NAME = 'New Home';
// desc substring + exact amount uniquely identify the two new-home outflows.
const TARGETS = [
  { desc: 'CHECK 5053', cents: 2360000, note: 'land development' },
  { desc: 'ARCHITECTURAL DESIGNS', cents: 182000, note: 'blueprints' },
];

async function main() {
  console.log(`New-home asset — mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const assets = await firefly.getAccounts('asset');
  let acct = assets.find((a) => a.name === ACCOUNT_NAME);

  const { items } = await firefly.getRecentTransactions({ lookbackDays: 400, capPerType: 2000 });
  const matches = [];
  for (const t of TARGETS) {
    const hits = items.filter((x) => x.type === 'withdrawal' && x.description.toUpperCase().includes(t.desc.toUpperCase()) && cents(x.amount) === t.cents);
    if (hits.length !== 1) { console.log(`${hits.length === 0 ? 'NO MATCH' : 'AMBIGUOUS(' + hits.length + ')'}: ${t.desc} @ ${money(t.cents / 100)} (${t.note})`); continue; }
    matches.push({ ...hits[0], note: t.note });
  }

  console.log(`Account "${ACCOUNT_NAME}": ${acct ? 'exists (id ' + acct.id + ')' : 'will be CREATED (asset)'}`);
  console.log('Outflows to convert into it (withdrawal -> transfer into New Home):');
  for (const m of matches) console.log(`  ${m.date}  ${money(m.amount)}  from ${m.account}  ${m.description.slice(0, 28)}  (${m.note})`);
  const total = matches.reduce((n, m) => n + cents(m.amount), 0) / 100;
  console.log(`Target New Home balance after: ${money(total)}`);

  if (!apply) { console.log('\nDRY RUN. Re-run with "apply".'); return; }

  if (!acct) {
    const created = await fapi('/accounts', { method: 'POST', body: JSON.stringify({ name: ACCOUNT_NAME, type: 'asset', account_role: 'defaultAsset', include_net_worth: true }) });
    acct = { id: created.data.id, name: ACCOUNT_NAME };
    console.log(`\n[+] created asset account "${ACCOUNT_NAME}" (id ${acct.id})`);
  }

  let done = 0;
  for (const m of matches) {
    try {
      await firefly.convertInternalLeg(m.tx_id, m.journal_id, {
        sourceId: m.accountId,
        destinationId: acct.id,
        destinationIsLiability: false, // New Home is an asset -> a real transfer
        addTags: ['property:new-home', 'new-home-asset'],
        knownTags: m.tags,
      });
      console.log(`  converted ${money(m.amount)} ${m.note} -> transfer ${m.account} -> New Home`);
      done += 1;
    } catch (e) {
      console.log(`  FAILED ${money(m.amount)} ${m.note} (from ${m.account}): ${e.message}`);
    }
  }

  const after = (await firefly.getAccounts('asset')).find((a) => a.name === ACCOUNT_NAME);
  console.log(`\nConverted ${done}/${matches.length}. New Home balance now ${money(after ? after.current_balance : 0)} (target ${money(total)}).`);
  if (done < matches.length) console.log('A leg failed to convert (likely the Discover/credit one); it stays a Construction expense. Tell me and we will capitalize it another way.');
}

main().catch((e) => { console.error(e); process.exit(1); });
