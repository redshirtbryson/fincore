// Firefly III REST client (v6 API). Plain fetch, bearer PAT.
// Payload shapes follow the documented v6 API. If your Firefly version differs,
// verify against {FIREFLY_III_URL}/api/v1/documentation.
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const PAT = process.env.FIREFLY_III_PAT;
const TAG_DONE = process.env.TAG_DONE || 'ai-categorized';
const TAG_REVIEW = process.env.TAG_REVIEW || 'needs-review';
const RULE_GROUP_TITLE = process.env.RULE_GROUP_TITLE || 'AI Categorized';

// Transient-failure retry (SPEC section 11 hardening rule): network errors, 429,
// and 5xx get a couple of backed-off retries before the error surfaces. A retried
// POST could in theory double-apply if the first attempt succeeded before dying,
// but the only POSTs here (rules, rule groups) are harmless to duplicate.
const RETRY_BACKOFF_MS = [1000, 4000];

function headers() {
  return {
    Authorization: `Bearer ${PAT}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Bounded per-request: a hung connection must surface as an error (which the retry
// and skip-and-report machinery handles) rather than stalling a run forever.
const REQUEST_TIMEOUT_MS = Number(process.env.FIREFLY_TIMEOUT_MS) > 0 ? Number(process.env.FIREFLY_TIMEOUT_MS) : 30000;

async function attempt(path, opts) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...opts,
    headers: headers(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Firefly ${opts.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function api(path, opts = {}) {
  let lastErr = null;
  for (let i = 0; i <= RETRY_BACKOFF_MS.length; i += 1) {
    try {
      return await attempt(path, opts);
    } catch (e) {
      lastErr = e;
      const transient = e.status === undefined || e.status === 429 || e.status >= 500;
      if (!transient || i === RETRY_BACKOFF_MS.length) throw e;
      await sleep(RETRY_BACKOFF_MS[i]);
    }
  }
  throw lastErr;
}

export async function about() {
  const j = await api('/about');
  return j?.data;
}

// All period math uses America/New_York (SPEC section 20), not the host clock's UTC date.
export function nyDateStr(date = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

// Return one item per uncategorized withdrawal or deposit split within the lookback
// window, skipping anything already tagged done or review. Deposits are fetched
// FIRST on purpose: they are few and high-value (income recognition), and a large
// withdrawal backlog must not starve them out of the shared cap. Transfers Firefly
// already knows about (type=transfer) are not fetched.
export async function getTransactionsNeedingReview({ lookbackDays = 30, cap = 40 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const startStr = nyDateStr(start);
  const endStr = nyDateStr(end);

  const items = [];
  for (const type of ['deposit', 'withdrawal']) {
    let page = 1;
    const maxPages = 20; // safety bound
    while (page <= maxPages && items.length < cap) {
      const j = await api(
        `/transactions?type=${type}&start=${startStr}&end=${endStr}&limit=50&page=${page}`
      );
      const rows = j?.data || [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const splits = row?.attributes?.transactions || [];
        for (const s of splits) {
          const tags = s.tags || [];
          const hasCategory = s.category_name && s.category_name.trim() !== '';
          if (hasCategory) continue;
          if (tags.includes(TAG_DONE) || tags.includes(TAG_REVIEW)) continue;
          items.push({
            tx_id: String(row.id),
            journal_id: String(s.transaction_journal_id),
            type,
            description: s.description || '',
            // For a withdrawal the counterparty is the destination; for a deposit it is the source.
            merchant: (type === 'deposit' ? s.source_name : s.destination_name) || '',
            amount: s.amount,
            currency: s.currency_code || '',
            date: (s.date || '').slice(0, 10),
            account: (type === 'deposit' ? s.destination_name : s.source_name) || '',
            existing_tags: tags,
          });
          if (items.length >= cap) break;
        }
        if (items.length >= cap) break;
      }
      if (rows.length < 50) break; // short page: no more results, skip the empty-page probe
      page += 1;
    }
  }
  return items;
}

// Create one transaction (used by the SimpleFIN sync). apply_rules lets the rules
// engine categorize on arrival; error_if_duplicate_hash is Firefly's own content
// dedup, the second layer behind the sync's seen-ledger. Returns { id } on create
// or { duplicate: true } when Firefly already holds an identical transaction.
export async function createTransaction({ type, date, amount, description, sourceId = null, sourceName = null, destinationId = null, destinationName = null, externalId = null, tags = [] }) {
  const txn = {
    type,
    date,
    amount: String(amount),
    description,
    tags,
  };
  if (sourceId !== null) txn.source_id = String(sourceId);
  else if (sourceName) txn.source_name = sourceName;
  if (destinationId !== null) txn.destination_id = String(destinationId);
  else if (destinationName) txn.destination_name = destinationName;
  if (externalId) txn.external_id = String(externalId);

  try {
    const j = await api('/transactions', {
      method: 'POST',
      body: JSON.stringify({
        error_if_duplicate_hash: true,
        apply_rules: true,
        fire_webhooks: false,
        transactions: [txn],
      }),
    });
    return { id: j?.data?.id ? String(j.data.id) : null };
  } catch (e) {
    if (e.status === 422 && /duplicate/i.test(e.message)) return { duplicate: true };
    throw e;
  }
}

// List accounts of a Firefly type group ('asset', 'liabilities'). Balances come
// back as strings; parse defensively and let the caller's engine flag NaN rather
// than dropping accounts silently.
export async function getAccounts(type) {
  const accounts = [];
  let page = 1;
  const maxPages = 20; // safety bound
  while (page <= maxPages) {
    const j = await api(`/accounts?type=${type}&limit=50&page=${page}`);
    const rows = j?.data || [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const at = row?.attributes || {};
      // A null or empty balance must stay undefined so the net worth engine flags
      // it; Number(null) and Number('') are 0, which would silently sum a missing
      // balance as a legitimate zero.
      const rawBalance = at.current_balance;
      accounts.push({
        id: String(row.id),
        name: at.name || '',
        // Firefly reports specific types (loan, debt, mortgage); collapse to the
        // engine's asset/liability axis via the requested group.
        type: type === 'asset' ? 'asset' : 'liability',
        currentBalance:
          rawBalance === undefined || rawBalance === null || rawBalance === '' ? undefined : Number(rawBalance),
        currencyCode: at.currency_code || '',
        includeNetWorth: at.include_net_worth !== false,
        active: at.active !== false,
        interest: at.interest !== undefined && at.interest !== null && at.interest !== '' ? Number(at.interest) : null,
      });
    }
    if (rows.length < 50) break; // short page: no more results, skip the empty-page probe
    page += 1;
  }
  return accounts;
}

// One account with its opening-balance fields, for the loan balance-truing pass.
export async function getAccountDetail(id) {
  const j = await api(`/accounts/${id}`);
  const at = j?.data?.attributes || {};
  return {
    id: String(j?.data?.id ?? id),
    name: at.name || '',
    currentBalance: at.current_balance === undefined || at.current_balance === null || at.current_balance === '' ? null : Number(at.current_balance),
    openingBalance: at.opening_balance === undefined || at.opening_balance === null || at.opening_balance === '' ? null : Number(at.opening_balance),
    openingBalanceDate: (at.opening_balance_date || '').slice(0, 10) || null,
  };
}

// Set an account's opening balance (the loan balance-truing write). Firefly's
// account PUT requires the name; the opening date is preserved. Read-back verified:
// a 200 is weaker evidence than the stored value for a money-grade write.
export async function setOpeningBalance(id, { openingBalance, openingBalanceDate, name }) {
  const body = { name, opening_balance: String(openingBalance) };
  if (openingBalanceDate) body.opening_balance_date = openingBalanceDate;
  const res = await api(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  const after = await getAccountDetail(id);
  if (after.openingBalance === null || Math.round(after.openingBalance * 100) !== Math.round(Number(openingBalance) * 100)) {
    throw new Error(
      `setOpeningBalance verification failed for account ${id}: wanted ${openingBalance}, stored ${after.openingBalance ?? '(none)'}`
    );
  }
  return res;
}

// Firefly's own net worth figure (summary endpoint), used as the independent
// reference for reconciliation. Returns a number or null when unavailable or not
// USD; the reconcile engine treats null as a flagged cannot-reconcile, never a pass.
export async function getSummaryNetWorth(dateStr) {
  // Firefly's /summary/basic requires start < end (a same-day range 422s). The
  // net worth figure it returns is end-of-range, so a one-day window ending on
  // dateStr gives the balance as of dateStr.
  const start = nyDateStr(new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - 86400000));
  const j = await api(`/summary/basic?start=${start}&end=${dateStr}`);
  const entry = j?.['net-worth-in-USD'] ?? Object.entries(j || {}).find(([k]) => k.startsWith('net-worth-in-'))?.[1];
  const v = entry?.monetary_value;
  const n = typeof v === 'number' ? v : v !== undefined && v !== null && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Date of the newest transaction touching an account, regardless of type. This is
// the real upstream-freshness signal for a bank feed: SimpleFIN imports create
// transactions, so a silent feed shows up as this date going stale.
export async function getLatestTransactionDate(accountId) {
  const j = await api(`/accounts/${accountId}/transactions?limit=1&page=1`);
  const split = j?.data?.[0]?.attributes?.transactions?.[0];
  return split?.date ? String(split.date).slice(0, 10) : null;
}

// Generic recent-transaction listing for the matching and reconciliation passes.
// Unlike getTransactionsNeedingReview this returns ALL splits of the given types
// (categorized or not) with their category and tags. Returns { items, truncated }:
// each type has its OWN cap (a busy withdrawal window must not starve deposits),
// and truncated=true means the window was not fully covered, which matters because
// the matcher's uniqueness guarantee is only valid over a complete candidate set.
export async function getRecentTransactions({ types = ['withdrawal', 'deposit'], lookbackDays = 30, capPerType = 600 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const startStr = nyDateStr(start);
  const endStr = nyDateStr(end);
  const pageSize = 200;

  const items = [];
  let truncated = false;
  for (const type of types) {
    let count = 0;
    let page = 1;
    const maxPages = 20; // safety bound
    for (;;) {
      if (page > maxPages) {
        truncated = true;
        break;
      }
      const j = await api(
        `/transactions?type=${type}&start=${startStr}&end=${endStr}&limit=${pageSize}&page=${page}`
      );
      const rows = j?.data || [];
      if (rows.length === 0) break;
      for (const row of rows) {
        for (const s of row?.attributes?.transactions || []) {
          if (count >= capPerType) {
            truncated = true;
            break;
          }
          items.push({
            tx_id: String(row.id),
            journal_id: String(s.transaction_journal_id),
            type,
            amount: s.amount,
            date: (s.date || '').slice(0, 10),
            description: s.description || '',
            account: (type === 'deposit' ? s.destination_name : s.source_name) || '',
            accountId: (type === 'deposit' ? s.destination_id : s.source_id)
              ? String(type === 'deposit' ? s.destination_id : s.source_id)
              : null,
            counterparty: (type === 'deposit' ? s.source_name : s.destination_name) || '',
            category: s.category_name || '',
            budgetId: s.budget_id != null && s.budget_id !== '0' ? String(s.budget_id) : null,
            tags: s.tags || [],
            currencyCode: s.currency_code || null,
            externalId: s.external_id || null,
          });
          count += 1;
        }
        if (truncated) break;
      }
      if (truncated || rows.length < pageSize) break;
      page += 1;
    }
  }
  return { items, truncated };
}

// Fetch one split of a transaction. Exported so the bot does not need its own copy.
export async function getSplit(txId, journalId) {
  const j = await api(`/transactions/${txId}`);
  const splits = j?.data?.attributes?.transactions || [];
  return splits.find((s) => String(s.transaction_journal_id) === String(journalId)) || splits[0];
}

// Set category on a split and adjust its tag set. Firefly replaces the tag array on
// update, so current tags are merged in: from opts.knownTags when the caller already
// has them (saves a GET per write in the daily loop), else fetched.
// categoryName semantics: a string sets it, null clears it, undefined omits the field
// entirely (tags-only update).
export async function setCategory(txId, journalId, categoryName, { addTags = [], removeTags = [], knownTags = null } = {}) {
  const baseTags = knownTags ?? (await getSplit(txId, journalId))?.tags ?? [];
  const current = new Set(baseTags);
  for (const t of addTags) current.add(t);
  for (const t of removeTags) current.delete(t);

  const update = {
    transaction_journal_id: String(journalId),
    tags: Array.from(current),
  };
  if (categoryName !== undefined) update.category_name = categoryName;

  const body = {
    apply_rules: false,
    fire_webhooks: false,
    transactions: [update],
  };
  return api(`/transactions/${txId}`, { method: 'PUT', body: JSON.stringify(body) });
}

// Assign a split to a budget by name (tags and category untouched). Used by the
// daily budget-assignment pass: categorized consumption withdrawals get their
// category's budget so Firefly's budget bars cover the whole income stream.
export async function setBudget(txId, journalId, budgetName) {
  const body = {
    apply_rules: false,
    fire_webhooks: false,
    transactions: [{ transaction_journal_id: String(journalId), budget_name: budgetName }],
  };
  return api(`/transactions/${txId}`, { method: 'PUT', body: JSON.stringify(body) });
}

// Some Firefly versions reject category_name null as a validation error. Once seen,
// remembered for the process lifetime so the doomed attempt is not repeated per item.
let nullCategoryRejected = false;

export async function markReview(txId, journalId, { knownTags = null } = {}) {
  if (!nullCategoryRejected) {
    try {
      return await setCategory(txId, journalId, null, { addTags: [TAG_REVIEW], knownTags });
    } catch (e) {
      if (e.status !== 400 && e.status !== 422) throw e;
      nullCategoryRejected = true;
    }
  }
  return setCategory(txId, journalId, undefined, { addTags: [TAG_REVIEW], knownTags });
}

// Slug an income source for a Firefly tag: "Redshirt Cloud" -> "income-source:redshirt-cloud".
export function incomeSourceTag(source) {
  const slug = String(source || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `income-source:${slug}` : null;
}

// Apply a confirmed answer: set category, mark done, clear review.
// Income with a known source gets an income-source tag (SPEC 10.2); Business Expense
// gets a reimbursable tag so the later payback can be matched instead of
// double-counted (SPEC section 11).
export async function applyConfirmed(txId, journalId, categoryName, { incomeSource = null, knownTags = null } = {}) {
  const addTags = [TAG_DONE, ...extraTagsFor(categoryName, incomeSource)];
  return setCategory(txId, journalId, categoryName, {
    addTags,
    removeTags: [TAG_REVIEW],
    knownTags,
  });
}

// Policy tags implied by a category. Shared by applyConfirmed (this transaction) and
// createDescriptionRule (future transactions matched by the rule), so a recurring
// Business Expense keeps getting its reimbursable tag even though rule-categorized
// imports never pass through the agent again.
export function extraTagsFor(categoryName, incomeSource = null) {
  const tags = [];
  if (categoryName === 'Income') {
    const t = incomeSourceTag(incomeSource);
    if (t) tags.push(t);
  }
  if (categoryName === 'Business Expense') tags.push('reimbursable');
  return tags;
}

async function ensureRuleGroup() {
  const j = await api('/rule-groups?limit=100');
  const found = (j?.data || []).find((g) => g?.attributes?.title === RULE_GROUP_TITLE);
  if (found) return String(found.id);
  const created = await api('/rule-groups', {
    method: 'POST',
    body: JSON.stringify({ title: RULE_GROUP_TITLE, active: true }),
  });
  return String(created?.data?.id);
}

// Turn a merchant string into a rule trigger token. Kept simple on purpose;
// tune deriveMerchantToken if rules end up too broad or too narrow.
export function deriveMerchantToken({ merchant, description }) {
  const raw = (merchant && merchant.trim()) || (description || '').trim();
  // strip trailing store numbers / long digit runs that vary per transaction
  return raw.replace(/\s+#?\d{3,}.*$/, '').replace(/\s{2,}/g, ' ').trim().slice(0, 80);
}

// Generic counterparties that must never seed a rule: a manual transaction with no
// real payee resolves to Firefly's cash account, and a rule keyed on that matches
// unrelated transactions.
const GENERIC_TOKENS = /^(cash( account| wallet)?|\(cash\)|unknown|n\/a)$/i;

export function isGenericCounterparty(token) {
  return token === '' || GENERIC_TOKENS.test(token.trim());
}

// Create a description_contains -> set_category rule so this merchant is categorized
// deterministically next time and never hits the model again. extraTags become
// add_tag actions so policy tags survive rule-based categorization too.
export async function createDescriptionRule({ merchant, description, category, extraTags = [] }) {
  const token = deriveMerchantToken({ merchant, description });
  if (!token || isGenericCounterparty(token)) return null;
  const ruleGroupId = await ensureRuleGroup();
  const actions = [{ type: 'set_category', value: category, stop_processing: false, active: true }];
  for (const t of extraTags) {
    actions.push({ type: 'add_tag', value: t, stop_processing: false, active: true });
  }
  const body = {
    title: `AI: ${token} -> ${category}`.slice(0, 100),
    rule_group_id: ruleGroupId,
    trigger: 'store-journal',
    active: true,
    strict: false,
    stop_processing: false,
    triggers: [{ type: 'description_contains', value: token, stop_processing: false, active: true }],
    actions,
  };
  try {
    return await api('/rules', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // A rule for this merchant already exists (a prior confirmation of the same
    // payee, common when clearing a queue of repeated merchants). That is success,
    // not an error: the merchant is already deterministic. Anything else rethrows.
    if (e.status === 422 && /already in use/i.test(e.message)) return { existing: true };
    throw e;
  }
}

// Transaction ids carrying a given tag, paged. Used by the CSV backfill rollback.
export async function getTransactionsByTag(tag) {
  const ids = [];
  let page = 1;
  const maxPages = 100;
  while (page <= maxPages) {
    const j = await api(`/tags/${encodeURIComponent(tag)}/transactions?limit=50&page=${page}`);
    const rows = j?.data || [];
    if (rows.length === 0) break;
    for (const r of rows) ids.push(String(r.id));
    if (rows.length < 50) break;
    page += 1;
  }
  return ids;
}

export async function deleteTransaction(id) {
  return api(`/transactions/${id}`, { method: 'DELETE' });
}

// Re-point one surviving leg so an internal movement stops double-counting. The bank
// feed produces two independent legs for one movement (a withdrawal into an expense
// account plus a deposit out of a revenue account); the caller deletes the redundant
// opposite leg first (conservative order: a mid-flight failure overstates expense, not
// income) and calls this on the leg that remains.
//
// The correct Firefly modeling depends on where the money landed:
//   - into an ASSET account (checking->savings): a TRANSFER. Both registers move, no
//     expense/revenue account, net worth unchanged.
//   - into a LIABILITY account (a credit-card payment): a WITHDRAWAL whose destination
//     IS the liability. This Firefly rejects a liability as a transfer destination
//     ("could not find a valid destination account"), but a withdrawal into the
//     liability pays the debt down: source asset falls, liability falls, net worth
//     unchanged, and it is never income. destinationIsLiability selects this.
// destinationId is the own account the money actually entered; sourceId is the account
// it left (the surviving withdrawal leg's own account).
export async function convertInternalLeg(
  txId,
  journalId,
  { sourceId, destinationId, destinationIsLiability = false, addTags = [], knownTags = null }
) {
  const wantType = destinationIsLiability ? 'withdrawal' : 'transfer';
  const baseTags = knownTags ?? (await getSplit(txId, journalId))?.tags ?? [];
  const tags = new Set(baseTags);
  for (const t of addTags) tags.add(t);
  const update = {
    transaction_journal_id: String(journalId),
    type: wantType,
    source_id: String(sourceId),
    destination_id: String(destinationId),
    tags: Array.from(tags),
  };
  const body = {
    apply_rules: false,
    fire_webhooks: false,
    transactions: [update],
  };
  const res = await api(`/transactions/${txId}`, { method: 'PUT', body: JSON.stringify(body) });

  // Read-back verification (money-grade destructive write): a 200 is weaker evidence
  // than the stored result. Confirm the split now has the intended type AND destination
  // before the caller counts it done; on mismatch, throw so the caller reports it.
  const split = await getSplit(txId, journalId);
  const gotType = String(split?.type || '').toLowerCase();
  const gotDest = split?.destination_id != null ? String(split.destination_id) : null;
  if (gotType !== wantType || gotDest !== String(destinationId)) {
    throw new Error(
      `convertInternalLeg verification failed for tx ${txId}/${journalId}: type=${gotType || '(none)'}, destination=${gotDest || '(none)'} (wanted ${wantType} -> ${destinationId})`
    );
  }
  return res;
}

export { TAG_DONE, TAG_REVIEW };
