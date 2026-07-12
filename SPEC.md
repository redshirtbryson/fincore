# Fincore: Personal Financial Assistant

## Claude Code Handoff Spec (v4.2)

Owner: Bryson
Prepared for: Claude Code
Style rule for all generated docs and code comments: plain prose, no em-dashes.

Changelog v4.2 (sanity pass): recorded three decided defaults in section 20: Schwab owns investment and retirement value in net worth (SimpleFIN does not map brokerage into Firefly), back-end DTI includes the housing obligation (rent counts even though it is not a liability), and DTI's trailing 12-month income average falls back to available history plus onboarding-declared amounts until 12 months accrue. Added a liability-terms convention (Firefly has no native minimum-payment field), pay cadence as a stored paystub field (10.9), deletion of the Discord paystub upload after parsing (10.9), a durable quiet-hours queue (13), and an off-host dead-man heartbeat (13). Clarified that Phase 2 categorization is not value-attributed action (18).

Changelog v4.1: added the assumptions and decisions section (20) recording accepted defaults for transaction rewrites, baseline lock, time zone and periods, cost ceiling, notifications, history window, and refresh cadence; made hardening a hard rule (11); documented the DTI formula (10.5); pinned the Firefly image versions; and stubbed credit score as a deferred V2 signal (10.3, 10.14).

Changelog v4: clarified scope to personal finances only (section 2); Blenko, Redshirt Cloud, and Neptune Political are income sources, not businesses this app accounts for. Added a paystub and withholding tracker with reconciliation (10.9), a detailed onboarding conversation (10.4), and a consolidated reliability, security, and data-quality section (11) covering feed freshness, backups, transfer and reimbursement handling, reconciliation, prompt-injection defense, command authorization, and graceful degradation. Added honest investment opportunities (TLH, idle cash, concentration) and in-period discipline nudges. Reworked the phase plan.

Changelog v3: added the intelligence and outcomes layer, tied success to net worth and DTI, added memory, anomaly watcher, allocation planner, cash-flow forecaster, tax set-aside, graduated autonomy, and the scorecard.

---

## 0. TL;DR for the implementer

An instructable personal financial assistant whose job is to make Bryson measurably better off, judged by net worth up and DTI down over a period of use. It reads the full personal picture, answers questions, acts on instruction, notices things unprompted, plans across competing goals, tracks paychecks down to the withholding, and proves its own value against a day-one baseline.

Four layers: prebuilt backbone (Firefly III, SimpleFIN), a deterministic modeling layer (all the math), an intelligence layer (memory, anomaly watcher, allocation planner, outcomes engine), and the model layer (Claude agents and the assistant). The model is reasoning glue, not the source of the intelligence.

Build order in section 18. Onboard and lock the baseline before anything acts.

---

## 1. Definition of success

Over a defined period, produce a tangible, attributable increase in net worth and improvement in DTI, and show the work.

Headline metrics, time series from day one: net worth (assets minus liabilities, including investments, retirement contributions, and manually tracked assets) and DTI (monthly debt obligations over gross monthly income, irregular deposits handled as discrete events).

Value created, logged conservatively: savings found (cancelled or renegotiated subscriptions, caught duplicate or erroneous charges, reversed hikes), interest avoided (extra principal versus minimum-only baseline), discipline gains (sustained category reductions versus baseline).

Honesty rules (non-negotiable): count only benefits Bryson confirms he acted on; never attribute investment market gains to the assistant; under-claim. A self-flattering scorecard is worse than none.

---

## 2. Scope: personal finances only

Fincore is solely Bryson's personal finances. Blenko Glass, Redshirt Cloud, and Neptune Political are income sources that feed his personal accounts. They are not businesses this app keeps books for, and it never touches their operational accounting. Blenko's books stay in QuickBooks. Business bookkeeping for any entity is explicitly out of scope.

From the personal side, the app tracks:
- Income received from each source, tagged by source, as it lands in personal accounts.
- The gross-to-net breakdown of W-2 style pay (taxes, healthcare, retirement, other withholdings) via the paystub tracker (10.9).
- A tax set-aside for self-employment or owner income that arrives without withholding (10.10).

Working assumption, to confirm in onboarding:
- Blenko: W-2 employment income with withholdings on a paystub; deposits arrive net.
- Redshirt Cloud and Neptune Political: self-employment or owner income arriving without withholding; the set-aside applies.

