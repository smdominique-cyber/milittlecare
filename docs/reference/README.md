# Michigan State Reference Documents

Official MiLEAP and Tri-Share documentation captured here for citation
purposes. Filenames include the document's revision date suffix where
known.

## CDC Scholarship (MiLEAP)

- **MiLEAP_Provider_Billing_Guidance_2026-03.pdf** — The rulebook. Absence
  rules (10 consecutive days, 360 hours/fiscal year), overnight billing
  splits, hour caps by provider type (2016 license-exempt / 2016 family
  home / 4032 group home), school-age billing rules, fee billing limits
  ($40 family/group home, $65 center per fiscal year), retention rules.
  Cite this in code comments for any compliance logic.

- **MiLEAP_Provider_Billing_Help_2026-03.pdf** — The I-Billing portal
  walkthrough. Confirms data entry model is in/out times (not aggregated
  hours), supports multi-session days via "more time" button, supports
  save-and-resume, 90-day revision window after pay period close, output
  is a PDF invoice. License-exempt enters actual times; licensed enters
  enrolled times.

- **MiLEAP_Provider_Guide_Adding_IBilling_to_MiLogin_2026-03.pdf** —
  MiLogin account to I-Billing access flow. Provider IDs are 7 digits;
  PINs are 6 characters. Multi-location licensed providers use the
  "Associate Account" flow to add additional provider IDs.

## MI Tri-Share

- **MI_TriShare_Provider_Overview_2026-03.pdf** — Program rules. Provider
  eligibility is licensed-only. SAP (Heart of West Michigan United Way)
  is the single payer for the full cost of care; the three-way split
  happens upstream of the provider. Mutually exclusive with CDC
  Scholarship - a family can't be on both. Provider cannot raise rates
  for Tri-Share families. Direct care to SAP; fees (registration, late,
  etc.) to family. Payment cadence: invoices submitted by 5pm Friday
  paid the following Friday via ACH.

- **MI_TriShare_Billing_Portal_2026-03.pdf** — 8-step portal walkthrough.
  Manual entry only (no bulk import or API visible). Per-child entries
  for start/end dates of care, type of care, cost. Hub does the split
  math after submission.

## How to use these

When writing code that touches CDC or Tri-Share compliance, cite the
specific document and rule in a comment. Example:
"Per MiLEAP Provider Billing Guidance 2026-03 (Absence Hours section),
payment for absences is limited to 360 total hours annually with no more
than 10 days paid in a row."

These documents revise over time. Date suffix in the filename indicates
when this version was captured. Replace (don't delete) when MiLEAP
publishes a revision.