// Discord message helpers used by agent-daily to post asks and heartbeats.
// Uses @discordjs/rest so the short-lived job never opens a gateway connection.
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

let restClient = null;
function rest() {
  if (!restClient) {
    restClient = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  }
  return restClient;
}

// Button component style + type constants (raw API values).
const TYPE_ACTION_ROW = 1;
const TYPE_BUTTON = 2;
const STYLE_PRIMARY = 1;
const STYLE_SECONDARY = 2;

// custom_id format: cat|<txId>|<journalId>|<category>. Discord caps custom_id at 100
// chars. Never truncate: a cut category would parse as a different (or unknown)
// category on click. If it does not fit, return null and the caller drops the button;
// the Other (reply) path still covers that category.
export function catButton(txId, journalId, category, primary = false) {
  const customId = `cat|${txId}|${journalId}|${category}`;
  if (customId.length > 100) return null;
  return {
    type: TYPE_BUTTON,
    style: primary ? STYLE_PRIMARY : STYLE_SECONDARY,
    label: category.slice(0, 80),
    custom_id: customId,
  };
}

// Firefly amounts arrive as long-precision strings ('12.340000000000'); render as
// money, falling back to the raw string when unparseable rather than hiding it.
export function formatAmount(amount, currency) {
  // A missing amount must read as missing, not as a fabricated $0.00
  // (Number(null) and Number('') are both 0).
  if (amount === null || amount === undefined || String(amount).trim() === '') {
    return `n/a${currency ? ` ${currency}` : ''}`;
  }
  const n = Number(amount);
  const rendered = Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(amount);
  return `${rendered}${currency ? ` ${currency}` : ''}`;
}

export function buildAsk(item, guess) {
  const cats = [guess.category, ...guess.alternatives].filter(
    (c, i, arr) => c && arr.indexOf(c) === i
  ).slice(0, 3);

  const buttons = cats
    .map((c, i) => catButton(item.tx_id, item.journal_id, c, i === 0))
    .filter(Boolean);
  buttons.push({
    type: TYPE_BUTTON,
    style: STYLE_SECONDARY,
    label: 'Other (reply)',
    custom_id: `other|${item.tx_id}|${item.journal_id}`,
  });

  const direction = item.type === 'deposit' ? 'Deposit from' : 'Merchant';
  const embed = {
    title: 'Categorize this transaction',
    color: 0xe0a500,
    fields: [
      { name: direction, value: (item.merchant || item.description || 'unknown').slice(0, 200), inline: false },
      { name: 'Amount', value: formatAmount(item.amount, item.currency), inline: true },
      { name: 'Date', value: item.date || 'n/a', inline: true },
      { name: 'Account', value: item.account || 'n/a', inline: true },
      { name: 'Best guess', value: `${guess.category} (${Math.round(guess.confidence * 100)}%)`, inline: false },
    ],
    footer: { text: `tx ${item.tx_id}` },
  };

  return {
    embeds: [embed],
    components: [{ type: TYPE_ACTION_ROW, components: buttons }],
  };
}

// The daily heartbeat as a sectioned embed instead of a wall of bare text. Pure;
// exported for tests. Lines starting with known prefixes get grouped; the color
// reflects whether anything needs attention.
export function buildHeartbeat(text) {
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  const first = lines.shift() ?? '';
  const attention = lines.some((l) => /failed|STALE|flag|skipped|drift/i.test(l)) || /failed/i.test(first);
  // The title comes from the message itself (Fincore daily, Fincore backup, ...);
  // hardcoding one job's name would mislabel the others' failures.
  const titleMatch = first.match(/^(Fincore [a-z]+)\b:?\s*/i);
  const embed = {
    title: titleMatch ? titleMatch[1] : 'Fincore',
    description: [titleMatch ? first.slice(titleMatch[0].length) : first, ...lines.map((l) => `- ${l}`)]
      .filter((l) => l.trim() !== '')
      .join('\n')
      .slice(0, 4000),
    color: attention ? 0xe0a500 : 0x2e8b57,
  };
  return { embeds: [embed] };
}

function send(body) {
  return rest().post(Routes.channelMessages(process.env.DISCORD_FINANCE_CHANNEL_ID), { body });
}

export async function sendAsk(item, guess) {
  return send(buildAsk(item, guess));
}

export async function sendHeartbeat(text) {
  return send(buildHeartbeat(text));
}
