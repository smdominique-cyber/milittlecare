-- ============================================================
-- MI Little Care — Phase 12: Parent Acknowledgment via Parent Portal + Email
--
-- Three new tables and one column-add set on the per-provider settings
-- surface. Implements docs/pr_12_parent_acknowledgment_addendum.md.
--
-- Adapted in three places from the addendum's spec to match
-- milittlecare's established patterns (docs/pr-12-review.md § "RLS and
-- pattern adaptations" for the full rationale):
--
--   1. NO guardians.user_id parent-link column. The existing
--      guardians.user_id column already holds the LICENSEE's user id
--      (FamiliesPage.jsx:959); adding a parent column there would
--      overload semantics. Parent-side eligibility joins through the
--      existing parent_family_links table instead.
--
--   2. acknowledged_by_guardian_id is NULLABLE for parent_portal
--      acknowledgments. There is no clean 1:1 mapping from a
--      parent_profiles row to a single guardians row (parents are
--      distinct from guardians; multi-guardian families exist).
--      acknowledged_by_user_id is the authoritative parent identifier;
--      acknowledged_by_guardian_id is populated by an app-layer
--      email-match lookup when one exists and left NULL otherwise.
--
--   3. The acknowledgment-settings columns land on public.profiles to
--      match where PR #8.5c will/did add Bridges Provider ID etc. If
--      PR #8.5c chose the new-table path (provider_cdc_settings)
--      instead, this migration's column adds get moved there in a
--      follow-up commit — flagged in pr-12-review.md.
--
-- Migration ordering note. PR #12 lands AFTER PR #8.5c and PR #9's
-- migration 019. It is order-independent with PRs #8.5a/b (different
-- objects), and PR #9's Rule 8 upgrade is a follow-up commit on
-- feature/i-billing-transfer-pr-9 that consumes the tables this
-- migration creates.
--
-- Editor note. All DDL, no long seed INSERT, so the web SQL Editor
-- long-statement bug (docs/runbook.md) does not apply.
-- ============================================================

-- -------------------------------------------------------
-- 1. attendance_acknowledgments
-- -------------------------------------------------------
create table if not exists public.attendance_acknowledgments (
  id                              uuid primary key default gen_random_uuid(),

  -- What is being acknowledged. attendance_id can go null when the
  -- attendance row is hard-deleted (rare; soft-delete is the norm),
  -- in which case child_id + date + segment_index still identify the
  -- acknowledged event for audit purposes.
  attendance_id                   uuid references public.attendance(id) on delete set null,
  child_id                        uuid not null references public.children(id) on delete cascade,
  date                            date not null,
  segment_index                   integer not null default 0,

  -- Who acknowledged.
  -- - acknowledged_via = 'parent_portal' → acknowledged_by_user_id is
  --   the parent's auth.uid(); acknowledged_by_guardian_id is the
  --   email-matched guardians row when one exists, NULL otherwise.
  -- - acknowledged_via = 'provider_override' → acknowledged_by_user_id
  --   is the provider's auth.uid(); acknowledged_by_guardian_id stays
  --   NULL; provider_override_reason carries the attestation text.
  acknowledged_by_guardian_id     uuid references public.guardians(id) on delete set null,
  acknowledged_by_user_id         uuid references auth.users(id) on delete set null,
  acknowledged_via                text not null check (
    acknowledged_via in ('parent_portal', 'provider_override')
  ),

  acknowledged_at                 timestamptz not null default now(),

  -- Tamper detection: stable canonical hash of {check_in, check_out,
  -- status, segment_index} computed at write time. PR #9 Rule 8
  -- recomputes and compares — a mismatch means the row was edited
  -- after acknowledgment, surfaces as `needs_reacknowledgment`.
  attendance_snapshot_hash        text not null,

  -- Required for provider overrides; must be NULL for parent_portal.
  provider_override_reason        text,

  archived_at                     timestamptz,

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  -- Channel CHECK. acknowledged_by_user_id is required either way (we
  -- always know who clicked the button). acknowledged_by_guardian_id
  -- is nullable on the parent_portal branch — see header note (2).
  constraint attendance_acknowledgments_channel_shape check (
    case acknowledged_via
      when 'parent_portal'
        then acknowledged_by_user_id is not null
             and provider_override_reason is null
      when 'provider_override'
        then acknowledged_by_user_id is not null
             and acknowledged_by_guardian_id is null
             and provider_override_reason is not null
             and length(trim(provider_override_reason)) > 0
    end
  )
);

