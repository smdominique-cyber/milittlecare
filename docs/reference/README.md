# Michigan State Reference Documents

Official MiLEAP and Tri-Share documentation captured here for citation
purposes. Filenames are preserved as they were published by MiLEAP /
the Tri-Share program — we deliberately do NOT rename them, so a future
diff against an updated published copy is straightforward.

## CDC Scholarship (MiLEAP)

- **Scholarship Handbook for License Exempt Provider.pdf** — The most
  comprehensive single document for license-exempt CDC providers
  (revised 2026-04-01). Contains the pay rate table (Level 1 / Level 2
  by child age band), the Level 1 / Level 2 training structure and the
  December 16 Annual Ongoing Training deadline rules, the 2025–2026 pay
  period schedules, absence rules, redetermination cadence, and the
  re-enrollment-after-disqualification process. The authoritative
  source for any compliance logic in code that touches license-exempt
  CDC billing.

- **Provider Billing Guidance.pdf** — The rulebook. Absence rules
  (10 consecutive days, 360 hours/fiscal year), overnight billing
  splits, hour caps by provider type (2016 license-exempt / 2016
  family home / 4032 group home), school-age billing rules, fee
  billing limits ($40 family/group home, $65 center per fiscal year),
  retention rules. Cite this in code comments for any compliance
  logic.

- **Provider Billing Help.pdf** — The I-Billing portal walkthrough.
  Confirms data entry model is in/out times (not aggregated hours),
  supports multi-session days via "more time" button, supports
  save-and-resume, 90-day revision window after pay period close,
  output is a PDF invoice. License-exempt enters actual times;
  licensed enters enrolled times.

- **Provider Guide for Adding I-Billing to MiLogin Account.pdf**
  (displayed name) — MiLogin account to I-Billing access flow.
  Provider IDs are 7 digits; PINs are 6 characters. Multi-location
  licensed providers use the "Associate Account" flow to add additional
  provider IDs.

  Note on the filename: the actual on-disk name contains a run of
  non-breaking-space characters (Unicode U+00A0, four of them
  interleaved with regular spaces) between "Adding" and "I-Billing".
  This was MiLEAP's choice and we preserve it. Tab completion and
  naive grep-by-name won't match those bytes; use a shell glob like
  `'*Adding*I-Billing*.pdf'` or copy the filename from `ls` /
  `Get-ChildItem` output when scripting against it.

## MI Tri-Share

- **MI Tri-Share Provider Overview (3.2026).pdf** — Program rules.
  Provider eligibility is licensed-only. SAP (Heart of West Michigan
  United Way) is the single payer for the full cost of care; the
  three-way split happens upstream of the provider. Mutually exclusive
  with CDC Scholarship — a family can't be on both. Provider cannot
  raise rates for Tri-Share families. Direct care to SAP; fees
  (registration, late, etc.) to family. Payment cadence: invoices
  submitted by 5pm Friday paid the following Friday via ACH.

- **MI TriShare Billing Portal Instructions (3.2026).pdf** — 8-step
  portal walkthrough. Manual entry only (no bulk import or API
  visible). Per-child entries for start/end dates of care, type of
  care, cost. Hub does the split math after submission.

## How to use these

When writing code that touches CDC or Tri-Share compliance, cite the
specific document and rule in a comment. Example:

> Per Provider Billing Guidance (Absence Hours section), payment for
> absences is limited to 360 total hours annually with no more than
> 10 days paid in a row.

For citations from the License Exempt handbook, prefer page numbers
because the document has dense subsections that share titles:

> Per Scholarship Handbook for License Exempt Provider (rev. 2026-04,
> pages 11–13, "LEP Training Levels and Annual Ongoing Training"),
> the December 16 Annual Ongoing Training deadline applies to every
> license-exempt provider regardless of level.

These documents revise over time. The date suffix in some filenames
indicates when that version was captured (e.g. "(3.2026)" means
March 2026); the License Exempt handbook embeds its revision date on
the cover page rather than in the filename. Replace (don't delete)
when MiLEAP or the Tri-Share program publishes a revision; update the
relevant filename references in this README and in any code that
cites them.
