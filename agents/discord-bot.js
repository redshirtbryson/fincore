// discord-bot: always-on PM2 process. Connects outbound to Discord's gateway
// (no inbound port needed) and resolves the "ask" messages agent-daily posts.
// A button click or a "cat <txId> <journalId> <category>" reply writes the category
// to Firefly and creates a merchant rule so the model is not consulted for it again.
import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import * as firefly from './lib/firefly.js';
import { CATEGORY_SET, CATEGORIES, detectIncomeSource } from './lib/categories.js';

const CHANNEL = process.env.DISCORD_FINANCE_CHANNEL_ID;

// Command authorization (SPEC section 11): only allowlisted Discord user ids may
// trigger writes. Fail closed: with no allowlist configured, every write is rejected.
const ALLOWED_USERS = new Set(
  (process.env.DISCORD_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function isAuthorized(userId) {
  return ALLOWED_USERS.has(String(userId));
}

const DENIED = 'Not authorized to categorize. This bot only accepts writes from its allowlisted user.';

// Audit store, opened once at startup. The store is a native addon; if it is
// unavailable the bot still works and says so, rather than dying on import.
let auditStore = null;
let storeLib = null;
try {
  storeLib = await import('./lib/store.js');
  auditStore = storeLib.openStore();
} catch (e) {
  console.warn('fincore.db unavailable; confirmations will not be audited:', e.message);
}

// SPEC section 15: confirmed actions land in the audit log too. Loud on failure,
// never blocking the write the user asked for.
function auditConfirmation({ userId, txId, journalId, category, before, incomeSource }) {
  if (!auditStore) return;
  try {
    storeLib.audit(auditStore, {
      actor: `discord:${userId}`,
      action: 'transaction.categorize.confirmed',
      target: `firefly:tx:${txId}:${journalId}`,
      before: { category: before ?? null },
      after: { category, incomeSource },
      reversalHandle: storeLib.reversalHandleFor('firefly_transaction', `${txId}:${journalId}`, {
        category: before ?? null,
      }),
    });
  } catch (e) {
    console.warn('audit write failed:', e.message);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed for reply-parse fallback
  ],
});

// Resolve a transaction: set category, create a learning rule, report back.
// One split fetch serves the tag merge, the rule token, and income-source detection.
async function resolve({ txId, journalId, category, userId }) {
  const s = await firefly.getSplit(txId, journalId);
  if (!s) throw new Error(`transaction ${txId} split ${journalId} not found`);

  // The counterparty is the destination for money out, the source for money in.
  // Using the wrong side would mint a rule keyed on the user's own account name.
  const isDeposit = s.type === 'deposit';
  const counterparty = (isDeposit ? s.source_name : s.destination_name) || '';

  // Deterministic, list-bound payer detection (never model output, never free text).
  const incomeSource =
    category === 'Income' ? detectIncomeSource(counterparty, s.description) : null;

  await firefly.applyConfirmed(txId, journalId, category, {
    incomeSource,
    knownTags: s.tags || [],
  });
  auditConfirmation({ userId, txId, journalId, category, before: s.category_name || null, incomeSource });
  await firefly.createDescriptionRule({
    merchant: counterparty,
    description: s.description || '',
    category,
    // Policy tags ride on the rule too, so recurring matches that never reach the
    // agent again still get tagged (reimbursable, income-source).
    extraTags: firefly.extraTagsFor(category, incomeSource),
  });
}

client.once(Events.ClientReady, (c) => {
  console.log(`fincore discord-bot online as ${c.user.tag}`);
});

// Button clicks
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!isAuthorized(interaction.user.id)) {
    await interaction.reply({ content: DENIED, ephemeral: true }).catch(() => {});
    return;
  }
  const parts = interaction.customId.split('|');
  const kind = parts[0];

  try {
    if (kind === 'cat') {
      const [, txId, journalId, category] = parts;
      if (!CATEGORY_SET.has(category)) {
        await interaction.reply({ content: `Unknown category: ${category}`, ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      await resolve({ txId, journalId, category, userId: interaction.user.id });
      await interaction.editReply({
        content: `Categorized as **${category}** and saved a rule for this merchant.`,
        embeds: interaction.message.embeds,
        components: [], // remove buttons once resolved
      });
    } else if (kind === 'other') {
      const [, txId, journalId] = parts;
      await interaction.reply({
        content: `Reply in this channel with: \`cat ${txId} ${journalId} <Category>\`\nAllowed: ${CATEGORIES.join(', ')}`,
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
  if (!isAuthorized(message.author.id)) {
    await message.reply(DENIED).catch(() => {});
    return;
  }
  const [, txId, journalId, catRaw] = m;
  const category = catRaw.trim();
  if (!CATEGORY_SET.has(category)) {
    await message.reply(`Unknown category: ${category}. Allowed: ${CATEGORIES.join(', ')}`);
    return;
  }
  try {
    await resolve({ txId, journalId, category, userId: message.author.id });
    await message.reply(`Categorized as **${category}** and saved a rule.`);
  } catch (e) {
    await message.reply(`Error: ${e.message}`);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