If a personal outlay happens to be business-related (for example software Bryson pays for personally), it is still a personal cash flow here, optionally flagged reimbursable so the later payback is matched and not double-counted (section 11). The app does not decide deductibility; that is the entity's bookkeeping.

---

## 3. Goals

Each serves the two headline metrics.

1. Categorize transactions, ask when unsure. [Shipped.]
2. Show where every dollar goes and flag overspending.
3. Answer questions and make instructed changes, with confirmation.
4. See investment history, summarize, and surface honest opportunities to decide on.
5. Track DTI and recommend how much debt to pay and when.
6. Forecast interest under paydown strategies and model rate scenarios.
7. Onboard goals as a North Star with periodic review.
8. Remember decisions, constraints, and outcomes over time.
9. Notice problems and opportunities unprompted.
10. Plan allocation across competing objectives.
11. Forecast near-term cash flow and liquidity given lumpy income.
12. Track paystubs and withholdings, and reconcile the gross-to-net picture into the total.
13. Set aside for taxes on income that arrives without withholding.
14. Prove value: baseline, trend, value-created ledger, and scorecard.

---

## 4. Guiding principles

A. Prebuilt first. Firefly feature, then a maintained library or MCP server, then custom code. Do not reinvent a ledger, dedup, rules table, or bank OAuth.

B. Deterministic math in code, model on top. Every figure behind a recommendation or metric comes from a pure, unit-tested function. The model calls the engine, then explains, adapts, and acts.

C. Measure and attribute honestly. Baseline before acting. Log value only when confirmed and acted on. Never claim market gains. Under-claim.

---

## 5. Architecture overview

```
   Firefly III  <-- SimpleFIN + Data Importer (personal bank/card/loan feeds)
        ^  (ledger: transactions, accounts, budgets, liabilities, piggy banks, manual assets)
        |  REST API (full read + write, PAT)
        v
   +----------------------------------------------------------------+
   |  fincore layer (PM2, Node)                                     |
   |                                                                |
   |  Store  fincore.db (SQLite):                                   |
   |    memory (goals, constraints, decisions, preferences),        |
   |    outcomes (nw + dti series, value-created ledger),           |
   |    paystubs, positions, audit log, feed-freshness              |
   |                                                                |
   |  Deterministic engines (pure, unit-tested):                    |
   |    debt/forecast · cash-flow · allocation · tax · paystub      |
   |    reconciliation · investment analytics · net-worth + DTI     |
   |                                                                |
   |  Intelligence: onboarding · anomaly + savings watcher ·        |
   |    outcomes engine (baseline, trend, scorecard)                |
   |                                                                |
   |  Agents: categorizer [shipped] · deposit watcher ·             |
   |    weekly P&L · monthly review · scorecard · freshness guard    |
   |                                                                |
   |  Interactive assistant (Sonnet, tool use): answers, plans,     |
   |    acts with graduated autonomy + audit + undo                 |
   |                                                                |
   |  discord-bot (always-on): asks, alerts (tiered), confirms, chat |
   +----------------------------------------------------------------+
        |                         |                     |
        v                         v                     v
   Schwab Trader API        Anthropic API          Discord
   (positions/history,      (Haiku/Sonnet)         (interaction surface)
    read-only)
```

Firefly is the source of truth for personal cash and debt. Schwab for investments. fincore.db for memory, outcomes, paystubs, and the audit trail.

---

## 6. Component inventory

| Component | Role | Source | Build vs pull |
|---|---|---|---|
| Firefly III | Personal ledger, budgets, liabilities, piggy banks, manual assets, reports | https://github.com/firefly-iii/firefly-iii | Pull |
| Firefly III Data Importer | SimpleFIN into Firefly | https://github.com/firefly-iii/data-importer | Pull |
| SimpleFIN Bridge | Read-only personal bank/card/loan feeds | https://beta-bridge.simplefin.org | Pull |
| Firefly III MCP server | Optional Claude Desktop access | https://github.com/przbadu/firefly-iii-mcp-server | Pull |
| schwab-py | Schwab Trader API client | https://github.com/alexgolec/schwab-py | Pull |
| Schwab read-only MCP | Optional chat-with-brokerage | https://github.com/acidsolution/schwab-mcp-server | Pull |
| agents/ (this repo) | Store, engines, intelligence, agents, assistant, bot | This repo | Build |

