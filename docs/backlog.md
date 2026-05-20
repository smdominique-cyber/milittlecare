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
