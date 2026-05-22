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
