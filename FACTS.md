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
| Blenko Glass Co., Inc. | Bryson | W-2 employee (officer salary, weekly) | 401k: see Retirement below |
| WV CSP, LLC dba Redshirt Cloud | Bryson | single-member LLC, Schedule C (marketing/MSP) | lumpy owner draws ~5–6 wk cadence; Neptune Political is a CLIENT of Redshirt, not a household entity |
| Barboursville Massage | Mikalia | sole proprietorship, Schedule C | real employer business (~$95k/yr wages paid); operationally out of fincore scope |

Blenko, Redshirt, and Barboursville Massage are INCOME SOURCES feeding personal
accounts. fincore never does business accounting for any of them.

**Former:** Infinity Marketing Solutions, LLC (S-corp) — Bryson held equity
2017-04-01 to 2024-03-22, sold for $62,500 (all long-term gain, 2024 return);
Redshirt was founded the same year.

## Tax profile

- CPA: **Crowe & Crowe CPAs PLLC** (Alexandria Crowe), Charleston, WV — since tax
  year 2024; previously Walls & Associates (Joshua O'Dell), Milton, WV
- Convention: **each spouse self-funds ~30% of their own self-employment income**;
  set-asides converge at CNB Joint at payment time; annual balance due paid each
  April (no quarterly estimateds — a deliberate tradeoff with a known cost, see the
  penalty line on the 2025 return)
- Bryson's set-aside vault: Huntington Savings (tax only, never an emergency source)
- Filed returns 2023-2025: PDFs in `tax-returns/` (local only); summarized in the
  vault ([2025 summary](../../obsidian-vault/projects/fincore/reference/2025-tax-return-summary.md),
  [2023-2025 history](../../obsidian-vault/projects/fincore/reference/tax-history-2023-2025.md))

## Real property

**Primary residence** — 129 Jefferson Park Dr, Huntington, WV 25705-2612
- Legal: LT 27 BATES/PEA RDG #2 · Map/Parcel **8N 0009 0000 0000**
- District: 01-Barboursville, Cabell County · Class 2 · County account 00005502
- Property tax: billed yearly by the Cabell County Sheriff; halves due ~Sep 1 and
  ~Mar 1 with a ~2.5% discount for early payment (full-year-by-Sep-1 is cheapest)
- 2026 assessment: $67,440 (WV assesses at 60% of appraised → county appraisal
  ~$112,400); 2026 full-year tax $891.12 discounted / $913.96 face
- Statements archived in `documents/property/` (local only, gitignored)
- **Property tax is paid by the Chase mortgage ESCROW** (confirmed 2026-07-19 from
  the Chase escrow analysis) — the Sheriff's statement is informational; never pay
  it manually. Escrow also pays homeowner's insurance ($967.30/yr, coverage
  2025-11..2026-10) and PMI ($409.68/yr = $34.14/mo).
- Chase mortgage composition (per Sep 2025 analysis): P&I $637.22 + escrow $176.57
  = **PITI $813.79/mo**. The actual ACH is $947.29/mo — the ~$133.50/mo difference
  is **intentional extra principal** (confirmed 2026-07-19): Bryson's deliberate
  choice to pay the mortgage down faster.
- PMI-removal opportunity: PMI costs $409.68/yr; with the remodel and equity
  position, a Chase PMI-deletion request (may require an appraisal) could end it
  permanently — flagged 2026-07-19, not yet pursued.
- Homeowner's insurance: **State Farm policy 48BUW1147**, dwelling coverage
  $172,300, renews May 31 (premium paid from escrow). Detail dossier:
  [home escrow & insurance](../../obsidian-vault/projects/fincore/reference/2026-07-19-home-escrow-insurance.md)

(The new-home land parcel is not yet recorded here — add when its first
assessment/deed document is in hand.)

## Vehicles

