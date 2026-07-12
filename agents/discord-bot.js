// discord-bot: always-on PM2 process. Connects outbound to Discord's gateway
// (no inbound port needed) and resolves the "ask" messages agent-daily posts.
// A button click or a "cat <txId> <category>" reply writes the category to Firefly
// and creates a merchant rule so the model is not consulted for it again.
import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import * as firefly from './lib/firefly.js';

const CHANNEL = process.env.DISCORD_FINANCE_CHANNEL_ID;
const ALLOWED = new Set([
  'Housing', 'Utilities', 'Groceries', 'Dining', 'Transport', 'Software/SaaS',
  'Business Expense', 'Income', 'Transfer', 'Debt Payment', 'Investment',
  'Healthcare', 'Entertainment', 'Personal', 'Uncategorized',
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed for reply-parse fallback
  ],
});

// Resolve a transaction: set category, create a rule, report back.
async function resolve({ txId, journalId, category }) {
  await firefly.applyConfirmed(txId, journalId, category);
  // Fetch merchant/description for the rule from the live transaction.
  const tx = await fetchTx(txId);
  const s = pickSplit(tx, journalId);
  await firefly.createDescriptionRule({
    merchant: s?.destination_name || '',
    description: s?.description || '',
    category,
  });
}

async function fetchTx(txId) {
  const base = (process.env.FIREFLY_III_URL || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v1/transactions/${txId}`, {
    headers: { Authorization: `Bearer ${process.env.FIREFLY_III_PAT}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`fetch tx ${txId} -> ${res.status}`);
  return res.json();
}

function pickSplit(txJson, journalId) {
  const splits = txJson?.data?.attributes?.transactions || [];
  return splits.find((s) => String(s.transaction_journal_id) === String(journalId)) || splits[0];
}

client.once(Events.ClientReady, (c) => {
  console.log(`fincore discord-bot online as ${c.user.tag}`);
});

// Button clicks
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split('|');
  const kind = parts[0];

  try {
    if (kind === 'cat') {
      const [, txId, journalId, category] = parts;
      if (!ALLOWED.has(category)) {
        await interaction.reply({ content: `Unknown category: ${category}`, ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      await resolve({ txId, journalId, category });
      await interaction.editReply({
        content: `Categorized as **${category}** and saved a rule for this merchant.`,
        embeds: interaction.message.embeds,
        components: [], // remove buttons once resolved
      });
    } else if (kind === 'other') {
      const [, txId, journalId] = parts;
      await interaction.reply({
        content: `Reply in this channel with: \`cat ${txId} ${journalId} <Category>\`\nAllowed: ${[...ALLOWED].join(', ')}`,
        ephemeral: true,
      });
    }
  } catch (e) {
    console.error('interaction error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

// Reply-parse fallback:  cat <txId> <journalId> <Category words>
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL) return;
  const m = message.content.trim().match(/^cat\s+(\d+)\s+(\d+)\s+(.+)$/i);
  if (!m) return;
  const [, txId, journalId, catRaw] = m;
  const category = catRaw.trim();
  if (!ALLOWED.has(category)) {
    await message.reply(`Unknown category: ${category}. Allowed: ${[...ALLOWED].join(', ')}`);
    return;
  }
  try {
    await resolve({ txId, journalId, category });
    await message.reply(`Categorized as **${category}** and saved a rule.`);
  } catch (e) {
    await message.reply(`Error: ${e.message}`);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
