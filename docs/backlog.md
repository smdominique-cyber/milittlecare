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
PR #13 — Auditor Read-Only Portal
Trigger: Providers facing a real CDC audit need a way to give MDHHS auditors structured access to compliance records without granting full app access.
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

Refreshed backlog summary
Here's what I'm proposing to add. Each is a real PR scope with reasonable effort estimate.
Compliance deadline: ~late July 2026 (90 days from April 27 adoption)
Tier A — Daily-use workflows (your top priority)
PR #14 — Drill Log & Emergency Response Plan

Written emergency response plan covering 10 categories (Rule 39): fire, tornado, accident, water, flood, power, weather, disaster, bomb/man-made, intruder/active shooter
Drill log: fire every 3 months, tornado 2x March-Nov, others annual
Plans posted/accessible based on type (some visible to parents, others to staff only)
Drill log entries auto-prompt the licensee when one is overdue (opt-in reminder)

PR #15 — Medication Administration Log

Per Rule 31: parent permission, medication name, dose, time, administering staff, original container check
Topical exception (sunscreen, repellent, diaper rash) skips the full log
Records retained 2 years minimum
Daily workflow for staff during care

PR #19 — Discipline Policy & Parent Acknowledgement at Intake

Written discipline policy stored in provider profile
At child intake, parent signs receipt + acknowledges policy + condition of child's health
This becomes part of the existing parent acknowledgement workflow (extension of PR #12)

Tier B — Auditor records (second priority)
PR #16 — Child File Completeness

Child information card (Rule 7)
Child in care statement signed by parent (discipline policy receipt, health, food agreement, firearms disclosure, lead disclosure for pre-1978 homes, licensing notebook availability notice)
Immunization records or waiver
Annual review reminder
Records retained 2 years after child leaves

PR #17 — Staff File Completeness (extends existing)

Hire date
Daily arrival/departure log (already partially exists for attendance — extend)
Physician attestation (annual)
Discipline policy acknowledgement at hire
CPR & First Aid cert expiration dates with opt-in reminders
Background check status panel (CCBC connection status, not full background data)
Sex offender registry clearance for volunteers/assistants (Rule 3.r)

PR #18 — Property Records

Radon test (every 4 years, with reminder)
Heating equipment inspection (every 4 years, with reminder)
Licensing notebook digitized (3 years of inspections, investigations, corrective actions)
Carbon monoxide detector / smoke detector tracking
Fire extinguisher (location, last inspection if applicable)

Tier C — Opt-in reminder system (cross-cutting infrastructure)
PR #20 — Compliance Reminder Settings

Per-licensee toggle for each reminder category
Configurable lead time (30 days before, 7 days before, day-of)
Reminder delivery: in-app banner, email, or both
All defaults OFF — licensee opts in to specific reminders they want

Tier D — Foundation for the above
PR #21 — License-type awareness on provider profile

License type field on provider profile: Family Home / Group Home / LEP
Show/hide compliance surfaces based on license type
Default to LEP for existing customers; Venessa's account switches to Group Home

This is the foundation that everything else builds on. Should probably ship before any of Tier A or B.