---

## 7. Topology (Dockge stack plus PM2 agents)

Firefly runs as a Dockge stack on the existing Docker LXC (internal, no inbound exposure). Agents run under PM2, reaching Firefly over HTTP. Stack in `firefly-stack/`. Create the PAT after core is up, then start the importer.

---

## 8. Data ingestion

SimpleFIN feeds the Data Importer into Firefly. Exchange the single-use claim token; set Duplicate Detection to content-based; map accounts and set opening balances. Daily imports. Each feed's last-seen timestamp is recorded for freshness guarding (section 11). Plaid is a per-institution fallback.

---

## 9. Firefly III as the personal ledger

Firefly primitives, not custom schema. Rules engine for known merchants. Liability accounts carry the APR; minimum payments and rent-like obligations live in the `obligations` table (section 20), since Firefly has no native minimum-payment field. Piggy banks are goals. Budgets drive overspend. Manual asset accounts hold off-feed holdings (section 19). Income transactions are tagged by source (Blenko, Redshirt Cloud, Neptune Political). A full-scope PAT authenticates everything; section 15 governs its use.

---

## 10. The agent, engine, and intelligence layer

### 10.1 Shared conventions

Node under PM2. Haiku (`claude-haiku-4-5-20251001`) for categorization, Sonnet (`claude-sonnet-5`) for reasoning, the assistant, and narration. External prompts. Plain `.env`. `ecosystem.config.cjs` holds no secrets. Firefly tags mark processed items. Discord heartbeat per scheduled run.

### 10.2 Agent A: daily categorizer (Haiku) [shipped]

In `agents/`. Categorizes the residue Firefly's rules miss, asks on Discord below threshold, creates a rule on confirm. The prompt is personal-only and tags income by source; it also runs a transfer and reimbursable pass (section 11) so intra-account moves and paybacks are flagged, not miscounted.

### 10.3 Memory and outcomes store (foundational)

Single SQLite `fincore.db`. Tables: `goals`, `constraints`, `decisions`, `recommendations`, `preferences`, `nw_dti_series`, `value_created`, `paystubs` (10.9), `positions` (10.11), `audit_log` (section 15), `feed_freshness` (section 11), and `credit_score` (a deferred V2 stub: schedule the table and a manual monthly entry point now, chart it in the scorecard later; not built in v1). Build early; the baseline must exist before anything acts. Every agent reads relevant memory before reasoning and writes decisions and outcomes back.

### 10.4 Onboarding conversation

A guided, conversational setup the assistant runs once and can rerun to update. It interviews Bryson to seed memory, configure the system, and lock the baseline, so day one is warm rather than empty. Steps:

1. Income sources and tax treatment. Enumerate each source (Blenko as W-2, Redshirt Cloud and Neptune Political as self-employment or owner income), its cadence and rough amount, and whether it is withheld or needs a set-aside. Confirm the personal-only scope: these are income sources, not businesses to account for.
2. Paystub setup. For each W-2 source, Bryson uploads a current paystub (PDF or image) in Discord; the assistant parses it, shows the fields to confirm, and stores it as the current template with an effective date (gross, federal, state, and local tax, Social Security and Medicare, healthcare premium, retirement contribution, other deductions, net pay). He uploads a new one only when something changes; see 10.9.
3. Accounts. Confirm the connected accounts and identify off-feed assets to track manually: cash, PayPal or Venmo, crypto, the Pokemon card collection as a valued asset, and any private holdings, with a revaluation cadence for the illiquid ones.
4. Debts. Confirm each liability and set its APR and minimum payment. The debt engine is only as good as these.
5. Goals. Capture North Star goals with target amounts and dates, mapped to piggy banks and memory.
6. Constraints and priorities. Liquid minimum, do-not-touch accounts, risk posture, and the priority order across goals and debts.
7. Tax config. Filing status context, the effective set-aside rate (CPA-confirmed), and the quarterly schedule.
8. Autonomy and authorization. The dollar threshold and low-risk allowlist for autonomous writes, and the Discord user id allowlist for who may instruct writes.
9. Historical backfill. Pull roughly 90 days from SimpleFIN and categorize historically to seed rules and an initial trend.
10. Baseline lock. Review the computed day-one net worth and DTI, correct anything, and lock it as the "before" for all future measurement.

