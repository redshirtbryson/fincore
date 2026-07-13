# Fincore agents

The net-new code for the fincore personal finance assistant. A scheduled job with an external prompt, a per-run cap, tag-based idempotency, Discord for the human-in-the-loop ask, and a SQLite store carrying memory, outcomes, the baseline, and the audit log. Reads and writes Firefly III over its REST API.

Style note: plain prose, no em-dashes.

## What runs

- `fincore-daily` (PM2 cron, runs each morning and exits): pulls new transactions, sends the residue Firefly could not auto-categorize to Claude Haiku, auto-applies confident answers, posts an ask to Discord when unsure, and (once the baseline is locked) appends today's net worth and DTI to the series.
- `fincore-discord-bot` (PM2 always-on): connects outbound to the Discord gateway, so no inbound port is needed. Catches button clicks and `cat ...` replies, writes the category to Firefly, and creates a merchant rule so that merchant never needs the model again.
- `npm run onboard` (one-time, rerunnable): the SPEC 10.4 onboarding wizard. Seeds income sources, paystub templates, obligations, goals, constraints, tax and autonomy config, then previews and locks the day-one baseline.
- `npm run snapshot` (on demand): computes and persists today's net worth + DTI row with full flag detail.

## The store (fincore.db)

`lib/store.js` owns a single SQLite file (better-sqlite3, WAL). Tables per SPEC 10.3: goals, constraints, decisions, recommendations, preferences, nw_dti_series, value_created, paystubs, positions, audit_log, feed_freshness, credit_score (V2 stub), plus obligations (DTI numerator: debt minimums and housing; Firefly has no minimum-payment field), income_sources, and the durable notification_queue. Schema migrates via `PRAGMA user_version` on open, so prod picks up schema changes on pull + restart.

Baseline rules (SPEC section 20): locks only on explicit confirmation in onboarding; a 30-day correction window allows late-found accounts to adjust it (audited); frozen after. Nothing snapshots the series before the baseline exists. Every consequential write lands in `audit_log` with before/after.

The deterministic engines are pure and tested: `lib/networth.js` (Firefly accounts + Schwab positions, no overlap by design, flag-don't-guess on dirty inputs) and `lib/dti.js` (back-end DTI including housing, cadence scaling at 26/12 for biweekly, partial-history blend of observed months with declared amounts, basis always reported). `lib/outcomes.js` is the thin I/O glue.

## Quality passes (Phase 4)

Three more pure engines protect the headline numbers, orchestrated by `lib/quality.js` inside the daily run:

- `lib/matching.js`: transfer and reimbursement matching. Own-account transfer pairs (equal amount, small date window) are tagged `transfer-match:*` and categorized Transfer so they stop double-counting as expense plus income; reimbursable outlays get netted against their payback via `reimbursed`/`reimbursement-match:*` tags. Conservative: only pairs unique on both sides auto-match, ambiguity is reported, and a side already carrying a different category is never overwritten.
- `lib/freshness.js`: true upstream freshness per bank account (newest imported transaction date, not API reachability). Stale feeds surface in the heartbeat and on every snapshot row, so a dead SimpleFIN token cannot silently freeze the picture.
- `lib/reconcile.js`: computed net worth vs Firefly's own summary figure, and payroll deposits vs the in-effect paystub template (drift is the signal to upload a new stub, SPEC 10.9).

Calibration note: the matcher ships conservative and untuned. After the 90-day backfill, review the ambiguous counts and the `transfer-match` results against real SimpleFIN data before widening any window or tolerance.

## Schwab (two channels, one automated)

Net worth takes Schwab BALANCES from the SimpleFIN oracle (`schwab` in `VALUATION_ACCOUNT_MATCH`): fully automated, no token ritual, the headline number can never go stale because of Schwab OAuth.

Position-level DETAIL (for Phase 11 analytics: TLH candidates, allocation drift, concentration) comes from the Trader API via a Python sidecar (`../schwab/`, schwab-py owns the OAuth). Setup, once and then whenever the token lapses:

```
python3 -m venv ../schwab/.venv
../schwab/.venv/bin/pip install -r ../schwab/requirements.txt
# fill SCHWAB_APP_KEY / SCHWAB_APP_SECRET in .env, then, on a machine with a browser:
npm run schwab-auth
```

Schwab expires refresh tokens every 7 days by policy. When it lapses, the daily heartbeat notes that position detail is paused (net worth unaffected) and names the command; renew whenever convenient. Positions ingest replace-by-day into the `positions` table and are deliberately excluded from the net worth sum.

## Backups (Phase 4)

- `fincore-backup` (PM2 cron, daily 6:30): copies fincore.db to `FINCORE_BACKUP_DIR` via the SQLite online backup API, verifies integrity, rotates to `FINCORE_BACKUP_KEEP` copies. Point the directory off this host.
- The Firefly MariaDB backs up on the LXC with `firefly-stack/backup-firefly-db.sh` (see that README for cron and restore steps).
- `HEALTHCHECK_PING_URL` (optional): agent-daily pings an off-host dead man's switch after each run, covering host-level outages nothing on this box can report.

## How the categorization split works

1. On import, the Firefly III rules engine categorizes everything it has a rule for. This is deterministic and free.
2. `fincore-daily` looks at withdrawals and deposits in the lookback window that have no category and are not already tagged `ai-categorized` or `needs-review`. Deposits are included so income can be recognized and tagged by source (`income-source:blenko` and so on); Business Expense outlays are tagged `reimbursable` for the later matching pass.
3. Those go to Haiku in capped, chunked batches with retry and backoff; a failing chunk is skipped and reported rather than sinking the run. Each result has a category, a confidence, up to two alternatives, and an income source for recognizable payers.
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
5. Put your own user id in `DISCORD_ALLOWED_USER_IDS` (right-click your profile, Copy User ID). The bot rejects categorization commands from anyone not on this list, and the list defaults to empty, so writes are disabled until you set it.

## Install and run

```
cp .env.example .env      # then fill in values, chmod 600 .env
npm install
npm test                  # pure-helper tests, no network or keys needed
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
- `CATEGORIZE_CHUNK_SIZE` (default 15): transactions per model call.
- `LOOKBACK_DAYS` (default 30): how far back to scan for uncategorized items.
- `CATEGORIZER_MODEL`: Haiku model string.
- `TAG_DONE` / `TAG_REVIEW` / `RULE_GROUP_TITLE`: Firefly markers and the rule group name.
- `DISCORD_ALLOWED_USER_IDS`: comma-separated user ids allowed to trigger writes. Empty means all writes rejected.
- `IMPORTER_URL` / `IMPORTER_AUTOIMPORT_SECRET` / `IMPORTER_AUTOIMPORT_DIR`: optional, pull new bank data before categorizing via the importer's autoimport endpoint (needs the matching env on the importer container; see `firefly-stack/README.md`). Leave blank to run imports from the importer UI or its own cron instead.

## Notes and things to verify

- Firefly API shapes in `lib/firefly.js` follow the v6 API. If your Firefly version differs, check `{FIREFLY_III_URL}/api/v1/documentation` and adjust the transaction update and rule payloads.
- `deriveMerchantToken` in `lib/firefly.js` strips trailing store numbers so rules are not too narrow. Tune it if rules come out too broad or too specific.
- The categorizer prompt lives in `prompts/categorizer.md` and can be edited without redeploying. The category taxonomy and known income sources live in `lib/categories.js` (the bot, the daily agent, and model-output validation all read it); keep the prompt's allowed list in sync with it.
- This layer is read-plus-categorize only. It never moves money. Reports, debt, and investment agents are later phases.
