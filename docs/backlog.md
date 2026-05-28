# Backlog

Product and operational follow-ups that are not yet scheduled into a PR.
Distinct from `tech_debt.md` (code-level debt introduced by shipped work);
this file holds forward-looking items — hardening, QA, and product moves.

## Security / QA

### Run the Supabase advisors after every DDL migration

**Standing procedure:** run the Supabase security advisors (security +
performance) after **every DDL migration**, as a routine post-migration
check — the same way migration verification is now a required step. A new
table or function can silently ship without RLS or with an over-permissive
grant; the advisor catches it.

### Resolved

- **Supabase security advisor findings (2026-05-15)** — three pre-existing
  low-severity issues (mutable `search_path` on 5 functions, several
  `SECURITY DEFINER` functions exposed to the `anon` role, leaked-password
  protection off in Auth settings). Resolved by migration
  `015_security_hardening.sql` (branch `chore/supabase-security-hardening`,
  2026-05-19) plus the dashboard step for the leaked-password setting. See
  `docs/runbook.md` § 015 for the per-function changes and verification.
Future PR — Auditor Read-Only Portal (number TBD post-PR-#21)
Trigger: Providers facing a real CDC audit need a way to give MDHHS auditors structured access to compliance records without granting full app access. (The historical "PR #13" label here predated the current numbering scheme — actual PR #13 shipped on 2026-05-23 as `children.archived_at` + soft-delete audit. This auditor portal is now an unscheduled post-#21 item.)
User scenarios:

Provider creates time-limited auditor access link from the dashboard
Auditor opens link, sees read-only view of attendance records, T&A acknowledgments, training records, DHS-198 documents
Auditor can filter by date range to focus on the audit window
Provider can revoke access at any time
Provider sees a log of what the auditor viewed

Open design questions:

Auth model: share link vs temp account vs in-app passcode
Scope: per-family or full-roster
Access duration: provider-set vs default 24-48h
Read-only enforcement: RLS vs UI-only
Audit-of-the-audit logging: what gets recorded

Dependencies:

PR #11 (Audit Packet Generator) — documents auditor would view through this portal
Probably new tables: audit_sessions for tracking auditor visits, audit_access_grants for managing share links

Priority: Becomes critical the first time a provider faces an audit. Until then, queued.

## Licensed Home compliance PR sequence (status as of 2026-05-27)

This section supersedes the earlier "Refreshed backlog summary" that
proposed an alternative tier-based PR numbering. The authoritative
sequence — the one used by `CLAUDE.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`, and every
scope doc under `docs/pr-*-scope.md` — is below.

Compliance deadline: ~late July 2026 (90 days from April 27 adoption).

| # | Title | Status |
|---|---|---|
| PR #13 | `children.archived_at` + soft-delete audit | **SHIPPED 2026-05-23** |
| PR #14 | License-type foundation | **SHIPPED 2026-05-26** |
| PR #15 | Opt-in reminder system | Scope authoritative on main (`docs/pr-15-opt-in-reminder-system-scope.md`) |
| PR #16 | Child files (Rule 7) + general acknowledgments table | Scope authoritative on main (`docs/pr-16-child-files-scope.md`) |
| PR #17 | Discipline policy (Rule 42) | Scope authoritative on main (`docs/pr-17-discipline-policy-scope.md`) |
| PR #18 | Staff file gaps (Rules 3, 6, 19, 20, 22, 33) | Scope authoritative on main (`docs/pr-18-staff-file-gaps-scope.md`) |
| PR #19 | Drills + emergency plan (Rule 39) | Scope authoritative on main (`docs/pr-19-drills-emergency-plan-scope.md`) |
| PR #20 | Medication administration log (Rule 31) | Scope authoritative on main (`docs/pr-20-medication-log-scope.md`) |
| PR #21 | Property records (Rules 13, 15, 17, 18, 45, 48) | Scope authoritative on main (`docs/pr-21-property-records-scope.md`) |

The full implementation details for each PR live in its scope doc. The
audit and the decisions doc remain the upstream sources of truth.

Sequencing rationale (carried over from the decisions doc): PRs #13–#15
are foundation work that clears the deck for the six compliance category
PRs #16–#21. PR #15 (reminders) is general-purpose infrastructure and
serves not only the compliance categories but also future non-compliance
use cases (CDC redetermination reminders, "remember to bill" reminders,
MiRegistry deadline reminders).
Backlog entry to ADD
This file contains the entry to add to docs/backlog.md, not a replacement for the whole file. Append this content to the existing backlog.md as a new top-priority section.

Post-July priority: CDC redetermination ownership
Status: Highest-priority post-July product wedge. Spec drafted, validation in hand, awaiting compliance PRs (#13-#21) to complete.
Customer validation: See docs/customer-research-2026-05-23.md. Three Facebook threads in May 2026. Direct quotes including:

"We don't get notified that their case is cut off until we bill and DONT get paid" (Crystal Wartley)
"Must continuously check CDC billing to see if child is active (letters are late - months late)" (Anonymous 516)
"You have to remember to bill if you wanna get paid" (Amy T — universal even for experienced providers)

Strategic context: See docs/strategy.md § Redetermination ownership. This is the strongest current product wedge — validated by customers, grounded in state docs, not addressed by competitors, survives state modernization, natural extension of existing acknowledgment infrastructure.
Spec: See docs/redetermination-ownership-spec.md for the full product spec including state machine, reminder series copy, data model, and phasing options.
Why this is the right next focus post-July

Customer-validated pain (most-mentioned issue across three Facebook threads, ~10 unique respondents)
Grounded in state documentation (CDC Handbook, BAM 210, BEM 703, DHS-198, MDHHS-5419)
Predictable, rule-based workflow that's currently unowned by any software
Affects real money for both providers and parents
Not addressed by Brightwheel or other generalist software
Natural extension of the parent-acknowledgment infrastructure from PR #12 and the general acknowledgments table introduced in PR #16
Survives state modernization — intelligence layer, not workflow layer

Phasing recommendation
Five phases, each its own PR (probably PR #25+ in sequence):
PhaseTitleScopeDependency1Authorization trackingDHS-198 capture, computed redetermination window, dashboard viewPR #14, PR #162Responsibility disclosureParent acknowledgment at intake, auto-generated PDFPR #16 (acknowledgments table)3Reminder system + state machineEscalating reminders, state transitions, parent response capturePR #15 (reminder infra), Vercel Pro4Parent education contentPlain-language "how not to fall off" contentPhase 35Back-billing assistance90-day revision window helper, attendance reconstructionPhase 1
Each phase is independently valuable. Phase 1 alone would have prevented some falloffs the Facebook providers described.
Estimated effort
Rough scope estimates (will firm up during scoping per phase):

Phase 1: M (1 PR)
Phase 2: S-M (uses existing acknowledgments infra)
Phase 3: L (the big build — scheduler, state machine, reminder copy, cron infra)
Phase 4: S (mostly content)
Phase 5: M

Total roughly 3-5 PRs over 6-12 weeks of post-July work.
Marketing positioning when this ships
Headline: "MILittleCare ends CDC surprise falloffs."
This is a strong enough wedge to anchor a landing-page section and an outreach push.
Open questions captured in spec
7 open questions are documented in docs/redetermination-ownership-spec.md § Open questions. They don't need answers before Phase 1 ships, but Phase 3 cannot begin until they're resolved.

## PR #22 — Compliance Health Score (post-July)

Every domain PR #15–#21 ships a `getXxxAuditState(licensee_id)` pure
helper (the audit-state mandate — see `CLAUDE.md` § Critical Domain
Knowledge). **PR #22 aggregates these into a unified provider-level
compliance health score** that surfaces on the dashboard as a single
"audit-risk" number with a per-domain drilldown.

### Opt-in framing

- The score widget is **OFF by default**. The provider enables it in
  settings.
- Within the score, **Type 1 (MiRegistry mirror) data is excluded by
  default** with a per-category sub-toggle to include. Type 2
  (MILittleCare-owned) data counts by default.
- Today the only Type 1 source is PR #18 (annual ongoing training
  completion, professional-development hours, MiRegistry account
  status). Every other domain is pure Type 2.

### Helper contract

Each helper returns `{ domain, type, ...domain-specific signal fields }`:

- Type 2 helpers carry `type: 'type_2'`.
- PR #18's helper carries `type: 'mixed'` with `type_1_fields` and
  `type_2_fields` sub-objects, each tagged with
  `_tag: 'type_1_miregistry_mirror'` or
  `'type_2_milittlecare_owned'` so PR #22's scorer can apply the
  exclusion rules cleanly.

### Effort, dependencies, timing

- **Effort:** M. No new schema; PR #22 is a read-only aggregator + UI
  widget + a small preferences row (shape parallels PR #15's preferences
  pattern).
- **Dependencies:** all of PRs #15–#21 must have shipped (PR #22
  consumes their audit-state helpers). Independent of the
  redetermination ownership work.
- **Timing:** likely sequenced as PR #22 in the post-July compliance
  work, alongside the redetermination ownership feature. The two are
  distinct (audit risk vs. financial-falloff risk) but share the
  preferences-table pattern from PR #15.

## V2 product surface — GSQ (Great Start to Quality) readiness

Distinct from PR #22 (compliance health score), GSQ readiness is a
**quality-rating tracker** tied to direct CDC reimbursement uplift per
the *CDC Scholarship Handbook for Licensed Providers*. A higher GSQ star
rating means a higher per-hour CDC pay rate for the provider — every
star earned recovers margin against urban-cost markets where CDC trails
private pay. This is a Michigan-specific financial incentive that
Brightwheel and other generalist software cannot serve.

### Overlap with audit state

- The GSQ rubric overlaps with audit-liability data roughly **50%**:
  staff qualifications, family partnerships, written policies, drill
  logs (Categories 1–3 of the rubric).
- Categories 4–5 (curriculum quality, classroom environment,
  teacher–child interactions) require **observation-based evidence**
  that MILittleCare does NOT capture today.

### Two paths

- **Path B (V2):** extend the audit-state helpers from PR #22 to tag
  GSQ-relevant signals; build a separate "GSQ readiness" widget that
  consumes the tagged subset. Same data, different audience frame.
  Effort: **M**.
- **Path C (V3+):** add curriculum and observation evidence capture for
  the 50% gap. Effort: **L**. Requires validated customer pull before
  investing.

### Validation gate before Path C

Run a Facebook research thread — mirroring the May 2026 redetermination
research — asking providers about GSQ as a real pull. Current customer
evidence is thin on this dimension; don't invest in Path C without
validation.

### Opt-in framing

Like the compliance health score, the GSQ readiness widget is **OFF by
default**. Provider enables it in settings. Both trackers are opt-in
across the board (see `CLAUDE.md` § Critical Domain Knowledge).

### Strategic angle

GSQ-rated providers earn higher CDC reimbursement; every star earned
recovers margin. Direct financial incentive — sellable angle — and the
Michigan-specific rubric is a moat against national competitors. See
`docs/docs/strategy.md` for the strategy-level framing.