Output: memory seeded, templates and config set, baseline locked. Stored in `fincore.db` and rerunnable.

### 10.5 Debt and forecast engine

`lib/debt-engine.js`, pure, tested. DTI, per-debt amortization, avalanche and snowball with interest saved versus minimum-only, marginal interest saved per dollar, lump-sum allocation, and scenario rate projection (rate change as an assumption, forward path never a prediction). The model explains and adapts; it does not compute.

DTI is defined explicitly, because it is a headline metric and easy to compute a plausible non-standard number. Use back-end DTI: total monthly debt obligations over gross monthly income. The numerator includes the housing obligation whether it is a mortgage payment or rent; rent is not a Firefly liability, so it is entered as a recurring obligation (see the liability-terms convention in section 20). Irregular income is annualized as a trailing 12-month average and divided to a monthly figure; until 12 months of history exist, use the average over available history seeded with the onboarding-declared amounts, and note the shorter basis wherever the figure is shown. W-2 gross comes from the paystub template scaled by its stored pay cadence (biweekly is 26 over 12, semimonthly is 2), not the net deposit. The formula and these choices are documented in the function and asserted in its tests.

### 10.6 Cash-flow and liquidity forecaster

`lib/cashflow.js`, pure, tested. From recurring bills, expected income timing including lumpy deposits, and current balances, project the near-term balance path and flag runway and shortfalls. Feeds the allocation planner so it never directs cash at debt that leaves Bryson short before the next deposit clears.

### 10.7 Anomaly and event watcher (savings finder)

Runs on each sync. Detectors: subscription price increase, duplicate charge, unusually large bill, new recurring charge, free trial about to convert, missing or late expected income, category on pace to exceed budget, unusual merchant or amount. Each detection writes to memory and posts a Discord alert (severity-tiered, section 13) with a suggested action; confirmed actions log to `value_created`. A direct, measurable savings engine.

### 10.8 Cross-domain allocation planner

`lib/allocation.js`, pure, tested. Optimizes available surplus across emergency fund, debts by APR, goals, investing, and tax set-aside, given the cash-flow forecast and Bryson's constraints and priorities from memory. Output: a recommended allocation with tradeoff rationale and projected net-worth and DTI impact. The core "where the next dollar goes" reasoning. Presented for confirmation.

### 10.9 Paystub and withholding tracker

`lib/paystub.js` plus the `paystubs` table. Purpose: make the gross-to-net story visible and reconcile it into the total picture, so taxes, healthcare, retirement, and other withholdings are not hidden inside a net deposit.

Data model. Each uploaded stub is stored as a template row with an `effective_from` date, a `pay_cadence` (weekly, biweekly, semimonthly, monthly; captured at onboarding, needed to scale per-stub gross to the monthly figures DTI and reporting use), and per-line fields: source, gross, federal_tax, state_tax, local_tax, fica_ss, fica_medicare, healthcare_premium, retirement_contribution, other_deductions (list), net_pay. A new upload supersedes the prior one from its effective date forward; historical periods keep using whichever template was in effect at the time, so the trend stays accurate across raises and benefits changes.

Entry model: upload and carry forward. Bryson uploads one stub at onboarding to seed the template, and a new stub only when something changes. There is no scheduled drafting and no pay-cadence guessing; uploads are the only push, and deposits define the rhythm.

1. Upload. Bryson drops a paystub PDF or image into the Discord channel.
2. Parse and confirm. The assistant extracts the fields and shows them for confirmation before writing. Never write a stub blind: layouts vary by payroll provider, and a wrong withholding figure would quietly corrupt the tax and net-worth picture. Where the format needs it, OCR first, then parse.
3. Carry forward. On confirm, the parsed stub becomes the current template with today's effective date. The uploaded file is not retained; only the extracted fields persist in `fincore.db`, since the document is sensitive and there is no reason to keep it. Not retained has to include Discord: the upload lives on Discord's CDN attached to the message, so after a confirmed parse the bot deletes the upload message (it needs the Manage Messages permission for this). Otherwise the retention claim is false in the place that matters.
4. Apply. Every payroll deposit after that is interpreted through the in-effect template without asking.

