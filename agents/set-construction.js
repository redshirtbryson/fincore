// One-off: categorize the five identified property-capital outflows as Construction,
// tagged by which property (new home vs the currently-owned home). These are specific
// transactions (checks + a bare "WITHDRAWAL") with no reusable merchant pattern, so
// they are matched precisely by description-substring AND exact amount, never a loose
// keyword. The recurring architect merchant is handled by recategorize-backlog.js.
//
//   node set-construction.js         DRY RUN
//   node set-construction.js apply   set category Construction + a property tag
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const PAT = process.env.FIREFLY_III_PAT;
const apply = process.argv[2] === 'apply';
const cents = (a) => Math.round(parseFloat(a) * 100);

async function fapi(p, o = {}) {
  const r = await fetch(BASE + '/api/v1' + p, { ...o, headers: { Authorization: 'Bearer ' + PAT, Accept: 'application/json', 'Content-Type': 'application/json' } });
  const b = await r.text();
  if (!r.ok) { const e = new Error(r.status + ' ' + b.slice(0, 160)); e.status = r.status; throw e; }
  return b ? JSON.parse(b) : null;
}

// desc substring + exact amount (cents) uniquely identify each; tag records the property.
const TARGETS = [
  { desc: 'CHECK 5053', cents: 2360000, tag: 'property:new-home', note: 'land development (new home)' },
  { desc: 'ARCHITECTURAL DESIGNS', cents: 182000, tag: 'property:new-home', note: 'blueprints (new home)' },
  { desc: 'WITHDRAWAL', cents: 1160000, tag: 'property:current-home', note: 'HVAC install (current home)' },
  { desc: 'CHECK 5051', cents: 613927, tag: 'property:current-home', note: 'bathroom remodel (current home)' },
  { desc: 'CHECK 5050', cents: 70000, tag: 'property:current-home', note: 'window, bathroom remodel (current home)' },
];

// Pull all withdrawals once.
const all = [];
let page = 1;
for (;;) {
  const j = await fapi(`/transactions?type=withdrawal&limit=200&page=${page}`);
  const d = j.data || [];
  if (!d.length) break;
  for (const t of d) for (const s of t.attributes.transactions) {
    all.push({ txId: t.id, jId: s.transaction_journal_id, desc: (s.description || ''), amtCents: cents(s.amount), amount: s.amount, date: (s.date || '').slice(0, 10), cat: s.category_name || '', tags: s.tags || [], acct: s.source_name || '' });
  }
  if (d.length < 200) break;
  page += 1;
}

const work = [];
for (const t of TARGETS) {
  const hits = all.filter((x) => x.desc.toUpperCase().includes(t.desc.toUpperCase()) && x.amtCents === t.cents);
  if (hits.length === 0) { console.log(`NO MATCH: ${t.desc} @ $${(t.cents / 100).toFixed(2)} (${t.note})`); continue; }
  if (hits.length > 1) { console.log(`AMBIGUOUS (${hits.length}) for ${t.desc} @ $${(t.cents / 100).toFixed(2)}; skipping to avoid a wrong write`); continue; }
  const h = hits[0];
  console.log(`  ${h.date}  $${(h.amtCents / 100).toFixed(2)}  ${h.acct.replace(/.* - /, '')}  ${h.desc.slice(0, 30)}  ->  Construction [${t.tag}]  (${t.note})`);
  work.push({ ...h, tag: t.tag });
}

console.log(`\n${work.length}/${TARGETS.length} matched.`);
if (!apply) { console.log('Dry run. Re-run with "apply".'); process.exit(0); }

let done = 0;
for (const w of work) {
  const tags = Array.from(new Set([...w.tags, w.tag, 'construction-set']));
  try {
    await fapi(`/transactions/${w.txId}`, { method: 'PUT', body: JSON.stringify({ apply_rules: false, fire_webhooks: false, transactions: [{ transaction_journal_id: String(w.jId), category_name: 'Construction', tags }] }) });
    done += 1;
  } catch (e) { console.log('set fail ' + w.txId + ': ' + e.message); }
}
console.log(`Applied: ${done}/${work.length} set to Construction.`);
