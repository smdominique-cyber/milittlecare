-- ============================================================
-- MI Little Care — Phase 9: Terms of Service / Privacy clickwrap acceptance
--
-- Adds a terms_accepted_at column to BOTH user-shaped tables:
--   - public.profiles         — providers (licensee, co-providers, staff)
--   - public.parent_profiles  — parents accepting a family invitation
--
-- Both record when the user clicked through the required Terms of
-- Service / Privacy Policy acceptance checkbox at signup or invitation
-- accept. Two columns rather than one are needed because the codebase
-- splits user-shaped data across two tables — providers and staff are
-- public.profiles rows; parents are public.parent_profiles rows.
-- Migration written this way (vs a separate user_agreements table)
-- because it stays minimal and matches the existing schema shape; the
-- versioned audit-grade shape is recorded as a follow-up — see
-- docs/tech_debt.md § "Versioned user_agreements table".
--
-- This ships with branch chore/legal-pages-and-consent (2026-05-19),
-- which wires:
--   - A required clickwrap checkbox on the LoginPage signup form,
--     InviteAcceptPage, and StaffInviteAcceptPage (submit disabled
--     until checked).
--   - A client-side update on successful account creation /
--     invitation acceptance — InviteAcceptPage writes to
--     parent_profiles; LoginPage signup and StaffInviteAcceptPage
--     write to profiles.
--
-- Schema choices:
--   - nullable, no default — pre-existing rows (including Venessa and
--     other early users) have never gone through the clickwrap, so
--     stamping them with now() would falsely assert acceptance they
--     never gave. NULL means "no recorded acceptance"; the column
--     becomes meaningful only for accounts created on or after the
--     branch ships. Backfilling existing users is addressed separately
--     in docs/tech_debt.md.
--   - timestamptz — a single point-in-time field. The documents version
--     this column tracks is the Terms / Privacy text as of 2026-05-19
--     (the date the legal pages and this column ship together). When
--     the documents are next materially updated, this column will not
--     be enough: a versioned user_agreements table is the proper
--     shape — see docs/tech_debt.md § "Versioned user_agreements
--     table".
--
-- RLS: both target tables already have row-level security with
-- per-user read/write policies. terms_accepted_at is a new column on
-- those same rows and inherits those policies unchanged — each user
-- reads and writes only their own value, which is what the clickwrap
-- update needs.
--
-- Editor note: two short DDL statements plus two `comment on column`
-- statements, so the web SQL Editor long-statement bug recorded in
-- docs/runbook.md does not apply.
-- ============================================================

alter table public.profiles
  add column if not exists terms_accepted_at timestamptz;

comment on column public.profiles.terms_accepted_at is
  'Timestamp at which the provider / staff member clicked through the '
  'required Terms of Service + Privacy Policy clickwrap. NULL means no '
  'recorded acceptance. Tracks the documents as of 2026-05-19 — see '
  'branch chore/legal-pages-and-consent and docs/tech_debt.md § '
  '"Versioned user_agreements table" for the deferred per-version shape.';

alter table public.parent_profiles
  add column if not exists terms_accepted_at timestamptz;

comment on column public.parent_profiles.terms_accepted_at is
  'Timestamp at which the parent clicked through the required Terms of '
  'Service + Privacy Policy clickwrap when accepting a family '
  'invitation. NULL means no recorded acceptance. Tracks the documents '
  'as of 2026-05-19 — see branch chore/legal-pages-and-consent and '
  'docs/tech_debt.md § "Versioned user_agreements table" for the '
  'deferred per-version shape.';

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- alter table public.profiles drop column if exists terms_accepted_at;
-- alter table public.parent_profiles drop column if exists terms_accepted_at;