Reconciliation as the re-upload trigger. On each payroll deposit, compare the in-effect template's net pay to the actual deposit. If they match, stay silent. If they drift, ping Bryson ("your Blenko deposit came in 80 different from your paystub template; upload the new stub when you can"). That mismatch alert is what tells him to upload again, so the system notices the change rather than relying on him to remember.

Feeds the total picture:
- Gross-to-net visibility: percentage of gross going to taxes, healthcare, and retirement.
- Combined tax view: W-2 amounts already withheld combine with the self-employment set-aside (10.10) so the tax module does not double count and the true total tax burden is visible.
- Net worth: retirement contributions build assets, reconciled with the investment brain or a 401k account where visible, otherwise a manual retirement asset.
- Income accuracy: DTI and reporting know gross versus net.
- Healthcare visibility: the premium, combined with HSA or out-of-pocket from transactions, gives a healthcare spend view.

### 10.10 Tax module

`lib/tax.js`, pure, tested. Two parts, combined into one tax view:
- Withheld: reads paystub withholdings (10.9) so W-2 tax already paid is accounted for.
- Set-aside: on each classified income arrival from a non-withheld source (Redshirt Cloud, Neptune Political), compute a set-aside at the configurable effective rate and maintain a running reserve plus quarterly estimated-payment dates and reminders.

Advisory only. It computes and reminds; the rate is CPA-confirmed; it never files or pays.

### 10.11 Investment brain (Schwab-fed)

Via schwab-py (read-only): positions, cost basis, market value, history, quotes, persisted to `positions`. Deterministic analytics in `lib/investment-analytics.js`: allocation, drift versus target, realized and unrealized gains, performance, dividend income, concentration flags.

Honest opportunities (not stock-picking): tax-loss-harvesting candidates (real dollars, relevant given the wheel activity), idle-cash detection (uninvested balances that should be deployed or swept to higher yield), and concentration-risk flags. Confirmed, acted-on TLH savings can log to `value_created`. The model summarizes and surfaces options; Bryson decides. Read-only in fincore; execution stays in the wheel app.

### 10.12 Interactive assistant

A conversational Sonnet agent (tool use) in the Discord channel. Tools: Firefly read and confirmation-gated write, the engines (debt, cash-flow, allocation, tax, paystub), investment analytics, Schwab read, and memory. It reads freely, calls engines for any number it cites, proposes changes and requests confirmation before writing (per autonomy tiers, section 15), and records decisions to memory. Command authorization and prompt-injection defenses in section 11 apply.

### 10.13 Deposit watcher (inside agent-daily)

Flags irregular non-withheld inflows, calls the tax module for the set-aside, then the allocation planner for the rest, and posts a Discord recommendation to confirm or adjust. Logs to memory.

### 10.14 Reporting: weekly, monthly, and the outcomes scorecard

- Weekly (Sonnet): P&L and overspend to Discord; snapshot the nw and dti series. In-period discipline nudges, not just retrospective totals (section 13). No NAS, no recurring xlsx; on-demand export only.
- Monthly (Sonnet): holistic brief with goals, debt trajectory and next step, investment drift, gross-to-net and tax posture, and recurring overspend.
- Outcomes scorecard: periodic Discord report showing net worth then versus now, DTI then versus now, cumulative value created, and on-track or off-track. The proof artifact. Attribution follows section 1. V2: add credit score as a third proof-of-progress signal once the deferred `credit_score` stub is wired to a manual monthly entry.

### 10.15 Goal-to-component map

| Goal | Component | Where |
|---|---|---|
| Categorize, ask | Firefly rules + Haiku | 10.2 (shipped) |
| Where every dollar goes | Budgets + reports | 10.14 |
| Ask, instructed changes | Assistant | 10.12 |
| Investment history and opportunities | Investment brain | 10.11 |
| DTI, how much and when | Debt engine | 10.5 |
| Interest forecasting | Debt engine | 10.5 |
| Goals North Star | Piggy banks + monthly | 10.14 |
| Memory | Memory store | 10.3 |
| Notice problems and savings | Anomaly watcher | 10.7 |
| Next dollar | Allocation planner | 10.8 |
| Cash flow and liquidity | Cash-flow forecaster | 10.6 |
| Paystub and withholdings | Paystub tracker | 10.9 |
| Tax set-aside | Tax module | 10.10 |
| Prove net worth and DTI | Outcomes engine + scorecard | 10.3, 10.14 |
| Warm start | Onboarding | 10.4 |

---

