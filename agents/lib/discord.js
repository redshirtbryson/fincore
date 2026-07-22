// Discord message helpers used by agent-daily to post asks and heartbeats.
// Uses @discordjs/rest so the short-lived job never opens a gateway connection.
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { tidyMoney } from './format.js';

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

// Emoji per known line prefix, so the heartbeat scans as sections instead of a wall
// of uniform bullets. First match wins; unknown lines get a plain bullet. Ordered
// specific-before-general (e.g. 'Budgets OVER' before 'Budgets').
const LINE_EMOJI = [
  [/^(Snapshot|Net worth)/i, '📊'],
  [/^INFLUX/i, '💰'],
  [/^WINDFALL/i, '💰'],
  [/^Tax/i, '🧾'],
  [/^Debts|^Revolving/i, '💳'],
  [/^Budgets OVER/i, '🚨'],
  [/^Budget/i, '📉'],
  [/^Influx (watch|overdue)/i, '⏳'],
  [/^STRAGGLER|^Playbook flag: STRAGGLER/i, '🚨'],
  [/^Bills.*OVERDUE/i, '🚨'],
  [/^Bills/i, '📅'],
  [/^STALE|^Freshness/i, '⚠️'],
  [/^Matching flag|^Sync flag|^Valuations flag|^Loans flag|^Playbook flag|^Reconcile flag|^Schwab flag/i, '⚠️'],
  [/^Matching/i, '🔀'],
  [/^Sync/i, '🔄'],
  [/^Valuations/i, '💼'],
  [/^Loans/i, '🏦'],
  [/^Schwab/i, '📈'],
  [/^Reconcile/i, '🧮'],
  [/failed/i, '🚨'],
];

function emojiFor(line) {
  for (const [re, e] of LINE_EMOJI) if (re.test(line)) return e;
  return '•';
}

// Heartbeat lines group into visual paragraphs: data plumbing (sync, matching,
// valuations, loans), then the money plan (tax, influx, debts, budgets, bills),
// then account flags (Schwab), then the snapshot. A line that matches no rule
// inherits the section of the line above it, so unknown lines never force a break.
const SECTION_RULES = [
  [/^Snapshot/i, 'snapshot'],
  [/^(Tax|INFLUX|Influx|WINDFALL|Debts|Revolving|STRAGGLER|Straggler|Bills|Budget)/i, 'plan'],
  [/^(Schwab|Backup)/i, 'flags'],
];

function sectionOf(line, prev) {
  for (const [re, key] of SECTION_RULES) if (re.test(line)) return key;
  return prev ?? 'data';
}

// The daily heartbeat as a sectioned embed instead of a wall of bare text. Pure;
// exported for tests. Money strings are tidied at render time (the backstop for any
// long-precision Firefly amount that slipped into a composed line), each line gets a
// section emoji, blank lines separate the section groups, and the color reflects
// whether anything needs attention.
export function buildHeartbeat(text) {
  const raw = tidyMoney(text).split('\n').filter((l) => l.trim() !== '');
  const first = raw.shift() ?? '';
  // Two code paths (analytics + credential check) can both flag Schwab auth on the
  // same run; one nag is enough.
  let schwabFlagSeen = false;
  const lines = raw.filter((l) => {
    if (!/^Schwab flag:/i.test(l)) return true;
    if (schwabFlagSeen) return false;
    schwabFlagSeen = true;
    return true;
  });
  const attention = lines.some((l) => /failed|STALE|flag|skipped|drift|OVER|STRAGGLER/i.test(l)) || /failed/i.test(first);
  const body = [];
  let prev = null;
  for (const l of lines) {
    const sec = sectionOf(l, prev);
    if (prev !== null && sec !== prev) body.push('');
    body.push(`${emojiFor(l)} ${l}`);
    prev = sec;
  }
  // The title comes from the message itself (Fincore daily, Fincore backup, ...);
  // hardcoding one job's name would mislabel the others' failures.
  const titleMatch = first.match(/^(Fincore [a-z]+)\b:?\s*/i);
  const head = titleMatch ? first.slice(titleMatch[0].length) : first;
  const embed = {
    title: titleMatch ? titleMatch[1] : 'Fincore',
    description: [head, ...(head.trim() !== '' && body.length ? [''] : []), ...body]
      .filter((l, i, a) => l.trim() !== '' || (i > 0 && a[i - 1].trim() !== ''))
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
