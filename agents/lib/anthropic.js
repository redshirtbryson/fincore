// Haiku categorizer via the official Anthropic SDK.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CATEGORIZER_MODEL || 'claude-haiku-4-5-20251001';

export function loadPrompt() {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', 'categorizer.md'), 'utf8');
}

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');
  const slice = start >= 0 && endIdx >= 0 ? cleaned.slice(start, endIdx + 1) : cleaned;
  return JSON.parse(slice);
}

// items: [{tx_id, description, merchant, amount, currency, date, account}]
// returns: [{tx_id, category, confidence, alternatives:[]}]
export async function categorizeBatch(items) {
  if (items.length === 0) return [];
  const system = loadPrompt();
  const payload = items.map((i) => ({
    tx_id: i.tx_id,
    description: i.description,
    merchant: i.merchant,
    amount: i.amount,
    currency: i.currency,
    date: i.date,
    account: i.account,
  }));

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });

  const text = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const parsed = extractJson(text);
  // normalize
  return parsed.map((p) => ({
    tx_id: String(p.tx_id),
    category: p.category || 'Uncategorized',
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    alternatives: Array.isArray(p.alternatives) ? p.alternatives.slice(0, 2) : [],
  }));
}
