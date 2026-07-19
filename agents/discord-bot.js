// discord-bot: always-on PM2 process. Connects outbound to Discord's gateway
// (no inbound port needed) and resolves the "ask" messages agent-daily posts.
// A button click or a "cat <txId> <journalId> <category>" reply writes the category
// to Firefly and creates a merchant rule so the model is not consulted for it again.
import 'dotenv/config';
import { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as firefly from './lib/firefly.js';
import { CATEGORY_SET, CATEGORIES, detectIncomeSource } from './lib/categories.js';
import { tidyMoney } from './lib/format.js';

// Queue-post presentation: severity emoji + tidied money (stored messages may
// predate the formatting fix and carry long-precision amounts).
const SEVERITY_EMOJI = { confirm: '🔔', error: '🚨' };
function renderNotification(n) {
  const emoji = SEVERITY_EMOJI[n.severity] || 'ℹ️';
  return `${emoji} ${tidyMoney(n.message)}\n-# \`#${n.id}\``;
}

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
let undoLib = null;
let undoExec = null;
let qualityLib = null;
try {
  storeLib = await import('./lib/store.js');
  auditStore = storeLib.openStore();
  undoLib = await import('./lib/undo.js');
  undoExec = await import('./lib/undo-exec.js');
  qualityLib = await import('./lib/quality.js');
} catch (e) {
  console.warn('fincore.db / undo machinery unavailable; confirm/undo disabled:', e.message);
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

// --- Phase 13: notification queue consumer -----------------------------------
// The daily passes queue durable items (confirm-tier pairs, influx splits, flags);
// this poller posts undelivered ones to the finance channel with buttons. Executable
// payloads (kind 'transfer-pair') get Confirm/Dismiss; everything else, Acknowledge.

const POLL_MS = 5 * 60 * 1000;

function buttonsFor(n) {
  const payload = n.payload_json ? JSON.parse(n.payload_json) : null;
  const row = new ActionRowBuilder();
  if (payload?.kind === 'transfer-pair') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`nq-confirm|${n.id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`nq-dismiss|${n.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary)
    );
  } else {
    row.addComponents(new ButtonBuilder().setCustomId(`nq-ack|${n.id}`).setLabel('Acknowledge').setStyle(ButtonStyle.Secondary));
  }
  return row;
}