-- Exactly one active acknowledgment per (child, date, segment).
create unique index if not exists attendance_acknowledgments_unique_active
  on public.attendance_acknowledgments (child_id, date, segment_index)
  where archived_at is null;

create index if not exists attendance_acknowledgments_attendance_idx
  on public.attendance_acknowledgments (attendance_id)
  where archived_at is null;

create trigger attendance_acknowledgments_set_updated_at
  before update on public.attendance_acknowledgments
  for each row execute function public.set_updated_at();

alter table public.attendance_acknowledgments enable row level security;

-- Provider sees acknowledgments for their own attendance rows.
create policy "Providers can view acks on their attendance"
  on public.attendance_acknowledgments for select to authenticated
  using (
    exists (
      select 1 from public.attendance a
      where a.id = attendance_acknowledgments.attendance_id
        and a.user_id = auth.uid()
    )
  );

-- Provider can create override acknowledgments for their own attendance.
create policy "Providers can override-ack their own attendance"
  on public.attendance_acknowledgments for insert to authenticated
  with check (
    acknowledged_via = 'provider_override'
    and acknowledged_by_user_id = auth.uid()
    and exists (
      select 1 from public.attendance a
      where a.id = attendance_acknowledgments.attendance_id
        and a.user_id = auth.uid()
    )
  );

-- Provider can soft-delete (archive) acks on their attendance — e.g.
-- voiding an erroneous override.
create policy "Providers can archive acks on their attendance"
  on public.attendance_acknowledgments for update to authenticated
  using (
    exists (
      select 1 from public.attendance a
      where a.id = attendance_acknowledgments.attendance_id
        and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.attendance a
      where a.id = attendance_acknowledgments.attendance_id
        and a.user_id = auth.uid()
    )
  );