## 11. Reliability, security, and data quality

These are load-bearing for the accuracy of the two headline numbers. Build the first three early.

Feed freshness guarding. Record each feed's last-seen timestamp (`feed_freshness`). If a feed is stale beyond a threshold (for example no data from a bank in several days, or an expired Schwab or SimpleFIN token), flag it and refuse to present net worth or a recommendation as current without saying which inputs are stale. A confident answer over stale data is a failure.

Backups and recovery. Scheduled backup of `fincore.db` (baseline, memory, audit, value ledger) and the Firefly database, off the LXC. The outcomes store is irreplaceable: lose the baseline and the ROI claim is gone. Test the restore.

Transfers and reimbursements. A matching pass so money moving between Bryson's own accounts is not double counted as income plus expense, and so reimbursable outlays are netted when the payback arrives. Without this, DTI, P&L, and net worth drift. The categorizer runs this pass; the assistant and the reconciliation engine respect it.

Reconciliation. Periodically verify computed net worth against the summed account balances and flag drift, and verify paystub net against the observed deposit. Keeps a small feed error from silently compounding into a wrong picture.

Graceful degradation and hardening. This is a hard design rule for every script (engines, agents, assistant). Validate inputs before acting. Handle dirty or missing inputs (a liability with no APR, a zero-income month, negative balances) by flagging, not by producing a confident wrong number. Fail clean: never leave partial state. Process per item so one bad record does not sink a batch. Write to the store only after a successful parse or computation. On a model or API failure (down, rate-limited, malformed JSON), retry with backoff a couple of times, then skip and report in the heartbeat rather than half-processing. Every scheduled run is bounded by a per-run cap. See section 20 for the cost ceiling.

Prompt-injection defense. Merchant names, memos, and descriptions are semi-attacker-controllable text. Treat all ledger content as untrusted data, never as instructions. The categorizer and the assistant never let text found in a transaction drive a write or override their instructions.

Command authorization. Discord is a write-capable control surface. Allowlist Bryson's user id for anything that writes; the bot rejects write instructions from anyone else.

---

## 12. Wheel strategy boundary

The wheel app remains the system of record for options execution. fincore reads Schwab positions only. Pass signals through a shared store or event if needed. Execution stays isolated.

---

## 13. Discord surface

One channel, one always-on gateway bot (outbound, no inbound port). Uses: the ask loop (shipped), proactive anomaly alerts with severity tiers (high severity pings immediately, low severity rolls into a daily or weekly digest so the watcher does not become noise), recommendation and change confirmations, the conversational assistant, in-period discipline nudges (pre-committed targets with mid-period checks like "340 of 500 dining with 11 days left," which bends habits in a way retrospective totals do not), and the scorecard.

Notification boundaries. Proactive pushes respect quiet hours of 10pm to 7am local and queue into the 7am summary. The one exception that pings live overnight is a critical-severity anomaly (suspected fraud). Anything Bryson initiates, questions and confirmations, works any hour. The heartbeat is a single consolidated daily message, not one per agent. The quiet-hours queue is durable (a table in `fincore.db`), not bot memory, so a restart during the night does not drop queued alerts.

