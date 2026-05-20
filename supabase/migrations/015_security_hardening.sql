-- ============================================================
-- MI Little Care — Phase 10: Supabase security advisor hardening
--
-- Resolves the three Supabase security advisor findings recorded in
-- docs/backlog.md § "Supabase security advisor findings (2026-05-15)":
--
--   (1) 5 public functions with mutable search_path
--   (2) SECURITY DEFINER functions exposed to the anon role
--   (3) Leaked-password protection off in Auth settings
--                                  ^^^^^ dashboard step — see runbook
--
-- Strategy: ALTER FUNCTION … SET search_path (proconfig change only —
-- no body rewrite) and REVOKE EXECUTE FROM anon. Bodies are not
-- touched. This is deliberately surgical — four of the seven functions
-- listed below were created out-of-band and have no definition in this
-- repo (see docs/tech_debt.md § "Migrations folder is out of sync with
-- production schema"); altering proconfig + grants does not require
-- the body.
--
-- Audit signoff (2026-05-19):
--   - Signatures verified in the Supabase dashboard via pg_proc
--     lookup; every function in this migration takes zero arguments.
--   - Bodies of the four out-of-band functions inspected via
--     pg_get_functiondef. Verdicts recorded with each REVOKE below.
--   - `git grep` for supabase.rpc / REST rpc paths confirms no
--     app-code caller for current_user_licensee_id or
--     current_user_role; the one direct caller of admin_user_progress
--     (src/pages/AdminPage.jsx:58) is gated client-side on
--     smdominique@gmail.com, i.e. always an `authenticated` session.
--
-- If any ALTER or REVOKE here errors with "function … does not exist",
-- the signature has drifted from zero-arg — re-run the dashboard
-- pg_proc lookup, update the (args) on the offending line, re-apply.
-- ============================================================

-- -------------------------------------------------------
-- 1. Lock search_path on the 5 mutable-search_path functions
-- -------------------------------------------------------
-- Advisor finding (1). Each `set search_path = public, pg_catalog`
-- statement writes a `search_path=public,pg_catalog` entry into
-- pg_proc.proconfig, which is what the advisor's "Function Search
-- Path Mutable" check inspects.

alter function public.set_updated_at()
  set search_path = public, pg_catalog;

alter function public.current_user_licensee_id()
  set search_path = public, pg_catalog;

alter function public.current_user_role()
  set search_path = public, pg_catalog;

alter function public.bump_thread_last_message_at()
  set search_path = public, pg_catalog;

alter function public.set_funding_source_priority_default()
  set search_path = public, pg_catalog;

-- -------------------------------------------------------
-- 2. Tighten handle_new_user's existing search_path
-- -------------------------------------------------------
-- Migration 001 created handle_new_user with `set search_path = public`
-- (no pg_catalog). Not strictly flagged by the advisor's mutable-
-- search_path check (it has *some* setting), but the advisor's
-- recommended pair is public, pg_catalog — broader catalog visibility
-- without opening the path to writable schemas. Aligning here so all
-- six SECURITY-relevant functions land at the same standard.

alter function public.handle_new_user()
  set search_path = public, pg_catalog;

-- -------------------------------------------------------
-- 3. Scope admin_user_progress to public + auth
-- -------------------------------------------------------
-- The body of admin_user_progress (inspected 2026-05-19 via
-- pg_get_functiondef) references auth.sessions and calls auth.jwt(),
-- so it genuinely needs the `auth` schema on the path. `public, auth`
-- is the tightest pair that resolves every identifier the body uses.

alter function public.admin_user_progress()
  set search_path = public, auth;

-- -------------------------------------------------------
-- 4. Revoke EXECUTE from anon on every function in scope
-- -------------------------------------------------------
-- Advisor findings (2) and (3). Per-function rationale:
--
--   set_updated_at, set_funding_source_priority_default,
--   bump_thread_last_message_at, handle_new_user — trigger functions.
--   Triggers fire in the table's privilege context; EXECUTE on the
--   function is not consulted by the trigger system. Revoking anon's
--   grant doesn't change trigger behaviour.
--
--   current_user_licensee_id, current_user_role — SECURITY DEFINER
--   helpers consulted only inside RLS policy expressions. RLS policies
--   are evaluated by the server with elevated privileges; the calling
--   role's EXECUTE grant on the function is not consulted in that
--   path. `git grep` 2026-05-19 confirmed no app code calls them via
--   supabase.rpc or the /rest/v1/rpc/ REST surface.
--
--   admin_user_progress — SECURITY DEFINER admin telemetry. The one
--   direct caller is src/pages/AdminPage.jsx (the smdominique@gmail.com
--   admin path), which only fires the call when the signed-in user
--   passes a client-side admin-email check. That call goes through
--   PostgREST as `authenticated`, never `anon`.

revoke execute on function public.set_updated_at()                       from anon;
revoke execute on function public.current_user_licensee_id()             from anon;
revoke execute on function public.current_user_role()                    from anon;
revoke execute on function public.bump_thread_last_message_at()          from anon;
revoke execute on function public.set_funding_source_priority_default()  from anon;
revoke execute on function public.admin_user_progress()                  from anon;
revoke execute on function public.handle_new_user()                      from anon;

-- -------------------------------------------------------
-- 5. Operational comment on admin_user_progress
-- -------------------------------------------------------
-- Make the smdominique-only intent of admin_user_progress legible in
-- pg_proc itself so a future schema reviewer doesn't reintroduce an
-- anon grant by reflex.

comment on function public.admin_user_progress() is
  'Admin telemetry view. SECURITY DEFINER. Invoked only from '
  '/admin (src/pages/AdminPage.jsx, gated client-side on '
  'smdominique@gmail.com). Anon EXECUTE revoked by migration 015 '
  '(2026-05-19); search_path pinned to public, auth.';

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Restores the pre-015 state.
--
-- Note: prior to 015, four of the search_path slots were genuinely
-- unset (no proconfig entry), and handle_new_user was set to `public`
-- alone. `reset search_path` clears the per-function override entirely.
--
-- alter function public.set_updated_at()                       reset search_path;
-- alter function public.current_user_licensee_id()             reset search_path;
-- alter function public.current_user_role()                    reset search_path;
-- alter function public.bump_thread_last_message_at()          reset search_path;
-- alter function public.set_funding_source_priority_default()  reset search_path;
-- alter function public.admin_user_progress()                  reset search_path;
-- alter function public.handle_new_user()                      set search_path = public;
--
-- grant execute on function public.set_updated_at()                       to anon;
-- grant execute on function public.current_user_licensee_id()             to anon;
-- grant execute on function public.current_user_role()                    to anon;
-- grant execute on function public.bump_thread_last_message_at()          to anon;
-- grant execute on function public.set_funding_source_priority_default()  to anon;
-- grant execute on function public.admin_user_progress()                  to anon;
-- grant execute on function public.handle_new_user()                      to anon;
--
-- comment on function public.admin_user_progress() is null;
