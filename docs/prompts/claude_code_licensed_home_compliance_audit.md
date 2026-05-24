# Claude Code Prompt — Licensed Home Compliance Audit

**Paste this entire document into Claude Code as a single prompt.** It tells Claude Code to investigate the milittlecare codebase against Michigan's new Child Care Home Licensing Rules (adopted April 27, 2026; compliance deadline approximately late July 2026) and produce a gap report. No code changes will be made — this is investigation only.

---

## Context

milittlecare's actual product positioning is the **"Licensed Home" version** — it targets Family Child Care Homes (≤6 children) and Group Child Care Homes (≤12 children) as the primary customer segment, plus License-Exempt Providers (LEPs) as a secondary segment. The product owner's primary user (Venessa) operates a licensed **Group Home**.

Michigan adopted new Child Care Home Licensing Rules on April 27, 2026. The compliance window is 90 days, putting the deadline at approximately **late July 2026**. Family and group home licensees must be fully compliant by that date.

The owner has decided:
- All six compliance PRs should ship by late July
- Existing surfaces (Today widget, Families modal, Funding) should be extended rather than rebuilt
- All compliance reminders should be **opt-in** (off by default; the licensee enables each category they want)
- MiRegistry remains the system of record for training; milittlecare tracks dates only (hire date, cert expirations) and links out to MiRegistry — no duplication of training records
- License type (Family Home / Group Home / LEP) becomes a provider profile field that gates which compliance surfaces appear

## What I want you to do

