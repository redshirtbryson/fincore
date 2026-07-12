// Haiku categorizer via the official Anthropic SDK.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORY_SET, INCOME_SOURCE_NAMES } from './categories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.CATEGORIZER_MODEL || 'claude-haiku-4-5-20251001';

// Lazy so importing this module (for its pure helpers, e.g. in tests) never
// requires an API key.
let clientInstance = null;
function client() {
  if (!clientInstance) clientInstance = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return clientInstance;
}

// Chunked so one model call never has to emit more JSON than fits its token budget;
// a truncated array would fail the whole parse. The env knob is validated: zero,
// negative, or non-numeric values would hang or silently no-op the run.
function resolveChunkSize() {
  const raw = Number(process.env.CATEGORIZE_CHUNK_SIZE || 15);
  if (!Number.isFinite(raw) || raw < 1 || raw > 50) {
    if (process.env.CATEGORIZE_CHUNK_SIZE !== undefined) {
      console.warn(`invalid CATEGORIZE_CHUNK_SIZE "${process.env.CATEGORIZE_CHUNK_SIZE}", using 15`);
    }
    return 15;
  }
  return Math.floor(raw);
}
const CHUNK_SIZE = resolveChunkSize();
const MAX_TOKENS_PER_ITEM = 130;
const BACKOFF_MS = [2000, 8000];
const RETRIES = BACKOFF_MS.length;

export function loadPrompt() {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', 'categorizer.md'), 'utf8');
}

export function chunk(arr, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');
  const slice = start >= 0 && endIdx >= 0 ? cleaned.slice(start, endIdx + 1) : cleaned;
  return JSON.parse(slice);
}

// Model output is untrusted: categories and income sources are clamped to the known
// lists. An invented category becomes Uncategorized at zero confidence so it routes
// to human review instead of silently minting a new Firefly category; an invented
// income source is dropped.
export function normalizeGuess(p) {
  const rawCategory = p.category || 'Uncategorized';
  const valid = CATEGORY_SET.has(rawCategory);
  return {
    tx_id: String(p.tx_id),
    journal_id: String(p.journal_id ?? ''),
    category: valid ? rawCategory : 'Uncategorized',
    confidence: valid && typeof p.confidence === 'number' ? p.confidence : 0,
    alternatives: (Array.isArray(p.alternatives) ? p.alternatives : [])
      .filter((c) => CATEGORY_SET.has(c))
      .slice(0, 2),
    income_source: INCOME_SOURCE_NAMES.has(p.income_source) ? p.income_source : null,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function categorizeChunk(items, system) {
  const payload = items.map((i) => ({
    tx_id: i.tx_id,
    journal_id: i.journal_id,
    type: i.type || 'withdrawal',
    description: i.description,
    merchant: i.merchant,
    amount: i.amount,
    currency: i.currency,
    date: i.date,
    account: i.account,
  }));

  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: Math.max(1000, items.length * MAX_TOKENS_PER_ITEM),
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });

  const text = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return extractJson(text).map(normalizeGuess);
}

// items: [{tx_id, journal_id, type, description, merchant, amount, currency, date, account}]
// returns: { guesses: [{tx_id, journal_id, category, confidence, alternatives, income_source}], errors: [string] }
// Per-chunk retry with backoff, then skip and report (SPEC section 11): one bad
// chunk drops those items from this run instead of sinking the batch.
export async function categorizeBatch(items) {
  if (items.length === 0) return { guesses: [], errors: [] };
  const system = loadPrompt();
  const guesses = [];
  const errors = [];

  for (const part of chunk(items, CHUNK_SIZE)) {
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        guesses.push(...(await categorizeChunk(part, system)));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < RETRIES) await sleep(BACKOFF_MS[attempt]);
      }
    }
    if (lastErr) {
      errors.push(`chunk of ${part.length} (first tx ${part[0].tx_id}) skipped: ${lastErr.message}`);
    }
  }
  return { guesses, errors };
}
