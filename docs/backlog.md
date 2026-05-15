# Backlog

Product and operational follow-ups that are not yet scheduled into a PR.
Distinct from `tech_debt.md` (code-level debt introduced by shipped work);
this file holds forward-looking items — hardening, QA, and product moves.

## Security / QA

### Supabase security advisor findings (2026-05-15)

Pre-existing low-severity items surfaced by running the Supabase security
advisors after migration `009`. **None are blocking, and none were
introduced by 009** — they predate it.

- **5 functions with a mutable `search_path`** — `set_updated_at`,
  `current_user_licensee_id`, `current_user_role`,
  `bump_thread_last_message_at`, `set_funding_source_priority_default`.
- **Leaked-password protection is off** in Auth settings (Supabase can
  check passwords against HaveIBeenPwned; currently disabled).
- **Several `SECURITY DEFINER` functions are exposed to the `anon` role**,
  including `admin_user_progress` (also `current_user_licensee_id`,
  `current_user_role`, `handle_new_user`).

Triage and harden these in a focused pass **before opening signups beyond
Venessa**. While the live user count is one, exposure is minimal; the cost
of leaving it grows the moment public signup is on.

**Standing procedure:** run the Supabase security advisors (security +
performance) after **every DDL migration**, as a routine post-migration
check — the same way migration verification is now a required step. A new
table or function can silently ship without RLS or with an over-permissive
grant; the advisor catches it.