**Investigation only — no code changes.** Produce a gap report that I will use to scope and sequence six new PRs (#14–#19, plus a foundation PR for license-type awareness and an opt-in reminder system PR).

Read but do not edit any files. The deliverable is a markdown report saved to `docs/licensed-home-compliance-audit-2026-05-23.md`.

### Step 1 — Read context and current backlog

1. Read `docs/backlog.md` to see the existing backlog structure (the owner just added new PR proposals there — incorporate the existing items into your understanding rather than duplicating them)
2. Read `docs/tech_debt.md` to understand current known issues
3. Read `docs/architecture.md` if it exists
4. Read `docs/build-summary-2026-05-21.md` for recent context

### Step 2 — Codebase inventory by compliance category

For each of the six compliance categories below, audit the codebase and report:

- **What exists today** (file paths, table names, fields)
- **What's missing relative to the rule text**
- **What can be extended vs what must be built fresh**
- **Recommended difficulty rating** (Small / Medium / Large)

#### Category A — Drill log & Emergency Response Plan (Rule 39)

Rule requires:
- Written plan covering 10 emergency types: fire, tornado, accident, water (if applicable), flood, power, weather, disaster, bomb/man-made, intruder/active shooter
- Plans for evacuation, relocation, shelter-in-place, lockdown, family reunification, continuity, infant/toddler accommodation, disability accommodation, chronic medical condition accommodation
- Drill schedule: fire every 3 months, tornado 2x March–November, others annually
- Written log with date, time, evacuation duration, retained 2 years

Look for:
- Any existing drill, emergency, or safety-plan related tables, routes, or UI surfaces
- Any compliance reminder infrastructure that could be repurposed for drill due-date alerts

#### Category B — Medication Administration Log (Rule 31)

Rule requires:
- Parent permission per medication (written)
- Original container check before administering
- Per-dose log: date, time, dose, medication name, child name, administering staff
- Records retained 2 years
- Exemption for topical OTC (sunscreen, repellent, diaper rash)
- Only licensee or child care staff member may administer (not assistants or volunteers)

Look for:
- Any med admin tables, child health fields, or related staff-permission gating
- The existing parent acknowledgement infrastructure from PR #12 — could parent permissions for medication ride that pattern?

#### Category C — Discipline policy & parent acknowledgement at intake (Rules 6, 7, 42)

Rule requires:
- Written discipline policy per Rule 42 (prohibited methods listed; positive discipline encouraged; time-out restrictions)
- Parent acknowledgement of receipt at child intake (Rule 7) — part of the "child in care statement"
- Staff acknowledgement of policy at hire (Rule 6)
- Policy on file at home

Look for:
- Any existing discipline-policy storage anywhere in the codebase
- The existing parent acknowledgement infrastructure — this is a different acknowledgement type than attendance-hours; can the existing tables (acknowledgments, acknowledgment_flags) be extended with an `acknowledgment_type` field, or is a separate model better?
- Staff onboarding workflow — does anything currently capture "policies acknowledged at hire"?

#### Category D — Child file completeness (Rule 7)

Rule requires per child, before initial attendance:
- Child information card (department form or approved substitute)
- Child in care statement signed by parent, covering:
  - Receipt of discipline policy
  - Condition of child's health
  - Acknowledgement that licensing rules were offered
  - Agreement on who provides food
  - Firearms on premises disclosure (if applicable)
  - Lead-based paint disclosure if home built before 1978
  - Notice of licensing notebook availability
- Immunization records or signed waiver
- Annual review of all child records
- Retention: 2 years after child leaves

Look for:
- Existing children table fields
- Family modal Children tab — what fields exist, what's missing
- Any parent-signature capture flow at intake (vs after the fact)
- Lead-based paint disclosure mechanism (probably doesn't exist)

#### Category E — Staff file completeness (Rules 3, 6, 19, 20, 22, 33)

Rule requires per staff member:
- Hire date
- Daily arrival/departure log (Rule 6 — separate from child attendance)
- Physician attestation of mental & physical health, renewed annually (Rule 33)
- Discipline policy acknowledgement at hire
- CPR (pediatric, infant, child, adult) and pediatric First Aid certifications with expiration tracking (Rule 20)
- Background check status via Child Care Background Check system (CCBC) (Rule 19)
- Sex offender registry clearance for assistants & volunteers (Rule 3.r)
- MiRegistry account established within 30 days of hire (Rule 22)
- New-hire training completed within 90 days (Rule 23) covering 14 specific topics

Look for:
- Existing staff/team tables and fields
- Any existing attendance-log surface for staff (likely partially exists for licensee but maybe not for other staff)
- Cert expiration tracking infrastructure anywhere in the app
- CCBC integration (probably doesn't exist; manual capture of status)

#### Category F — Property records (Rules 7, 13, 15, 17, 18, 45, 48)

Rule requires:
- Radon test before initial license and every 4 years at renewal (Rule 15)
- Heating equipment inspection every 4 years (Rule 45)
- Carbon monoxide detector on every level used for child care (Rule 15)
- Smoke detectors on every floor, basement, and in all sleeping/bedroom areas (Rule 48)
- Multipurpose fire extinguisher (2A-10BC or larger) on each floor of child-use space (Rule 48)
- Animal/pet notification to parents (Rule 17)
- Smoking/vaping prohibition posted (Rule 18)
- Licensing notebook with last 3 calendar years of inspections, investigations, corrective actions, and approval letters; summary sheet; accessible to parents during operation
- Maintained until license closure

Look for:
- Any property/facility tables or fields
- Any document storage mechanism (uploaded PDFs, images)
- Reminder infrastructure that could surface "radon test due in 30 days"

### Step 3 — Cross-cutting infrastructure audit

#### Reminder system (foundation for opt-in compliance alerts)

The owner wants all compliance reminders to be **opt-in per category, with configurable lead time**. Audit:
- Existing notification/reminder infrastructure (the PR #12 acknowledgment digest cron, for example)
- Existing settings or preferences model on the provider profile
- Whether reminders should ride email (Resend) or in-app banner or both

#### License type field on provider profile

Audit:
- Existing provider profile table (probably `profiles` or similar) and its fields
- Whether there's already a license-type or license-status field
- If not, the migration scope to add `license_type` ENUM ('family_home', 'group_home', 'license_exempt')
- All places that would need to check license type to show/hide compliance surfaces

#### Existing acknowledgement infrastructure (PR #12) — can it be extended?

The parent acknowledgement workflow from PR #12 handles attendance hours. For licensed homes, we need:
- Discipline policy acknowledgement at child intake
- Lead disclosure acknowledgement (pre-1978 homes)
- Firearms disclosure acknowledgement
- "Child in care statement" sub-acknowledgements (Rule 7)
- Staff acknowledgement of discipline policy at hire

Audit:
- Whether the existing `attendance_acknowledgments` (or similar) table could grow an `acknowledgment_type` discriminator
- Whether a separate "intake_acknowledgements" model is cleaner
- The existing acknowledgement UI components and how reusable they are

### Step 4 — Deliverables

Save your findings to `docs/licensed-home-compliance-audit-2026-05-23.md` with this structure:

```markdown
# Licensed Home Compliance Audit — 2026-05-23

## Executive summary
- High-level read on overall readiness
- Top 3 risks for the July 2026 deadline
- Recommended sequencing of the six PRs based on dependencies discovered

## Category-by-category gap analysis
[For each of A–F:]
### Category X
**Rule reference:** R 400.xxxx
**Current state:**
**Gaps:**
**Extension vs build:**
**Recommended difficulty:** S / M / L
**Dependencies on other categories:**

## Cross-cutting infrastructure
### Reminder system
### License type field
### Acknowledgement extension

## Recommended PR sequence
[Ordered list with rationale]

## Open questions for the owner
[Things you couldn't determine from code alone — fields the owner needs to decide]

## Files audited
[List every file you read, for traceability]
```

### Step 5 — Halt

Do not propose code changes. Do not create new branches. Do not modify any files except creating the audit doc. After saving the report, summarize the top 5 findings in your halt message so I have a quick read.

---

## Operating rules

- Read `docs/backlog.md` first — the owner just added PR proposals there. Incorporate, don't duplicate.
- Use markdown for the report, not code blocks unless quoting actual code
- Where you find ambiguity (e.g., "Group Home staff ratio may differ from current implementation"), flag it as an open question rather than guessing
- Do not invent file paths — if you can't find something, say "no existing implementation found for X"
- Stay literal about what the rule text requires — don't soften regulatory requirements
- Don't recommend MiRegistry data duplication — the decision is dates-only, link-out

When finished, halt with a 5-bullet executive summary and the audit doc path.
