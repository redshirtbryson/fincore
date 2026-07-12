# fincore

Self-hosted, instructable personal financial assistant. Firefly III for the cash-and-debt ledger, Schwab for investments, a deterministic modeling layer for the math, Claude agents on top, and Discord as the interaction surface. Runs on the existing Proxmox homelab.

Scope is strictly personal finances. Blenko, Redshirt Cloud, and Neptune Political are income sources that feed it, not businesses it keeps books for. It reads the full personal picture, answers questions, makes changes on instruction with confirmation, tracks paystubs and withholdings, recommends debt paydown, forecasts interest, and summarizes investments.

## Start here

- `SPEC.md` is the full architecture and phase plan. Read it first.
- `CLAUDE.md` is the project instruction file for Claude Code (conventions, current state, guardrails, where to start).

## Layout

- `firefly-stack/` : Dockge compose stack (Firefly III + MariaDB + Data Importer). Paste into Dockge; setup in its README.
- `agents/` : the Node agent layer under PM2. Phase 2 (daily categorizer + Discord ask loop) is built and runnable; setup in its README.

## Status

Built: the Firefly stack, the Phase 2 categorizer with the Discord ask loop, and the Phase 3 memory and outcomes store (fincore.db with audit log, net worth and DTI engines with money-grade tests, the onboarding wizard, and the day-one baseline lock with a 30-day correction window).

Next: reliability and data quality (Phase 4), the paystub tracker (Phase 5), then the remaining engines (debt, cash-flow, allocation, tax), the anomaly and savings watcher, the investment brain, the interactive assistant, graduated autonomy with audit and undo, and the outcomes scorecard that proves net worth and DTI movement. Full plan in `SPEC.md` section 18.

## Conventions

Plain prose, no em-dashes. Prebuilt-first. Deterministic math in code, model on top. Discord only. Plain `.env` secrets, never committed. Full detail in `CLAUDE.md`.
