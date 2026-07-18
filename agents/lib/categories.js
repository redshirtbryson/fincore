// Single source of truth for the category taxonomy and known income sources.
// The bot's buttons, the daily agent's auto-apply validation, and the model-output
// normalization all read from here; keep prompts/categorizer.md's list in sync.

export const CATEGORIES = [
  'Housing', 'Utilities', 'Groceries', 'Dining', 'Transport', 'Software/SaaS',
  'Business Expense', 'Income', 'Refunds', 'Transfer', 'Debt Payment', 'Taxes',
  'Investment', 'Healthcare', 'Entertainment', 'Personal', 'Uncategorized',
];

export const CATEGORY_SET = new Set(CATEGORIES);

// Canonical PERSONAL income sources with distinctive tokens for deterministic
// payer detection in ledger text. Each source may have several tokens because the
// deposit label rarely matches the friendly name (SPEC section 2, refined
// 2026-07-17): Redshirt Cloud pays into personal checking under its payroll entity
// "WV CSP LLC", so that string must map to Redshirt. Neptune Political is NOT a
// personal income source: it is a client of Redshirt (business-to-business,
// upstream of the personal account), so it never appears here.
export const INCOME_SOURCES = [
  { name: 'Blenko', tokens: ['blenko'] },
  { name: 'Redshirt Cloud', tokens: ['redshirt', 'wv csp', 'csp llc'] },
];

export const INCOME_SOURCE_NAMES = new Set(INCOME_SOURCES.map((s) => s.name));

// Deterministically match a known income source in payer/description strings.
// Returns the canonical name or null. Ledger text is untrusted; this only ever
// selects from the fixed list above, never invents a source.
export function detectIncomeSource(...strings) {
  const haystack = strings.filter(Boolean).join(' ').toLowerCase();
  for (const s of INCOME_SOURCES) {
    if (s.tokens.some((t) => haystack.includes(t))) return s.name;
  }
  return null;
}