-- Parent sees acks for their children. Eligibility joins through
-- parent_family_links → families → children (the existing milittlecare
-- pattern, not guardians.user_id which holds the licensee's id).
create policy "Parents can view acks on their children"
  on public.attendance_acknowledgments for select to authenticated
  using (
    child_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- Parent can record portal acknowledgments for their children.
create policy "Parents can acknowledge their children"
  on public.attendance_acknowledgments for insert to authenticated
  with check (
    acknowledged_via = 'parent_portal'
    and acknowledged_by_user_id = auth.uid()
    and child_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- -------------------------------------------------------
-- 2. acknowledgment_flags
-- -------------------------------------------------------
-- Parent dispute record. One row per (child, date, segment_index)
-- flagged event; resolution lifecycle in-place via resolved_* columns.
create table if not exists public.acknowledgment_flags (
  id                              uuid primary key default gen_random_uuid(),

  child_id                        uuid not null references public.children(id) on delete cascade,
  date                            date not null,
  segment_index                   integer not null default 0,
  attendance_id                   uuid references public.attendance(id) on delete set null,

  -- Same nullable-guardian shape as acknowledgments: parents are
  -- identified by user_id; guardian linkage is best-effort.
  flagged_by_guardian_id          uuid references public.guardians(id) on delete set null,
  flagged_by_user_id              uuid not null references auth.users(id) on delete restrict,
  flagged_at                      timestamptz not null default now(),
  reason                          text not null check (length(trim(reason)) > 0),

  -- Resolution lifecycle.
  resolved_at                     timestamptz,
  resolved_by_user_id             uuid references auth.users(id) on delete set null,
  resolution_note                 text,
  resolution_action               text check (
    resolution_action is null
    or resolution_action in (
      'attendance_corrected', 'parent_withdrew_flag', 'provider_explained'
    )
  ),

  archived_at                     timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  -- Resolution columns are all-or-nothing.
  constraint acknowledgment_flags_resolution_shape check (
    (resolved_at is null
       and resolved_by_user_id is null
       and resolution_action is null
       and resolution_note is null)
    or
    (resolved_at is not null
       and resolved_by_user_id is not null
       and resolution_action is not null)
  )
);

create index if not exists acknowledgment_flags_unresolved_idx
  on public.acknowledgment_flags (child_id, date)
  where archived_at is null and resolved_at is null;

create index if not exists acknowledgment_flags_by_attendance_idx
  on public.acknowledgment_flags (attendance_id)
  where archived_at is null;

create trigger acknowledgment_flags_set_updated_at
  before update on public.acknowledgment_flags
  for each row execute function public.set_updated_at();

alter table public.acknowledgment_flags enable row level security;

-- Provider sees flags on their attendance.
create policy "Providers can view flags on their attendance"
  on public.acknowledgment_flags for select to authenticated
  using (
    exists (
      select 1 from public.attendance a
      where a.id = acknowledgment_flags.attendance_id
        and a.user_id = auth.uid()
    )
    or
    -- Fallback when attendance_id was nulled out by a deletion: scope
    -- by child to the provider that owns the child's family.
    child_id in (
      select c.id from public.children c
      where c.user_id = auth.uid()
    )
  );

-- Provider can resolve flags on their attendance (UPDATE).
create policy "Providers can resolve flags on their attendance"
  on public.acknowledgment_flags for update to authenticated
  using (
    exists (
      select 1 from public.attendance a
      where a.id = acknowledgment_flags.attendance_id
        and a.user_id = auth.uid()
    )
    or
    child_id in (
      select c.id from public.children c
      where c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.attendance a
      where a.id = acknowledgment_flags.attendance_id
        and a.user_id = auth.uid()
    )
    or
    child_id in (
      select c.id from public.children c
      where c.user_id = auth.uid()
    )
  );

-- Parent sees their children's flags.
create policy "Parents can view flags on their children"
  on public.acknowledgment_flags for select to authenticated
  using (
    child_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- Parent can raise a flag on their children's attendance.
create policy "Parents can flag their children's attendance"
  on public.acknowledgment_flags for insert to authenticated
  with check (
    flagged_by_user_id = auth.uid()
    and child_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- Parent can withdraw their own flag (UPDATE). The provider-resolution
-- policy above also allows the provider to update; both paths land in
-- the same row, distinguished by resolution_action.
create policy "Parents can withdraw their own flags"
  on public.acknowledgment_flags for update to authenticated
  using (flagged_by_user_id = auth.uid())
  with check (flagged_by_user_id = auth.uid());

-- -------------------------------------------------------
-- 3. notification_log
-- -------------------------------------------------------
-- General-purpose infrastructure (per addendum § 8.1). Future
-- notification types (training countdowns, payment-received) reuse
-- this table by setting a different `notification_type`. RLS scopes
-- by the recipient_guardian_id → guardians.user_id → provider link so
-- providers see their own send history; no parent-facing read.
create table if not exists public.notification_log (
  id                              uuid primary key default gen_random_uuid(),

  recipient_guardian_id           uuid references public.guardians(id) on delete set null,
  recipient_email                 text not null,
  notification_type               text not null,             -- 'acknowledgment_digest' here
  sent_at                         timestamptz,
  delivery_status                 text check (
    delivery_status is null
    or delivery_status in ('queued', 'sent', 'delivered', 'bounced', 'failed')
  ),
  provider_message_id             text,                       -- Resend's id
  error_detail                    text,
  payload_summary                 jsonb,                      -- PII-minimised summary

  created_at                      timestamptz not null default now()
);

create index if not exists notification_log_recipient_recent_idx
  on public.notification_log (recipient_guardian_id, created_at desc);

create index if not exists notification_log_status_recent_idx
  on public.notification_log (delivery_status, created_at desc)
  where delivery_status in ('bounced', 'failed');

alter table public.notification_log enable row level security;

-- Provider sees notifications sent for guardians on their own roster.
-- The guardians.user_id here IS the licensee's id (the established
-- semantics, not the parent linkage referenced elsewhere in this file).
create policy "Providers can view notifications for their roster"
  on public.notification_log for select to authenticated
  using (
    exists (
      select 1 from public.guardians g
      where g.id = notification_log.recipient_guardian_id
        and g.user_id = auth.uid()
    )
  );

-- No INSERT policy — writes come from the Vercel cron serverless
-- function via the service role, which bypasses RLS. No DELETE,
-- no UPDATE: notification log is append-only audit.

-- -------------------------------------------------------
-- 4. Per-provider acknowledgment settings on public.profiles
-- -------------------------------------------------------
-- See header note (3). If PR #8.5c chose the new-table path, these
-- column adds get relocated to that table in a follow-up commit.
alter table public.profiles
  add column if not exists acknowledgment_cadence text
    default 'weekly'
    check (acknowledgment_cadence in ('weekly', 'daily')),
  add column if not exists acknowledgment_strictness text
    default 'warning'
    check (acknowledgment_strictness in ('warning', 'strict')),
  add column if not exists acknowledgment_email_enabled boolean
    default true,
  add column if not exists acknowledgment_email_send_day integer
    default 5
    check (acknowledgment_email_send_day between 0 and 6),
  add column if not exists acknowledgment_email_send_hour integer
    default 17
    check (acknowledgment_email_send_hour between 0 and 23),
  add column if not exists acknowledgment_email_timezone text
    default 'America/Detroit';

comment on column public.profiles.acknowledgment_cadence is
  '''weekly'' (default) or ''daily''. Drives how often the Vercel cron job '
  'composes and sends the parent-digest email.';

comment on column public.profiles.acknowledgment_strictness is
  '''warning'' (default) or ''strict''. Strict makes PR #9 Rule 8 block '
  'export when any billed day is unacknowledged; warning surfaces it '
  'without blocking.';

comment on column public.profiles.acknowledgment_email_send_day is
  '0 = Sunday … 6 = Saturday. 5 = Friday by default. Only honored when '
  'acknowledgment_cadence = ''weekly''.';

comment on column public.profiles.acknowledgment_email_send_hour is
  '24h, in the provider''s local time as identified by '
  'acknowledgment_email_timezone. Default 17 (5 PM).';

-- -------------------------------------------------------
-- 5. Per-parent receive-email toggle on public.parent_profiles
-- -------------------------------------------------------
-- Section 10.3 — a parent can opt out of receiving the digest without
-- affecting the provider's send schedule. The Vercel cron job filters
-- on this column before composing each recipient's email.
alter table public.parent_profiles
  add column if not exists acknowledgment_email_opt_in boolean
    default true;

comment on column public.parent_profiles.acknowledgment_email_opt_in is
  'Per-parent receive switch for the acknowledgment digest. true (default) '
  'means the parent receives weekly/daily reminders; false suppresses sends '
  'to this parent regardless of the provider''s cadence.';

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- alter table public.parent_profiles
--   drop column if exists acknowledgment_email_opt_in;
--
-- alter table public.profiles
--   drop column if exists acknowledgment_email_timezone,
--   drop column if exists acknowledgment_email_send_hour,
--   drop column if exists acknowledgment_email_send_day,
--   drop column if exists acknowledgment_email_enabled,
--   drop column if exists acknowledgment_strictness,
--   drop column if exists acknowledgment_cadence;
--
-- drop table if exists public.notification_log;
-- drop table if exists public.acknowledgment_flags;
-- drop table if exists public.attendance_acknowledgments;
