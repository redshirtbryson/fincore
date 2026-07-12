# Fincore agents (Phase 2: daily categorizer + Discord ask loop)

The net-new code for the fincore personal finance assistant. Mirrors the Gmail AI filter agent: a scheduled job with an external prompt, a per-run cap, tag-based idempotency, and Discord for the human-in-the-loop ask. Reads and writes Firefly III over its REST API.

Style note: plain prose, no em-dashes.

## What runs

- `fincore-daily` (PM2 cron, runs each morning and exits): pulls new transactions, sends the residue Firefly could not auto-categorize to Claude Haiku, auto-applies confident answers, and posts an ask to Discord when unsure.
- `fincore-discord-bot` (PM2 always-on): connects outbound to the Discord gateway, so no inbound port is needed. Catches button clicks and `cat ...` replies, writes the category to Firefly, and creates a merchant rule so that merchant never needs the model again.

## How the categorization split works

1. On import, the Firefly III rules engine categorizes everything it has a rule for. This is deterministic and free.
2. `fincore-daily` only looks at withdrawals in the lookback window that have no category and are not already tagged `ai-categorized` or `needs-review`.
3. Those go to Haiku in one capped batch. Each result has a category, a confidence, and up to two alternatives.
4. Confidence at or above `CONFIDENCE_THRESHOLD` is applied and tagged `ai-categorized`.
5. Below the threshold, the transaction is tagged `needs-review` and posted to Discord with buttons for the best guess plus alternatives, and an Other (reply) button.
6. When you answer, the bot sets the category, clears `needs-review`, tags `ai-categorized`, and creates a `description_contains -> set_category` rule in Firefly. Next time that merchant is deterministic and never hits the model. This is the learning cache, and it is why the running cost trends down.

## Prerequisites

- The Firefly III stack from `fincore-firefly-stack` up and reachable, with a Personal Access Token.
- Node 18+ on the PM2 host (global fetch is used).
- A Discord bot and a finance channel (below).

## Discord bot setup

1. In the Discord Developer Portal, create an application, add a Bot, and copy the bot token into `DISCORD_BOT_TOKEN`.
2. Enable the Message Content Intent for the bot (needed for the `cat ...` reply fallback). Buttons alone do not need it, but the fallback does.
3. Invite the bot to your server with the `bot` scope and permissions to view the channel and send messages.
4. Put the finance channel id in `DISCORD_FINANCE_CHANNEL_ID` (enable Developer Mode in Discord, right-click the channel, Copy ID).

## Install and run

```
cp .env.example .env      # then fill in values, chmod 600 .env
npm install
npm run health            # confirms Firefly URL + PAT work
pm2 start ecosystem.config.cjs
pm2 save
```

Trigger a manual daily run any time:

```
npm run daily
```

## Config knobs (.env)

- `CONFIDENCE_THRESHOLD` (default 0.80): auto-apply cutoff.
- `CATEGORIZE_CAP` (default 40): max transactions sent to the model per run.
- `LOOKBACK_DAYS` (default 30): how far back to scan for uncategorized items.
- `CATEGORIZER_MODEL`: Haiku model string.
- `TAG_DONE` / `TAG_REVIEW` / `RULE_GROUP_TITLE`: Firefly markers and the rule group name.
- `IMPORTER_AUTOIMPORT_URL` / `IMPORTER_AUTOIMPORT_SECRET`: optional, pull new bank data before categorizing. Leave blank to run imports from the importer UI or its own cron instead.

## Notes and things to verify

- Firefly API shapes in `lib/firefly.js` follow the v6 API. If your Firefly version differs, check `{FIREFLY_III_URL}/api/v1/documentation` and adjust the transaction update and rule payloads.
- `deriveMerchantToken` in `lib/firefly.js` strips trailing store numbers so rules are not too narrow. Tune it if rules come out too broad or too specific.
- The categorizer prompt lives in `prompts/categorizer.md` and can be edited without redeploying. Keep the allowed category list in the prompt in sync with the `ALLOWED` set in `discord-bot.js`.
- This layer is read-plus-categorize only. It never moves money. Reports, debt, and investment agents are later phases.