async function deliverQueued() {
  if (!auditStore || !CHANNEL) return;
  try {
    const pending = storeLib.undeliveredNotifications(auditStore, { limit: 5 });
    if (!pending.length) return;
    const channel = await client.channels.fetch(CHANNEL);
    for (const n of pending) {
      await channel.send({ content: renderNotification(n), components: [buttonsFor(n)] });
      storeLib.markNotificationDelivered(auditStore, n.id);
    }
  } catch (e) {
    console.warn('notification delivery failed:', e.message);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`fincore discord-bot online as ${c.user.tag}`);
  deliverQueued();
  setInterval(deliverQueued, POLL_MS);
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
    } else if (kind === 'nq-confirm' || kind === 'nq-dismiss' || kind === 'nq-ack') {
      // Phase 13: resolve a queued notification. Confirm on an executable payload
      // runs the pending action through the SAME machinery the autonomous path uses
      // (convertPairToTransfer: audited, read-back-verified) — the human supplies
      // only the judgment the gate refused to automate.
      if (!auditStore) { await interaction.reply({ content: 'Store unavailable.', ephemeral: true }); return; }
      const nid = Number(parts[1]);
      const n = storeLib.getNotification(auditStore, nid);
      if (!n) { await interaction.reply({ content: `Notification #${nid} not found.`, ephemeral: true }); return; }
      if (n.resolution) { await interaction.reply({ content: `#${nid} already resolved (${n.resolution}).`, ephemeral: true }); return; }
      await interaction.deferUpdate();
      const actor = `discord:${interaction.user.id}`;
      if (kind === 'nq-confirm') {
        const payload = n.payload_json ? JSON.parse(n.payload_json) : null;
        if (payload?.kind === 'transfer-pair') {
          const liabilities = await firefly.getAccounts('liabilities');
          const liabilityIds = new Set(liabilities.map((a) => String(a.id)));
          await qualityLib.convertPairToTransfer(auditStore, payload.m, { actor, liabilityIds });
        }
        storeLib.resolveNotification(auditStore, nid, 'confirmed', { actor });
        await interaction.editReply({ content: `✅ ${tidyMoney(n.message)}\n-# \`#${nid}\` · confirmed — executed and audited`, components: [] });
      } else {
        storeLib.resolveNotification(auditStore, nid, kind === 'nq-dismiss' ? 'dismissed' : 'acknowledged', { actor });
        await interaction.editReply({ content: `${kind === 'nq-dismiss' ? '🚫' : '☑️'} ${tidyMoney(n.message)}\n-# \`#${nid}\` · ${kind === 'nq-dismiss' ? 'dismissed' : 'acknowledged'}`, components: [] });
      }
    } else if (kind === 'undo-run') {
      if (!auditStore || !undoExec) { await interaction.reply({ content: 'Undo machinery unavailable.', ephemeral: true }); return; }
      const auditId = Number(parts[1]);
      await interaction.deferUpdate();
      const entry = undoExec.loadAuditEntry(auditStore, auditId);
      const plan = entry ? undoLib.planReversal(entry) : null;
      if (!entry || !plan?.reversible) {
        await interaction.editReply({ content: `Cannot undo #${auditId}: ${plan ? plan.describe : 'audit entry not found'}`, components: [] });
        return;
      }
      const res = await undoExec.executeReversal({ firefly, store: storeLib }, auditStore, entry, plan, { actor: `discord:${interaction.user.id}` });
      await interaction.editReply({ content: `Undone action #${auditId} (${entry.action}). ${res.opsExecuted} operation(s) reversed; new audit #${res.auditId}.`, components: [] });
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
// Phase 13 commands: `undo <audit-id>` and `pending`.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL) return;

  // `undo <audit-id>`: plan the reversal, show it, arm a confirm button. The
  // destructive execution only ever happens behind the button press.
  const undoMatch = message.content.trim().match(/^undo\s+(\d+)$/i);
  if (undoMatch) {
    if (!isAuthorized(message.author.id)) { await message.reply(DENIED).catch(() => {}); return; }
    if (!auditStore || !undoExec) { await message.reply('Undo machinery unavailable.'); return; }
    const auditId = Number(undoMatch[1]);
    const entry = undoExec.loadAuditEntry(auditStore, auditId);
    if (!entry) { await message.reply(`No audit action #${auditId}.`); return; }
    const plan = undoLib.planReversal(entry);
    if (!plan.reversible) { await message.reply(`Cannot auto-undo #${auditId} (${entry.action}): ${plan.describe}`); return; }
    const warn = plan.warnings?.length ? `\n⚠ ${plan.warnings.join(' ')}` : '';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`undo-run|${auditId}`).setLabel('Confirm undo').setStyle(ButtonStyle.Danger)
    );
    await message.reply({ content: `Undo #${auditId} (${entry.action}): ${plan.describe}${warn}`, components: [row] });
    return;
  }

  // `pending`: queue status at a glance.
  if (/^pending$/i.test(message.content.trim())) {
    if (!auditStore) { await message.reply('Store unavailable.'); return; }
    const un = auditStore.prepare('SELECT COUNT(*) n FROM notification_queue WHERE resolution IS NULL AND delivered_at IS NOT NULL').get().n;
    const und = auditStore.prepare('SELECT COUNT(*) n FROM notification_queue WHERE delivered_at IS NULL').get().n;
    await message.reply(`Queue: ${un} delivered awaiting resolution, ${und} not yet posted (next poll within 5 min).`);
    return;
  }

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