Bot liveness. The gateway bot is the single point of failure for the interactive surface. PM2 auto-restarts it. As a cross-check, the bot posts a daily online ping, and the daily agent (which posts through Discord's REST independently of the gateway) raises an alert if that ping is missing, so a bot outage surfaces even though the bot is what is down. That cross-check only covers the bot process; if the PM2 host or LXC is down, both halves are silent. Close that with an off-host dead man's switch: the daily agent pings an external or other-node heartbeat monitor (healthchecks.io style, or a cron on another homelab node) that alerts when the ping stops.

---

## 14. Secrets and config

Plain `.env` files, `chmod 600`, restricted directories. Firefly stack `.env` in `firefly-stack/.env.example`; agent `.env` in `agents/.env.example`. `ecosystem.config.cjs` holds no secret values.

---

## 15. Graduated autonomy, audit, and undo

Tiers:
- Autonomous: routine categorization by threshold, plus a low-risk allowlist below a dollar threshold (piggy-bank target, note, tag). Acts, then logs.
- Confirm: every other write (recategorize a material transaction, edit a budget, update a liability's terms, create a transaction, direct a deposit, confirm a paystub delta) requires a per-change Discord confirmation from the allowlisted user.
- Never: move money, pay bills, transfer, place or modify trades. Not built.

Audit log: every action, autonomous or confirmed, appended to `audit_log` with timestamp, actor, action, before and after, and a reversal handle where reversible.

Undo: an `undo <action-id>` Discord command reverses a logged, reversible action from the stored prior value.

Calibration: track predicted versus realized (paydown savings, categorizer confidence versus correctness) to justify widening the autonomous tier and to surface overconfidence.

---

## 16. Capability matrix

| Action | Posture |
|---|---|
| Read any Firefly, Schwab, paystub, and memory data | Full, always |
| Categorize, tag, create rules | Autonomous by threshold |
| Low-risk writes below the dollar threshold | Autonomous, logged |
| Material writes, deposit direction, paystub confirmation | On instruction, Discord confirmation, allowlisted user |
| Recommend paydown, forecast, allocation, set-aside | Engine-computed, presented for confirmation |
| Recommend on investments (incl. TLH, idle cash) | Analysis and options to decide on |
| Flag anomalies and savings | Autonomous, proactive, tiered |
| Report net worth, DTI, value created | Autonomous, conservative attribution, stale inputs flagged |
| Business accounting for Blenko, Redshirt, Neptune | No. Out of scope. Income sources only |
| Move money, pay, transfer, trade | No. Not built |

---

## 17. Guardrails

- Personal finances only. No business bookkeeping for any entity (section 2).
- Writes are tiered (section 15). No autonomous money movement or trades.
- Deterministic math, not model guesses. If it cannot be computed, say so.
- Never present stale data as current (section 11).
- Ledger text is untrusted data, never instructions (section 11).
- Forward rate movement is scenario, not prediction.
- Tax is advisory; the rate is CPA-confirmed; it never files or pays.
- Investment and material debt moves are advice to confirm. Not a financial advisor, and it says so when it matters.
- Honest attribution (section 1). Confirmed, acted-on value only. Never claim market gains. Under-claim.
- Data egress: send the minimum each model call needs.

---

## 18. Build phases

Phase 1: Foundation. Firefly stack, SimpleFIN, dedup, import, PAT. (Bryson.)
Phase 2: Categorization. [Shipped.] Update the prompt to personal-only, income-source tagging, and the transfer and reimbursable pass.
Phase 3: Memory and outcomes store, onboarding conversation, and baseline lock. Nothing acts before the baseline exists. (Phase 2 categorization runs before the baseline by design; it is data hygiene, not value-attributed action, and nothing it does is claimed in the value ledger.)
Phase 4: Reliability and data quality. Feed freshness guarding, backups and restore, transfer and reimbursement matching, reconciliation. Early, because these protect the two headline numbers.
Phase 5: Paystub and withholding tracker, with reconciliation to deposits.
Phase 6: Debt and forecast engine (with tests). Wire the deposit watcher.
Phase 7: Cash-flow and liquidity forecaster.
Phase 8: Anomaly and savings watcher, with severity tiers.
Phase 9: Cross-domain allocation planner.
Phase 10: Tax module (withheld view plus self-employment set-aside, combined).
Phase 11: Investment brain, with TLH, idle-cash, and concentration.
Phase 12: Interactive assistant, with command authorization and prompt-injection defense.
Phase 13: Graduated autonomy, audit, and undo.
Phase 14: Reporting, scorecard, and in-period discipline nudges.
Phase 15: Completeness (manual assets) and the correctness harness.

Tests are money-grade and written with each engine, not deferred.

---

## 19. Completeness and correctness

Completeness. Net worth and advice are only as good as what is tracked. Add manual asset and liability accounts for what SimpleFIN does not see: cash, PayPal or Venmo, crypto, the Pokemon card collection, private holdings, and retirement balances not otherwise visible. The assistant updates these on instruction.

Correctness. Money-grade unit tests for every engine (debt, cash-flow, allocation, tax, paystub, net-worth and DTI, reconciliation, outcomes attribution) and regression tests for the categorizer. Wrong financial math is worse than none. Built alongside each engine.

---

## 20. Assumptions and decisions (accepted defaults)

Recorded so Code is not silently guessing. These are decided; change them deliberately.

Foundation:
- Transaction identity and rewrites. A transaction's identity is its Firefly id; the `ai-categorized` tag and stored category live on it. When an import updates an existing transaction, re-evaluate only on a material change (amount, or description past a similarity threshold, for example a resolved merchant name). Leave a note when the system changes its own prior categorization. Never overwrite a hand-confirmed category; user confirmations always win.
- Baseline lock. The baseline does not lock at the end of onboarding. It locks only after Bryson explicitly confirms accounts, debts with APRs, and manual assets are all in. A one-time 30-day correction window lets a later-found account retroactively adjust the baseline rather than appear as a fake gain. Frozen after the window.
- Time zone and periods. Everything uses America/New_York. A day rolls at local midnight, a month is the calendar month in local time, a week is Monday to Sunday (matching the Sunday P&L), quarterly tax dates follow the IRS calendar.
- Investment value ownership. Schwab owns investment and retirement account value in net worth. Brokerage and retirement accounts are NOT mapped into Firefly via SimpleFIN; Firefly stays cash and debt, the `positions` store carries investment value, and the net-worth engine sums Firefly balances plus Schwab positions plus manual assets with no overlap. Retirement balances not visible at Schwab are manual asset accounts, and paystub retirement contributions reconcile against whichever of those holds the balance rather than being added on top.
- DTI numerator and the liability-terms convention. Back-end DTI includes the housing obligation (mortgage payment or rent). Firefly liability accounts have no native minimum-payment field, so debt terms (minimum payment, and rent or similar recurring non-debt obligations that belong in the DTI numerator) live in an `obligations` table in `fincore.db` keyed by Firefly account id where one applies, seeded at onboarding and edited via confirmed writes. APR stays on the Firefly liability.
- DTI income basis with partial history. The trailing 12-month average uses available history seeded with onboarding-declared amounts until 12 real months accrue; any figure computed on a shorter basis says so.

Reliability and cost:
- Hardening is a hard rule for all scripts (section 11): validate inputs, fail clean with no partial writes, per-item processing, retry with backoff then skip-and-report, per-run caps.
- Cost ceiling. A soft monthly API budget with a Discord warning at 80 percent, not a hard cutoff that would disable the assistant mid-thought. Haiku categorization is cheap; Sonnet reasoning and the assistant are where cost concentrates.
- Firefly version pinning. The compose pins `fireflyiii/core` and `fireflyiii/data-importer` to explicit version tags via `FIREFLY_VERSION` and `IMPORTER_VERSION` in the stack `.env`, not `latest`, because the system does automated writes. Upgrade deliberately: snapshot, bump the tag, re-test the write payloads.

Interaction:
- Notification boundaries. Proactive pushes queue during quiet hours 10pm to 7am local; critical-severity fraud alerts are the only live overnight exception; user-initiated messages work any hour; one consolidated daily heartbeat (section 13).
- Conversational history. The assistant reads recent Discord channel history for short-term context, bounded to roughly the last 30 messages or 24 hours to control token cost. Durable items (decisions, preferences) go to memory, not scrollback.
- Refresh cadence. Schwab positions and balances refresh once daily after market close (about 5pm ET) plus on demand; quotes are fetched only for a specific question, never polled. Bank feeds are daily.

Scope assumptions:
- Single user. Bryson's personal finances only. The partner's finances, including Barboursville Massage, are out of scope; combining later is a redesign, not a toggle. Currency is USD-only.

Deferred to V2:
- Credit score. Stub the `credit_score` table and a manual monthly entry point now; wire the monthly capture and add it to the scorecard as a third proof-of-progress signal later. Checking one's own score is a soft pull and never affects it, so monthly monitoring is harmless; the open question is only the source (manual entry versus an API like Array or MeasureOne), left for later.

---

## 21. Open decisions for Bryson

1. Measurement horizon defining success (for example 90-day and 12-month scorecards).
2. Income treatment confirmation: Blenko W-2 (paystub) and Redshirt and Neptune non-withheld (set-aside)? Any exceptions.
3. Tax effective set-aside rate, pending CPA confirmation.
4. Target allocation for investment drift.
5. Retirement accounts: at Schwab (detailed) or elsewhere (balances only), and whether the 401k is visible to reconcile contributions.
6. Autonomy thresholds and the low-risk write allowlist; the Discord user id allowlist.
7. Constraints to seed into memory (liquid minimum, do-not-touch accounts, priorities).
8. Manual assets to track and revaluation cadence for the illiquid ones.
