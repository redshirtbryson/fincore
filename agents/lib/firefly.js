// Firefly III REST client (v6 API). Plain fetch, bearer PAT.
// Payload shapes follow the documented v6 API. If your Firefly version differs,
// verify against {FIREFLY_III_URL}/api/v1/documentation.
import 'dotenv/config';

const BASE = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
const PAT = process.env.FIREFLY_III_PAT;
const TAG_DONE = process.env.TAG_DONE || 'ai-categorized';
const TAG_REVIEW = process.env.TAG_REVIEW || 'needs-review';
const RULE_GROUP_TITLE = process.env.RULE_GROUP_TITLE || 'AI Categorized';

function headers() {
  return {
    Authorization: `Bearer ${PAT}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, { ...opts, headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Firefly ${opts.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function about() {
  const j = await api('/about');
  return j?.data;
}

// Return one item per uncategorized withdrawal split within the lookback window,
// skipping anything already tagged done or review.
export async function getTransactionsNeedingReview({ lookbackDays = 30, cap = 40 } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const items = [];
  let page = 1;
  const maxPages = 20; // safety bound
  while (page <= maxPages && items.length < cap) {
    const j = await api(
      `/transactions?type=withdrawal&start=${startStr}&end=${endStr}&limit=50&page=${page}`
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
    page += 1;
  }
  return items;
}

async function getSplit(txId, journalId) {
  const j = await api(`/transactions/${txId}`);
  const splits = j?.data?.attributes?.transactions || [];
  return splits.find((s) => String(s.transaction_journal_id) === String(journalId)) || splits[0];
}

// Set category on a split and adjust its tag set. Firefly replaces the tag array
// on update, so we read current tags first and merge.
export async function setCategory(txId, journalId, categoryName, { addTags = [], removeTags = [] } = {}) {
  const split = await getSplit(txId, journalId);
  const current = new Set(split?.tags || []);
  for (const t of addTags) current.add(t);
  for (const t of removeTags) current.delete(t);

  const body = {
    apply_rules: false,
    fire_webhooks: false,
    transactions: [
      {
        transaction_journal_id: String(journalId),
        category_name: categoryName,
        tags: Array.from(current),
      },
    ],
  };
  return api(`/transactions/${txId}`, { method: 'PUT', body: JSON.stringify(body) });
}

export async function markReview(txId, journalId) {
  return setCategory(txId, journalId, null, { addTags: [TAG_REVIEW] }).catch(async () => {
    // category_name null may be rejected on some versions; fall back to tags-only update.
    const split = await getSplit(txId, journalId);
    const current = new Set(split?.tags || []);
    current.add(TAG_REVIEW);
    const body = {
      apply_rules: false,
      fire_webhooks: false,
      transactions: [{ transaction_journal_id: String(journalId), tags: Array.from(current) }],
    };
    return api(`/transactions/${txId}`, { method: 'PUT', body: JSON.stringify(body) });
  });
}

// Apply a confirmed answer: set category, mark done, clear review.
export async function applyConfirmed(txId, journalId, categoryName) {
  return setCategory(txId, journalId, categoryName, {
    addTags: [TAG_DONE],
    removeTags: [TAG_REVIEW],
  });
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

// Create a description_contains -> set_category rule so this merchant is
// categorized deterministically next time and never hits the model again.
export async function createDescriptionRule({ merchant, description, category }) {
  const token = deriveMerchantToken({ merchant, description });
  if (!token) return null;
  const ruleGroupId = await ensureRuleGroup();
  const body = {
    title: `AI: ${token} -> ${category}`.slice(0, 100),
    rule_group_id: ruleGroupId,
    trigger: 'store-journal',
    active: true,
    strict: false,
    stop_processing: false,
    triggers: [{ type: 'description_contains', value: token, stop_processing: false, active: true }],
    actions: [{ type: 'set_category', value: category, stop_processing: false, active: true }],
  };
  return api('/rules', { method: 'POST', body: JSON.stringify(body) });
}

export { TAG_DONE, TAG_REVIEW };