**2020 Subaru Outback** — VIN 4S4BTGHDXL3133959, titled to Bryson
- Chase auto loan: $37,869.48 originally financed, 75-month term at 5.24%,
  **matures 2028-09-08**, due the 8th monthly (paid ~the 3rd, $593.20 ACH from
  checking). Balance tracked live by fincore (balance-mode sync).
- Playbook treatment: minimums only (cheap debt); the payment becomes ~$593/mo of
  freed cash flow at maturity, Sep 2028.
- Vehicle value is NOT carried as an asset in net worth (conservative; a manual
  asset could be added under SPEC Phase 15 completeness if desired).
- **WV personal property tax: COMPLIANCE GAP (found 2026-07-20).** Cabell portal
  shows PP tickets under Bryson only through tax year 2023 ($263.94/half); nothing
  for 2024-2026 despite owning the Outback + Miata. NEXT STEPS: (1) search the
  portal under Mikalia's name; (2) if truly unfiled, call the Cabell County
  ASSESSOR to file/catch up (annual filing due Oct 1). Notes: WV requires a paid
  PP receipt for registration renewal, and the WV motor-vehicle tax credit
  (2024+) makes timely-paid vehicle tax ~cost-neutral on the state return —
  filing properly costs almost nothing net.

**1991 Mazda Miata** — owned outright, no loan. Estimated value $4-6k (Bryson,
2026-07-20). Not carried in net worth (same conservative treatment as the Outback).

## Retirement (Blenko 401k via Empower)

- Plan: Blenko Glass Company, Inc. 401(k) (Empower/FASCORE; highlights doc in
  `documents/benefits/`)
- **Match formula: 100% of deferrals up to 3% of compensation.**
- Current deferral: **$50/wk FLAT** — set when 3% of salary equaled $50; at the
  current ~$1,818.35/wk gross, 3% = ~$54.55/wk, so the flat amount now leaves
  ~**$235/yr of match unclaimed**. ACTION (2026-07-20): switch the deferral to a
  PERCENTAGE (>=3%) so it tracks raises automatically.
- **Vesting: 3-year cliff on employer money** (0% until 3 years of service, then
  100%). Employee deferrals always 100% vested. Bryson confirmed 3+ years of
  Blenko service (2026-07-20) — **fully vested**; the Empower balance is
  net-worth-accurate.
- Roth 401k option exists in the plan (deferrals may be designated Roth).
- 2026 employee limit: $24,500 (under 50).

## Insurance (non-health) & estate

- **Ameritas dental = ONE policy, #240058621-D** (Ameritas Life Insurance Corp.,
  individual dental + ortho, WV, effective 2020-03-01, renews Mar 1). Bryson is
  policyholder; Mikalia is covered as the one dependent. The $73.44/mo draft is
  the exact "Policyholder plus One Dependent Only" rate from the policy's premium
  table ($35.84 single / $73.44 +1 dep / $122.07 +2 or more deps) — NOT two
  policies, NOT double-billing (dual coverage under a second Ameritas policy is
  actually prohibited by its terms). The Jan–Feb $69.29 → Mar $73.44 step was the
  Mar 1 renewal repricing. Corrected 2026-07-20 from the policy document,
  archived at `documents/insurance/` (local only).
- **Maya + Ameritas dental (open decision):** a newborn is covered automatically
  only for her first 31 days; keeping her on requires notice + premium (tier
  jumps to $122.07/mo, +$48.63). No urgency: the policy waives late-entrant
  status for a newborn until 30 days after her 2nd birthday (~2028-07-27), and
  infant dental value is near zero — revisit around age 1.
- **Beneficiaries: Mikalia on everything** (per Bryson 2026-07-20; as spouse she
  is also the default where no designation exists). Worth adding contingent
  beneficiaries now that Maya exists.
- **Estate planning: NONE yet — conversation needed** (flagged 2026-07-20). With
  Maya born, the priority items are wills and a guardianship designation.

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
