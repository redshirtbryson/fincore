// Single source of truth for the category taxonomy and known income sources.
// The bot's buttons, the daily agent's auto-apply validation, and the model-output
// normalization all read from here; keep prompts/categorizer.md's list in sync.

export const CATEGORIES = [
  'Housing', 'Utilities', 'Groceries', 'Dining', 'Transport', 'Software/SaaS',
  'Business Expense', 'Income', 'Transfer', 'Debt Payment', 'Investment',
  'Healthcare', 'Entertainment', 'Personal', 'Uncategorized',
];

export const CATEGORY_SET = new Set(CATEGORIES);

// Canonical income sources (SPEC section 2) with distinctive tokens for
// deterministic payer detection in ledger text.
export const INCOME_SOURCES = [
  { name: 'Blenko', token: 'blenko' },
  { name: 'Redshirt Cloud', token: 'redshirt' },
  { name: 'Neptune Political', token: 'neptune' },
];

export const INCOME_SOURCE_NAMES = new Set(INCOME_SOURCES.map((s) => s.name));

// Deterministically match a known income source in payer/description strings.
// Returns the canonical name or null. Ledger text is untrusted; this only ever
// selects from the fixed list above, never invents a source.
export function detectIncomeSource(...strings) {
  const haystack = strings.filter(Boolean).join(' ').toLowerCase();
  for (const s of INCOME_SOURCES) {
    if (haystack.includes(s.token)) return s.name;
  }
  return null;
}
