# Fincore: Firefly III stack (Dockge)

Self-hosted ledger for the fincore personal financial assistant. Firefly III plus MariaDB plus the Firefly III Data Importer, managed as one Dockge stack on the existing Docker LXC. Bank feeds come from SimpleFIN. Categorization, reports, and recommendations are added later by the PM2 agent layer, which talks to Firefly III over its API.

Style note: plain prose, no em-dashes.

## Files

- `compose.yaml` : the three services (db, core, importer).
- `.env.example` : copy to `.env` and fill in. Dockge manages this file per stack.

## Prerequisites

- The existing Docker LXC with Dockge.
- A SimpleFIN Bridge account with your institutions connected (checking, savings, cards, and any investment or retirement accounts SimpleFIN supports at that institution). SimpleFIN is read-only and costs a few dollars a year.

## Setup order (the sequencing matters)

There is a chicken-and-egg step: the importer needs a Firefly III access token that does not exist until Firefly III is running and you create it. So bring the stack up in two passes.

### Pass 1: core and database

1. In Dockge, create a new stack (for example `fincore-firefly`), paste `compose.yaml`, and create the `.env` from `.env.example`.
2. Generate the app key (exactly 32 characters):
   ```
   head /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32; echo
   ```
   Put it in `APP_KEY`. Set `APP_URL` to the address you will actually browse to. Set the database passwords. Leave `FIREFLY_III_ACCESS_TOKEN` and `SIMPLEFIN_TOKEN` blank for now.
3. Start the stack. The importer may error or restart while the token is blank; that is fine for this pass.
4. Browse to `APP_URL`, register the first (admin) user, and set your primary currency.

### Pass 2: token, SimpleFIN, importer

5. In the Firefly UI, go to Options > Profile > OAuth > Personal Access Tokens and create a token. Copy the full value into `FIREFLY_III_ACCESS_TOKEN` in the stack `.env`.
6. In SimpleFIN, generate a claim token, then exchange it for the long-lived access URL. Note: the claim token is single use and is consumed on first exchange. Either exchange it in the importer UI (next step) or store the resulting access URL in `SIMPLEFIN_TOKEN`.
7. Restart the stack in Dockge so the importer picks up both values.

## First import (do this carefully once)

Open the importer UI at `http://<lxc>:${IMPORTER_PORT}` and start a SimpleFIN import.

1. Set Duplicate Detection to content-based, not the default identifier-based. This is the single most common misconfiguration. SimpleFIN does not always send stable transaction identifiers, so identifier-based detection silently skips most transactions and you end up importing only a handful out of hundreds. Content-based matches on amount, date, and description.
2. Map each SimpleFIN account to a Firefly III account, and set the correct Firefly account type before importing:
   - checking and savings : asset accounts
   - credit cards : liability accounts (credit card type)
   - loans : liability accounts, and record the interest rate (minimum payments are captured at onboarding into the fincore store; Firefly has no native field for them)
   - brokerage or retirement accounts : do NOT map these. Schwab owns investment value in net worth (SPEC section 20); mapping them here too would double count. Deselect them in the importer configuration.
3. Set opening balances via the API formula so balances reconcile from day one (see the Firefly III importer docs on opening balances).
4. Run the import and spot-check that the count looks right.

## Ongoing imports

The import trigger is owned by the daily agent (`agent-daily`) in the fincore agent layer, which POSTs the importer's autoimport endpoint each morning before it categorizes. For that to work, set `CAN_POST_AUTOIMPORT=true` and a 16+ character `AUTO_IMPORT_SECRET` in the stack `.env`, and place your saved import config JSON files in the `firefly-import` volume (mounted at `/import`); the same values go in the agent `.env`. Note the trigger is fire-and-forget: the import runs asynchronously, so transactions it pulls may only be categorized on the next daily pass; the agent's lookback window absorbs that. You can also run imports manually from the importer UI at any time, or skip the trigger entirely and run the importer on its own cron.

## What the agents expect from this stack

- A reachable Firefly III API at `APP_URL` with a valid Personal Access Token.
- Liability accounts carrying the APR for the debt module (minimum payments are captured into the fincore store at onboarding).
- Piggy banks for goals (created later, one per North Star goal).
- Budgets per category for the overspend checks.

## Backups and restore

Run `backup-firefly-db.sh` on this LXC via cron (see the header of the script). It dumps MariaDB from the db container with a consistent snapshot, gzips, verifies, and rotates. Point `BACKUP_DIR` at a mount that leaves the LXC.

Restore procedure (test this once BEFORE you need it, per SPEC section 11):

1. Stop the stack in Dockge (or `docker compose stop firefly-iii firefly-importer`).
2. `gunzip -c /mnt/backups/firefly/firefly-YYYY-MM-DD.sql.gz | docker exec -i fincore-firefly-db mariadb -u<user> -p<pass> firefly`
3. Start the stack, log in, spot-check recent transactions and account balances.
4. For fincore.db: stop the PM2 agents, copy the dated backup over `agents/fincore.db`, restart, run `npm run snapshot` and confirm the series and baseline look right.

## Upgrades

Deliberately, never by tracking `latest` (the agents do automated writes against the API, so versions are pinned via `FIREFLY_VERSION` and `IMPORTER_VERSION` in the stack `.env`). To upgrade: snapshot the LXC, bump the version tag in `.env`, recreate through Dockge, and re-test the agent write payloads against a throwaway transaction. Read the Firefly III upgrade notes if the major version changes.

## Health check

- Core UI loads at `APP_URL`.
- Importer UI loads at `IMPORTER_PORT`.
- A manual SimpleFIN import creates transactions in Firefly III.
- `GET {APP_URL}/api/v1/about` with the PAT as a bearer token returns version info (quick way for the agents to confirm connectivity).
