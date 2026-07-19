# FACTS.md — canonical household record

The single source of truth for household, entity, and tax-profile facts. Rules:

1. **This file wins.** If any other document, note, or model output conflicts with
   this file, this file is correct and the other is stale or hallucinated.
2. **Never restate — link.** Other docs reference this file; copying facts into
   prose creates drift.
3. **Change only on life events, via commit.** The git history of this file is the
   audit trail of the household's facts.
4. **No SSNs, no full account numbers.** Those stay in `tax-returns/` (gitignored,
   local only) and with the CPA.

## Household

| Person | Role | Born |
|---|---|---|
| Bryson R. Cutler | taxpayer | 1993-11-05 |
| Mikalia Cutler | spouse | 1995-01-17 |
| Maya Cutler | daughter, dependent | **2026-06-27** |

- Married: **2022-10-08**
- Filing status: **married filing jointly**
- Dependents: **Maya, from tax year 2026** (2025 return had none — she arrives on
  the 2026 return with the child tax credit)
- Tax household size for ACA/FPL purposes: **3** (from 2026)
- Address: 129 Jefferson Park Dr, Huntington, WV 25705
- Wife's separate bank accounts (CNB ...0619, ...0240) are **external to fincore**
  by explicit decision (2026-07-18); her finances may join later.

## Income sources & entities

| Entity | Who | Structure | Notes |
|---|---|---|---|
| Blenko Glass Co., Inc. | Bryson | W-2 employee (officer salary, weekly) | 401k deduction sized to max company match — do not "optimize" |
| WV CSP, LLC dba Redshirt Cloud | Bryson | single-member LLC, Schedule C (marketing/MSP) | lumpy owner draws ~5–6 wk cadence; Neptune Political is a CLIENT of Redshirt, not a household entity |
| Barboursville Massage | Mikalia | sole proprietorship, Schedule C | real employer business (~$95k/yr wages paid); operationally out of fincore scope |

Blenko, Redshirt, and Barboursville Massage are INCOME SOURCES feeding personal
accounts. fincore never does business accounting for any of them.

## Tax profile

- CPA: **Crowe & Crowe CPAs PLLC** (Alexandria Crowe), Charleston, WV
- Convention: **each spouse self-funds ~30% of their own self-employment income**;
  set-asides converge at CNB Joint at payment time; annual balance due paid each
  April (no quarterly estimateds — a deliberate tradeoff with a known cost, see the
  penalty line on the 2025 return)
- Bryson's set-aside vault: Huntington Savings (tax only, never an emergency source)
- Filed returns: PDFs in `tax-returns/` (local only); figures summarized in the
  vault ([2025 summary](../../obsidian-vault/projects/fincore/reference/2025-tax-return-summary.md))

## Health insurance (as of 2026-07)

- Coverage through Blenko's group plan: employer pays **80% of Bryson's own
  premium, 0% of spouse/child tiers**
- Payroll withholding ~$396.49/wk total (pre-tax, Section 125) — the large majority
  is the unsubsidized Mikalia + Maya portion
- Open question with the CPA (fall 2026): marketplace coverage for Mikalia + Maya
  via the self-employed health insurance deduction through her business

## Operating doctrine (pointers, not copies)

- Money flow, goal stack, splits, card doctrine: the
  [financial playbook](../../obsidian-vault/projects/fincore/reference/2026-07-18-debt-playbook.md)
- Position snapshot: the
  [financial snapshot](../../obsidian-vault/projects/fincore/reference/2026-07-17-financial-snapshot.md)

## Change log

- **2026-07-19:** file created. Household facts recorded, including Maya
  (b. 2026-06-27, first dependent, from tax year 2026). Same day: adult birth
  dates and marriage date (2022-10-08) added.
