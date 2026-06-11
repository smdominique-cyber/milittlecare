# PR Scope — Parent Self-Service Phase Y: Medium-Risk Templates + Typed-Signature E-Sign

**Date:** 2026-06-04
**Status:** Scope — **DRAFT for review.** The design is LOCKED by
the parent doc `docs/pr-parent-self-service-scope.md` (read it
first; this doc does NOT re-litigate). The genuinely open calls
here are: (a) the exact schema shape — extension columns +
CHECK + new tables vs. riding existing infrastructure
(recommendations below; Seth confirms); (b) the snapshot-at-
completion semantics in the face of a between-send-and-completion
template edit (recommendation below + an open question on stale-
read 409 behavior); (c) the sub-split into Y1 (schema +
compliance-evidence boundary) vs Y2 (UI + flows). The template
starter wording is **explicitly flagged for human / consultant
legal review** — CC drafts the COMPLIANCE-REQUIRED ELEMENTS per
rule; final language is Seth + licensing consultant.
**Parent doc:** `docs/pr-parent-self-service-scope.md`. Phase X
(`feature/parent-self-service-phase-x` + `…-emergency-refresh`)
landed in production with migration 031.
**Branch (suggested, sub-split):** `feature/parent-self-service-phase-y1-evidence-boundary` first; `feature/parent-self-service-phase-y2-ui` after Y1's verification passes.

---

## Summary

Phase Y is the highest-stakes build in the parent-self-service
arc. It introduces the **compliance-evidence boundary** — the
completed e-sign acknowledgments row IS the artifact an inspector
reads as the parent's written permission. Three properties matter
absolutely:

1. **The row is self-contained.** No JOIN required to surface what
   the parent agreed to. Template body is snapshotted onto the
   row.
2. **The snapshot survives later template edits.** If the provider
   edits the template after the parent signs, the parent's row
   STILL shows what they actually saw.
3. **The cross-tenant / authorization boundary holds** with the
   same caliber as the consent-attachments cross-tenant gate.
   Parent A cannot complete a consent sent to parent B's child;
   provider opt-in actually gates self-completion server-side.

Two sub-phases (see §1):

- **Y1 — Schema + RPCs + the evidence-record boundary.** New
  channel value `parent_portal_esign`, new acknowledgments
  columns, the two SECURITY DEFINER RPCs, the `consent_templates`
  + `consents_pending_esign` tables, the `medium_risk_consents_enabled`
  toggle storage. Verifies the boundary in isolation with the live
  gate before any UI ships.
- **Y2 — Templates UI + provider send + parent completion.** The
  Business-tab category toggles, the template editor, the
  per-child send affordance, the parent's pending-to-do card +
  type-name-to-sign form. All UI; the data layer is locked from
  Y1.

What this scope does NOT do: revoke / amend mechanics (provider
amends on paper for V1); medication parent e-sign (out of
self-service entirely until a future PR); religious-objection or
immunization waivers (excluded per Seth); per-template versioning
UI (each edit archives prior + inserts new; only current edits);
multi-parent co-sign (single-parent in V1); pre-fill the typed
name from `parent_profiles.full_name` (leave empty so typing IS
the affirmative gesture — per parent doc §13 recommendation; Seth
to confirm).

---

## DECISIONS — RESOLVED (with the genuine open ones flagged)

| # | Decision | Resolution |
|---|---|---|
| 1 | The five medium-risk template types | **LOCKED (parent doc §3a):** `field_trip_permission`, `transportation_routine_annual`, `transportation_nonroutine_per_trip`, `water_activities_on_premises_seasonal`, `water_activities_off_premises_per_trip`. No new ACK_TYPES needed — these strings already exist in `src/lib/acknowledgments.js`. |
| 2 | The new acknowledged_via channel | **LOCKED (parent doc §6a):** `'parent_portal_esign'`. Joins the existing CHECK constraint set. |
| 3 | Snapshot mechanic — at SEND vs at COMPLETION | **LOCKED (parent doc decision 7): at COMPLETION.** The completion RPC reads the current template body server-side at completion time and snapshots it into the acknowledgments row. Send-time stash exists too (`consents_pending_esign.template_body_at_send`) to give the parent stable text to read, but the AUTHORITATIVE snapshot is what the parent saw at the moment they signed. **OPEN sub-decision (§3b below):** what if the provider edited the template between send and completion? Recommendation: completion RPC returns a 409-equivalent (`template_changed_since_send`) and forces re-confirmation; Seth approves §13 OQ#3. |
| 4 | Provider opt-in storage | **LOCKED:** `profiles.medium_risk_consents_enabled jsonb` with one key per consent_type, all `false` by default. Server-side authoritative — the send RPC refuses if the category isn't enabled. |
| 5 | Pending queue: new table vs ride on `reminder_instances` | **LOCKED: new `consents_pending_esign` table.** (Recommendation per parent doc §6e.) Reasons: (a) the row needs to hold the template body at send + the per-send overrides (trip date, destination, water body type) + a snapshot of what's pending — `reminder_instances`'s schema doesn't have those columns; (b) the resolved-via field needs to distinguish parent-completed from provider-rescinded, which `reminder_instances.resolved_at` alone can't express; (c) overloading reminder_instances would force per-category branching in `api/cron-dispatch-reminders.js` for a different semantic. A row in `reminder_instances` is STILL written alongside the pending-esign row (for the existing email-dispatch path), but the pending state of record lives in `consents_pending_esign`. |
| 6 | New table: `consent_templates` | **LOCKED:** per-provider templates. One active row per (provider_id, consent_type) via partial-unique index. Editing = archive prior + insert new (mirrors Phase B archive-then-insert protocol). |
| 7 | Send + complete RPC pattern | **LOCKED: mirror migration 025's `intake_confirm_for_parent`.** Two new RPCs: `consent_esign_send` and `consent_esign_complete`. Authorization via `parent_family_links` active-link join (same shape). SECURITY DEFINER. Server-authoritative on every security-critical field. |
| 8 | PARENT_SIGNED_SATISFYING_CHANNELS update | **LOCKED:** add `'parent_portal_esign'` to ALL THREE in-tree copies — `src/lib/childFiles.js` (source-of-truth), `src/lib/complianceState.js` (duplicated to avoid supabase pull-in), `src/lib/medication.js` (duplicated for the same reason). The backward-compat test in `complianceState.test.js` (the duplication invariant) is updated in lockstep. **Confirmed via grep on 2026-06-04:** three copies exist; missing one means the engine reads an e-signed consent as "pending" rather than "on file." |
| 9 | Schema for the new acknowledgments columns | **LOCKED with one sub-call for Seth (§13 OQ#1):** add `typed_signature_text text`, `template_snapshot_text text`, `consent_template_id uuid REFERENCES public.consent_templates(id) ON DELETE SET NULL`. Plus a CHECK constraint `chk_acknowledgments_esign_shape` that REQUIRES non-null signature + snapshot when `acknowledged_via = 'parent_portal_esign'` AND requires NULL when channel is anything else. The CHECK is the structural guard against an esign row missing the signature OR a non-esign row accidentally carrying signature data. |
| 10 | Sub-split | **LOCKED: Y1 = schema + RPCs + boundary verification; Y2 = UI + flows.** §1 below. Each verifies its own gate; Y2 cannot start until Y1's compliance-evidence boundary passes live verification. |
| 11 | Template starter wording | **LOCKED IN STRUCTURE; OPEN IN WORDING.** CC drafts the COMPLIANCE-REQUIRED ELEMENTS per rule (§4 below). The literal sentences are flagged for Seth + licensing consultant review BEFORE Y2 ships. Y1 doesn't need template wording — it just needs the table to exist. |
| 12 | Engine connection | **LOCKED:** once #8 lands, the engine's Pattern A `state_resolver` for requirements #13-17 in the registry reads e-signed rows as `on_file` without code change. Verified by an addition to `complianceState.test.js` asserting `parent_portal_esign` satisfies. |
| 13 | Verification gate caliber | **LOCKED: live + boundary-strength.** Same caliber as the consent-attachments cross-tenant gate. §8 below. |
| 14 | What changes the row shape AFTER it's written | **LOCKED: NOTHING.** Once an e-sign acknowledgments row is written, it's WORM (write-once read-many) on the compliance-relevant columns. The trigger in §3c blocks UPDATEs to `typed_signature_text` and `template_snapshot_text` regardless of caller role. Only `archived_at` is mutable (provider archives via the existing provider UPDATE policy). |

---

## §1. Sub-split — Y1 first, Y2 second

The build is too big and the boundary too strict to verify all at
once. Split:

### Y1 — Schema + RPCs + compliance-evidence boundary

**What ships:**
- Migration **033** (next sequential after 031; 032 was deleted
  on `feature/parent-self-service-phase-x-emergency-refresh`).
- The two RPCs: `consent_esign_send`, `consent_esign_complete`
  (+ a third `consent_esign_rescind` for the provider rescind path).
- `consent_templates` + `consents_pending_esign` tables.
- The acknowledgments column extensions + CHECK + WORM trigger.
- `profiles.medium_risk_consents_enabled` jsonb.
- The engine's `PARENT_SIGNED_SATISFYING_CHANNELS` updated in all
  three copies + the backward-compat test extended.
- A thin scriptable verification harness (or a documented set of
  Supabase Studio session SQL) for the eight-step live boundary
  gate (§8).

**What does NOT ship in Y1:**
- Business-tab UI for enable/templates.
- Provider send affordance on the child's record.
- Parent pending-to-do + completion UI.
- Notification email copy for the parent.

**Y1 gate (hard):** the eight-step live boundary verification
in §8, run against real seed accounts (Jeff/2549scio,
klsnay/Audrey, Dominique). NO MERGE until all eight pass. NO Y2
work begins until Y1 merges.

### Y2 — UI + flows on the verified data layer

**What ships:**
- BusinessInfoPage section: per-category enable toggles +
  template management.
- Provider's "Send consent for e-signature" UI from the child's
  record (FamiliesPage child detail).
- Parent's pending-to-do card on `/parent/acknowledge` (likely a
  fourth tab "To-do" or expansion of the existing Intake tab —
  Seth picks per §13 OQ#4).
- The typed-name e-sign completion form.
- Notification email copy for the parent send.

**Y2 gate:**
- Live verification on preview: provider enables a category,
  edits a template, sends to a real parent fixture, parent
  receives notification + sees pending card, completes via
  typed signature, completed row in `acknowledgments` matches
  expectations.
- No regression on Phase X surfaces.

### Why split

1. **Boundary verifies alone.** Y1's eight-step gate is the
   strictest in the arc. Tangling it with UI changes makes a
   gate failure hard to isolate (which side: data, RPC, UI?).
2. **Smaller PR review surface.** Y1 is migration + RPCs + tests.
   Y2 is UI + UX. Different review modes.
3. **Y1 ships sooner.** The schema can land in production behind
   the OFF-by-default enable toggle without any user-visible
   surface. Y2 unblocks the surface when ready.
4. **Phased rollback.** If Y2 has an issue, rolling back doesn't
   touch the data layer. If Y1 has an issue (unlikely after live
   verification), rolling back is a single migration.

---

## §2. The schema — exact shape (Y1)

### §2a. ALTER acknowledgments

```sql
-- 1. Expand the channel CHECK to allow the new value.
alter table public.acknowledgments
  drop constraint chk_acknowledgments_via;
alter table public.acknowledgments
  add constraint chk_acknowledgments_via check (
    acknowledged_via in (
      'parent_portal',
      'provider_override',
      'in_person_paper',
      'parent_portal_esign'        -- NEW (Phase Y)
    )
  );

-- 2. New columns for the e-sign payload. NULL for non-esign rows;
--    NOT NULL for esign rows (enforced by the CHECK below).
alter table public.acknowledgments
  add column if not exists typed_signature_text    text,
  add column if not exists template_snapshot_text  text,
  add column if not exists consent_template_id     uuid
    references public.consent_templates(id) on delete set null;

-- 3. Channel-shape CHECK: enforces the WORM invariant at write time.
--    parent_portal_esign MUST carry signature + snapshot;
--    any other channel MUST leave them NULL.
alter table public.acknowledgments
  add constraint chk_acknowledgments_esign_shape check (
    (acknowledged_via = 'parent_portal_esign'
       and typed_signature_text   is not null
       and template_snapshot_text is not null
       and length(trim(typed_signature_text))   > 0
       and length(trim(template_snapshot_text)) > 0)
    or
    (acknowledged_via <> 'parent_portal_esign'
       and typed_signature_text   is null
       and template_snapshot_text is null)
  );
```

**Why the FK is `ON DELETE SET NULL`, not CASCADE:** if the
provider later deletes a template, the parent's signed row must
NOT cascade-delete (it's the compliance evidence). Setting
`consent_template_id` to NULL preserves the row; the lineage is
lost, but the `template_snapshot_text` retains the verbatim text
the parent agreed to. The completed row is self-contained per
parent doc §6a.

**Note on the FK order:** the `references public.consent_templates(id)`
in step 2 requires `consent_templates` to exist FIRST. In the
migration: create `consent_templates` BEFORE altering
`acknowledgments`. See §2c migration order.

### §2b. WORM trigger on the e-sign columns

```sql
-- Block UPDATEs to typed_signature_text + template_snapshot_text
-- on any existing row. The CHECK constraint above guards the
-- INSERT; this trigger guards UPDATE. Combined: WORM on those
-- two columns. Archive is unaffected (archived_at is mutable
-- by the provider per the existing UPDATE policy).
create or replace function public.block_esign_evidence_update()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then
    return NEW;
  end if;
  if NEW.typed_signature_text   is distinct from OLD.typed_signature_text
  or NEW.template_snapshot_text is distinct from OLD.template_snapshot_text
  or NEW.consent_template_id    is distinct from OLD.consent_template_id
  then
    raise exception 'block_esign_evidence_update: signature_text / template_snapshot_text / consent_template_id are WORM on the acknowledgments row (compliance evidence)'
      using errcode = '42501';
  end if;
  return NEW;
end;
$$;

create trigger block_esign_evidence_update_trg
  before update on public.acknowledgments
  for each row execute function public.block_esign_evidence_update();
```

**Cost note:** this trigger fires on EVERY acknowledgments UPDATE
(every archive, every provider re-acknowledgment). The body is
three IS-DISTINCT-FROM checks against three columns — trivial.
Not a hot-path concern.

### §2c. New table: `consent_templates`

```sql
create table public.consent_templates (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references auth.users(id) on delete cascade,
  consent_type        text not null,
  -- One of the five medium-risk values:
  --   'field_trip_permission'
  --   'transportation_routine_annual'
  --   'transportation_nonroutine_per_trip'
  --   'water_activities_on_premises_seasonal'
  --   'water_activities_off_premises_per_trip'
  -- Validated at the application catalog (ACK_TYPES); no DB CHECK
  -- per the same OQ3-style reasoning as migrations 024 + 023.
  label               text not null,         -- "Field trip permission — Smith Family Daycare"
  body_text           text not null,         -- the literal paragraph parents will read
  body_text_version   integer not null default 1,  -- bumps on edit
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index consent_templates_active_unique
  on public.consent_templates (provider_id, consent_type)
  where archived_at is null;

create index consent_templates_provider
  on public.consent_templates (provider_id);
```

**RLS:**
- Provider full CRUD on their own templates
  (`provider_id = auth.uid()`).
- Parents have **NO direct SELECT** on `consent_templates`.
  Parents see template text ONLY through the `template_snapshot_text`
  column on a sent / completed acknowledgments row (or via the
  pending-esign row's `template_body_at_send`). The boundary is
  intentional: a parent cannot enumerate a provider's templates.

### §2d. New table: `consents_pending_esign`

```sql
create table public.consents_pending_esign (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,
  child_id                 uuid not null references public.children(id) on delete cascade,
  consent_type             text not null,
  consent_template_id      uuid not null references public.consent_templates(id),
  -- Stable text the parent sees between send and completion. The
  -- AUTHORITATIVE snapshot is on the acknowledgments row at
  -- completion (per decision 7); this column is the in-flight
  -- working copy.
  template_body_at_send    text not null,
  -- Per-occurrence metadata for the per-trip / per-outing types.
  -- Same `{event_date, description}` shape as the existing Phase C
  -- occurrence_metadata column. NULL for the durable types
  -- (field_trip_permission, transportation_routine_annual,
  -- water_activities_on_premises_seasonal).
  per_send_metadata        jsonb,
  sent_at                  timestamptz not null default now(),
  -- Optional expiry. Default null = no expiry; the provider may
  -- choose to expire a per-trip consent N days after sent_at.
  expires_at               timestamptz,
  -- Set when the parent completes OR the provider rescinds.
  -- NULL means "pending."
  resolved_at              timestamptz,
  resolved_via             text
    check (resolved_via is null or resolved_via in ('parent_completed', 'provider_rescinded', 'expired')),
  -- On parent_completed: the acknowledgments row that was
  -- written. Provides the link from pending → completed without
  -- a search.
  resolved_acknowledgment_id uuid references public.acknowledgments(id) on delete set null,
  archived_at              timestamptz,
  created_at               timestamptz not null default now()
);

-- Partial unique: at most one ACTIVE pending row per
-- (provider, child, consent_type) at a time. A duplicate send
-- for the same child + same consent type while one is already
-- pending requires the provider rescind the prior first.
-- (Per-occurrence types are EXEMPT — multiple pending per-trip
-- consents for the same child are expected; per_send_metadata
-- discriminates them.)
create unique index consents_pending_esign_active_unique
  on public.consents_pending_esign (provider_id, child_id, consent_type)
  where archived_at is null
    and resolved_at is null
    and consent_type not in (
      'transportation_nonroutine_per_trip',
      'water_activities_off_premises_per_trip'
    );

create index consents_pending_esign_active_child
  on public.consents_pending_esign (child_id, resolved_at)
  where archived_at is null;
```

**RLS:**
- Provider SELECT/INSERT/UPDATE on own rows
  (`provider_id = auth.uid()`).
- Parents SELECT rows targeting children they're linked to via
  `parent_family_links` (mirrors the migration 024
  `acknowledgments` parent SELECT policy shape). Parent
  SELECT for pending-state only; completion lives in
  acknowledgments. Insert by parents = NO (the send is a
  provider action via RPC). Update by parents = NO (completion
  goes through the RPC which writes the acknowledgments row,
  not directly to this pending row — the RPC server-side
  updates `resolved_at` / `resolved_acknowledgment_id`).

### §2e. New profiles column

```sql
alter table public.profiles
  add column if not exists medium_risk_consents_enabled jsonb
    not null default jsonb_build_object(
      'field_trip_permission',                  false,
      'transportation_routine_annual',          false,
      'transportation_nonroutine_per_trip',     false,
      'water_activities_on_premises_seasonal',  false,
      'water_activities_off_premises_per_trip', false
    );
```

Server-authoritative gate. Every `consent_esign_send` RPC call
checks `profile.medium_risk_consents_enabled ->> p_consent_type
= 'true'` before producing a pending row.

### §2f. Migration order summary

Migration 033:
1. Create `consent_templates` (so the FK in step 4 has a target).
2. Create `consents_pending_esign`.
3. Add `medium_risk_consents_enabled` to `profiles`.
4. ALTER `acknowledgments` columns + CHECK constraints +
   `consent_template_id` FK.
5. Create the `block_esign_evidence_update` function + trigger.
6. Create the three RPCs (`consent_esign_send`,
   `consent_esign_complete`, `consent_esign_rescind`).
7. RLS policies on the two new tables.
8. Verification queries in the header (Seth runs BEFORE writing
   the runbook entry).

---

## §3. The three SECURITY DEFINER RPCs

### §3a. `consent_esign_send` (provider action)

```sql
create or replace function public.consent_esign_send(
  p_child_id         uuid,
  p_consent_type     text,
  p_per_send_metadata jsonb default null,
  p_expires_at       timestamptz default null
) returns uuid       -- the new consents_pending_esign.id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider_id      uuid := auth.uid();
  v_child_user_id    uuid;
  v_enabled          boolean;
  v_active_template  uuid;
  v_active_body      text;
  v_pending_id       uuid;
begin
  -- 1. Input sanity.
  if p_child_id is null then
    raise exception 'consent_esign_send: p_child_id is required';
  end if;
  if p_consent_type is null or p_consent_type not in (
    'field_trip_permission',
    'transportation_routine_annual',
    'transportation_nonroutine_per_trip',
    'water_activities_on_premises_seasonal',
    'water_activities_off_premises_per_trip'
  ) then
    raise exception 'consent_esign_send: invalid p_consent_type';
  end if;
  if v_provider_id is null then
    raise exception 'consent_esign_send: no authenticated caller';
  end if;

  -- 2. Authorization: caller owns the child.
  select c.user_id into v_child_user_id
    from public.children c
   where c.id = p_child_id
     and c.archived_at is null;
  if v_child_user_id is null then
    raise exception 'consent_esign_send: child not found or archived';
  end if;
  if v_child_user_id <> v_provider_id then
    raise exception 'consent_esign_send: caller is not the provider for this child'
      using errcode = '42501';
  end if;

  -- 3. Category enable gate.
  select (medium_risk_consents_enabled ->> p_consent_type)::boolean
    into v_enabled
    from public.profiles
   where id = v_provider_id;
  if not coalesce(v_enabled, false) then
    raise exception 'consent_esign_send: category % is not enabled for this provider', p_consent_type
      using errcode = '42501';
  end if;

  -- 4. Active template for this (provider, consent_type).
  select id, body_text
    into v_active_template, v_active_body
    from public.consent_templates
   where provider_id = v_provider_id
     and consent_type = p_consent_type
     and archived_at is null;
  if v_active_template is null then
    raise exception 'consent_esign_send: no active template for consent_type %', p_consent_type;
  end if;

  -- 5. Per-occurrence metadata required for per-trip types.
  if p_consent_type in ('transportation_nonroutine_per_trip', 'water_activities_off_premises_per_trip') then
    if p_per_send_metadata is null
       or p_per_send_metadata ->> 'event_date'  is null
       or p_per_send_metadata ->> 'description' is null
    then
      raise exception 'consent_esign_send: per-occurrence types require per_send_metadata with event_date + description';
    end if;
  end if;

  -- 6. Insert the pending row.
  insert into public.consents_pending_esign (
    provider_id, child_id, consent_type, consent_template_id,
    template_body_at_send, per_send_metadata, sent_at, expires_at
  ) values (
    v_provider_id, p_child_id, p_consent_type, v_active_template,
    v_active_body, p_per_send_metadata, now(), p_expires_at
  )
  returning id into v_pending_id;

  -- 7. Write a notification_log row so the existing
  --    api/cron-dispatch-reminders.js / notify-state-change
  --    substrate can email the parent. Column shape verbatim per
  --    api/notify-state-change.js + api/cron-dispatch-reminders.js.
  --    The dispatcher resolves the parent email from
  --    parent_family_links + parent_profiles at send time.
  insert into public.notification_log (
    recipient_type, recipient_id, recipient_email,
    change_type, change_description,
    changed_by_user_id, changed_by_role,
    family_id, child_id,
    email_sent, email_sent_at, email_id,
    metadata
  )
  select
    'parent', null, null,
    'consent_esign_send',
    'A consent is awaiting your signature in the portal',
    v_provider_id, 'provider',
    c.family_id, c.id,
    false, null, null,
    jsonb_build_object(
      'consent_type',           p_consent_type,
      'pending_esign_id',       v_pending_id,
      'consent_template_id',    v_active_template,
      'per_send_metadata',      p_per_send_metadata,
      'cta_path',               '/parent/acknowledge?tab=todo&pending=' || v_pending_id::text
    )
   from public.children c
   where c.id = p_child_id;

  return v_pending_id;
end;
$$;

revoke all  on function public.consent_esign_send(uuid, text, jsonb, timestamptz) from public;
grant execute on function public.consent_esign_send(uuid, text, jsonb, timestamptz) to authenticated;
```

### §3b. `consent_esign_complete` (parent action)

```sql
create or replace function public.consent_esign_complete(
  p_pending_id            uuid,
  p_typed_signature_text  text,
  -- Per parent doc §10a stale-read protection: the client passes
  -- the body it last showed the parent; the RPC compares against
  -- the current template body and either accepts or returns a
  -- "template changed since you saw it" signal so the UI can
  -- re-confirm.
  p_template_body_seen    text
) returns uuid       -- the new acknowledgments.id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id            uuid := auth.uid();
  v_pending              public.consents_pending_esign;
  v_current_body         text;
  v_provider_id          uuid;
  v_child_family_id      uuid;
  v_ack_id               uuid;
begin
  -- 1. Input sanity.
  if p_pending_id is null then
    raise exception 'consent_esign_complete: p_pending_id is required';
  end if;
  if p_typed_signature_text is null
     or length(trim(p_typed_signature_text)) = 0 then
    raise exception 'consent_esign_complete: typed_signature_text required';
  end if;
  if v_parent_id is null then
    raise exception 'consent_esign_complete: no authenticated caller';
  end if;

  -- 2. Load the pending row + lock it for the transaction so two
  --    parallel completes can't both write acknowledgments rows.
  select * into v_pending
    from public.consents_pending_esign
   where id = p_pending_id
     and archived_at is null
     and resolved_at is null
   for update;
  if v_pending.id is null then
    raise exception 'consent_esign_complete: pending row not found, already resolved, or rescinded'
      using errcode = '42501';
  end if;

  -- 3. Authorization: parent must be linked to this child's family.
  select c.family_id, c.user_id
    into v_child_family_id, v_provider_id
    from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
   where c.id = v_pending.child_id
     and c.archived_at is null
     and pfl.parent_id = v_parent_id
     and pfl.status    = 'active';
  if v_provider_id is null then
    raise exception 'consent_esign_complete: caller is not an active parent for this child'
      using errcode = '42501';
  end if;

  -- 4. Optional expiry check.
  if v_pending.expires_at is not null and v_pending.expires_at <= now() then
    -- Mark expired in the same transaction.
    update public.consents_pending_esign
       set resolved_at = now(),
           resolved_via = 'expired'
     where id = v_pending.id;
    raise exception 'consent_esign_complete: this consent expired on %', v_pending.expires_at
      using errcode = '42501';
  end if;

  -- 5. Snapshot at completion: read the CURRENT template body.
  --    Two failure modes to distinguish:
  --      (a) Template archived since send → reject; provider must
  --          send a fresh one.
  --      (b) Template body changed since the parent loaded it
  --          (stale-read) → reject with 'template_changed_since_send'
  --          so the UI can refresh and re-confirm.
  --    Per decision 3 + §13 OQ#3.
  select body_text into v_current_body
    from public.consent_templates
   where id = v_pending.consent_template_id
     and archived_at is null;
  if v_current_body is null then
    raise exception 'consent_esign_complete: the source template has been archived; provider must send a fresh consent'
      using errcode = '42501';
  end if;
  if v_current_body is distinct from p_template_body_seen then
    -- Stale-read. The parent showed the OLD body; the template was
    -- edited mid-session. The UI re-fetches and prompts the parent
    -- to re-read the new body before re-submitting.
    raise exception 'consent_esign_complete: template_changed_since_send'
      using errcode = 'P0001',
            detail  = 'The template was updated after you opened this page. Refresh and review the new wording.';
  end if;

  -- 6. Insert the acknowledgments row. The new CHECK
  --    (chk_acknowledgments_esign_shape) enforces that signature
  --    + snapshot are populated; the WORM trigger blocks any future
  --    update.
  insert into public.acknowledgments (
    provider_id, type, subject_type, subject_id,
    acknowledged_by_user_id, acknowledged_by_label,
    acknowledged_via, acknowledged_at, provider_override_reason,
    snapshot_hash, snapshot_version,
    typed_signature_text, template_snapshot_text, consent_template_id,
    -- Per-occurrence rows ride the same occurrence_metadata
    -- column that migration 027 added. For durable types it's NULL.
    occurrence_metadata
  ) values (
    v_provider_id,
    v_pending.consent_type,
    'child',
    v_pending.child_id,
    v_parent_id,
    null,
    'parent_portal_esign',
    now(),
    null,
    null,                                  -- snapshot_hash unused for esign rows
    'v1',
    p_typed_signature_text,
    v_current_body,                        -- AUTHORITATIVE snapshot
    v_pending.consent_template_id,
    case when v_pending.consent_type in (
      'transportation_nonroutine_per_trip',
      'water_activities_off_premises_per_trip'
    ) then v_pending.per_send_metadata
    else null end
  )
  returning id into v_ack_id;

  -- 7. Mark the pending row resolved.
  update public.consents_pending_esign
     set resolved_at = now(),
         resolved_via = 'parent_completed',
         resolved_acknowledgment_id = v_ack_id
   where id = v_pending.id;

  -- 8. Resolve any open reminder_instances for the parent-to-do
  --    surface (mirrors the intake_confirm_for_parent inline
  --    resolve at migration 025 step 5).
  update public.reminder_instances ri
     set resolved_at = now()
   where ri.subject_type = 'child'
     and ri.subject_id   = v_pending.child_id
     and ri.category     = 'consent_esign_pending'
     and ri.resolved_at  is null
     and ri.archived_at  is null;

  -- 9. Provider-facing notification on completion (mirrors the
  --    Phase X care-critical edit pattern).
  insert into public.notification_log (
    recipient_type, recipient_id, recipient_email,
    change_type, change_description,
    changed_by_user_id, changed_by_role,
    family_id, child_id,
    email_sent, email_sent_at, email_id,
    metadata
  ) values (
    'provider', v_provider_id, null,
    'consent_esign_completed',
    'A parent signed a consent in the portal',
    v_parent_id, 'parent',
    v_child_family_id, v_pending.child_id,
    false, null, null,
    jsonb_build_object(
      'consent_type',         v_pending.consent_type,
      'acknowledgment_id',    v_ack_id,
      'consent_template_id',  v_pending.consent_template_id
    )
  );

  return v_ack_id;
end;
$$;

revoke all  on function public.consent_esign_complete(uuid, text, text) from public;
grant execute on function public.consent_esign_complete(uuid, text, text) to authenticated;
```

### §3c. `consent_esign_rescind` (provider action)

```sql
create or replace function public.consent_esign_rescind(
  p_pending_id uuid,
  p_reason     text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider_id   uuid := auth.uid();
  v_pending_owner uuid;
begin
  if p_pending_id is null then
    raise exception 'consent_esign_rescind: p_pending_id required';
  end if;
  if v_provider_id is null then
    raise exception 'consent_esign_rescind: no authenticated caller';
  end if;

  select provider_id into v_pending_owner
    from public.consents_pending_esign
   where id = p_pending_id
     and archived_at is null
     and resolved_at is null
   for update;
  if v_pending_owner is null then
    raise exception 'consent_esign_rescind: pending row not found or already resolved';
  end if;
  if v_pending_owner <> v_provider_id then
    raise exception 'consent_esign_rescind: caller is not the provider for this pending row'
      using errcode = '42501';
  end if;

  update public.consents_pending_esign
     set resolved_at   = now(),
         resolved_via  = 'provider_rescinded',
         per_send_metadata = case
            when p_reason is not null then
              coalesce(per_send_metadata, '{}'::jsonb) || jsonb_build_object('rescind_reason', p_reason)
            else per_send_metadata
         end
   where id = p_pending_id;

  -- Resolve any open reminder_instances for this pending row.
  update public.reminder_instances ri
     set resolved_at = now()
   where ri.subject_id = (select child_id from public.consents_pending_esign where id = p_pending_id)
     and ri.category   = 'consent_esign_pending'
     and ri.resolved_at is null
     and ri.archived_at is null;

  return true;
end;
$$;

revoke all  on function public.consent_esign_rescind(uuid, text) from public;
grant execute on function public.consent_esign_rescind(uuid, text) to authenticated;
```

---

## §4. Template starter system + COMPLIANCE-REQUIRED ELEMENTS (Y2)

**The literal sentences below are NOT the final shipping copy.**
They name the COMPLIANCE-REQUIRED ELEMENTS the starter must
include so the finished signed record holds up as written
permission. Final wording is Seth + the licensing consultant
(§13 OQ#6 — flagged).

### §4a. Field trip permission — R 400.1952(2)

> Field trip permission for [child's full name]
>
> I, [parent name], grant permission for [child name] to
> participate in non-vehicle field trips supervised by
> [provider name]. This includes walking trips and trips to
> nearby parks, libraries, or community spaces accessed on
> foot. This permission is given at initial enrollment and
> remains on file until I withdraw it in writing.

**Required elements:** parent name, child name, provider name,
scope of trips (non-vehicle), duration (durable), signature
(typed), date (auto).

### §4b. Routine transportation annual — R 400.1952(1)(a)

> Routine transportation permission for [child's full name]
>
> I, [parent name], grant permission for [provider name] to
> transport [child name] for routine purposes during the year
> beginning [date]. "Routine" means regularly scheduled travel
> on the same day of the week, at the same time, to the same
> destination — for example, to/from school or a regularly
> scheduled activity. This permission must be renewed at least
> annually.
>
> Routine destinations: [destinations]

**Required elements:** parent + child + provider + cadence
definition (R 400.1901(1)(jj) "routine" verbatim or
paraphrased), destinations list, 1-year validity, signature,
date.

### §4c. Non-routine transportation per-trip — R 400.1952(1)(b)

> Non-routine trip permission for [child's full name]
>
> I, [parent name], grant permission for [provider name] to
> transport [child name] on a non-routine trip on [trip date]
> to [destination]. The purpose of the trip is [purpose]. I
> understand this permission applies to this trip only; other
> non-routine trips require separate permission.

**Required elements:** parent + child + provider + trip date
+ destination + purpose + scope-limited-to-this-trip
disclaimer + signature + date.

### §4d. On-premises water seasonal — R 400.1934(10)(b)

> On-premises water activity permission for [child's full name]
>
> I, [parent name], grant permission for [child name] to
> participate in on-premises water activities at [provider
> name / location] during the [year] water season. On-premises
> water activities include [list].

**Required elements:** parent + child + provider + season
identifier + activities list + signature + date.

### §4e. Off-premises water per-trip — R 400.1934(10)(a)

> Off-premises water activity permission for [child's full name]
>
> I, [parent name], grant permission for [child name] to
> participate in an off-premises water activity on [outing
> date] at [location]. The water body type is [type — pool,
> lake, etc.]. I understand this permission applies to this
> outing only; other outings require separate permission.

**Required elements:** parent + child + provider + outing
date + location + water body type + scope-limited-to-this-
outing disclaimer + signature + date.

### §4f. Customization + disclaimer

Every starter is editable in the template editor. A prominent
disclaimer in the editor reads:

> **You own the final wording and its compliance.**
> The starter is a compliance-required-elements scaffold, not
> legal advice. Review the final language with your licensing
> consultant or attorney before relying on it. MILittleCare
> provides the record-keeping; the wording's adequacy for your
> inspection context is your responsibility.

### §4g. The snapshot-at-completion mechanic — end to end

1. **Template editor** stores `consent_templates.body_text`.
2. **Provider sends**: `consent_esign_send` RPC reads the
   current `body_text`, copies it into
   `consents_pending_esign.template_body_at_send`.
3. **Parent receives** the email; opens the portal; the
   pending-card UI fetches the pending row and displays
   `template_body_at_send`.
4. **Parent types name + clicks "I sign this consent"**: the
   client posts to `consent_esign_complete` with the typed
   signature AND the body the parent claims to have just read.
5. **RPC server-side** re-reads the CURRENT template body. If
   it matches the body the parent showed, the RPC writes the
   acknowledgments row with `template_snapshot_text = current
   body`. If it doesn't match, the RPC raises
   `template_changed_since_send`; the UI re-fetches, shows the
   new body, requires the parent to re-read.
6. **The completed acknowledgments row** holds the authoritative
   snapshot. Inspector reads the row → sees exactly what the
   parent signed.

**Why this design beats send-time-only snapshot:** if the
provider edits the template after send, send-time snapshot
gives the parent a stable read but lets them sign an obsolete
version. Completion-time snapshot guarantees the row reflects
what's CURRENT at sign time, with the stale-read 409
forcing re-confirmation on any mid-session edit.

**Why this design beats no-snapshot (FK-only) lineage:** if
the provider later edits or deletes the template, the
inspector reading the row with only an FK would have to chase
the (possibly-changed) template to know what the parent
agreed to. Storing the snapshot verbatim eliminates that hop.

---

## §5. Business-tab UI (Y2)

New section on `src/pages/BusinessInfoPage.jsx` (or a sibling
tab — Seth picks per §13 OQ#5):

- **Section header**: "Parent self-service consents (e-signature)"
- **Status line**: "Off — parents can't self-complete consents
  unless you enable a category below."
- **Per-category panel** (one per the five medium-risk types):
  - Toggle (controlled by `profiles.medium_risk_consents_enabled`
    jsonb key; writes via existing `profiles` UPDATE policy).
  - When OFF: shows the rule citation + a "Why off by default?"
    explainer.
  - When ON: shows the active template's label + a "Manage
    template" button.
- **Template editor modal**:
  - Loaded with the current `body_text` (or the starter scaffold
    on first edit; see §4).
  - Disclaimer panel at the top (§4f).
  - Textarea for `body_text`.
  - Save = archive prior template row + insert new row
    (Phase B archive-then-insert protocol).
  - Cancel = no-op.

---

## §6. Provider send flow (Y2)

From the existing FamiliesPage child detail (the same surface
that hosts the medication + consents + intake modals):

- New button on the child's row when ≥1 medium-risk category is
  enabled for the provider: "Send consent for e-signature."
- Clicking opens a modal:
  1. **Pick consent type** from the enabled-categories list.
  2. **Preview the template body** (with placeholder substitution:
     child name, today's date, etc. — pure client-side template
     rendering).
  3. **Per-occurrence input** (only for the two per-trip types):
     trip date / outing date + destination / location + (for
     water) water body type.
  4. **Send button** calls `consent_esign_send` RPC.
  5. **On success**: modal closes, toast confirms "Sent — your
     parent will receive an email."
  6. **The provider can see pending and rescind** via a child-
     detail "Pending consents" section that lists active
     `consents_pending_esign` rows for this child, with a
     "Rescind" affordance per row (calls `consent_esign_rescind`).

---

## §7. Parent completion flow (Y2)

### §7a. Surface placement

**Seth's call — §13 OQ#5.** Two options:

- **Option A (recommended): add a "To-do" tab on `/parent/acknowledge`**, sibling to the existing Attendance + Intake + Consents tabs. The tab badge shows pending counts across all medium-risk consents and any other future parent-to-do items.
- **Option B: surface the pending card at the top of the existing Consents tab**, above the existing read-only sections. Avoids tab proliferation; loses a clean unified "to-do" view.

Recommendation: Option A. The To-do tab generalizes; future
parent-action items (e.g., a follow-up to the photo-consent
revocation enforcement) land naturally on the same tab.

### §7b. The pending card

Per pending consent:
- **Header**: "Sign this consent for [child name]"
- **Subhead**: "Sent by [provider name] on [date]"
- **Body**: the template text — fetched from
  `consents_pending_esign.template_body_at_send` on first
  load; refreshed from the current template on submit (per
  §3b stale-read protection).
- **Typed-name input**:
  - Empty by default. Per parent doc §13 recommendation, the
    typed name is NOT pre-filled — the act of typing IS the
    affirmative gesture.
  - Placeholder: "Type your full legal name to sign."
- **Sign button** disabled until the typed name is non-blank.
- **Sign action**: calls `consent_esign_complete` with the typed
  name + the body the card showed.
  - On success: card transitions to a confirmation state
    ("Signed — provider notified.") and the badge count drops.
  - On `template_changed_since_send`: re-fetch the current
    body, replace it in the card, show an inline notice
    "Your provider updated the wording. Please review the
    new text before signing.", and re-enable the sign button.

### §7c. Honest copy

- The card NEVER claims the action took effect on anything
  outside the e-sign system (e.g., the messaging photo path
  isn't automatically affected by anything signed here —
  consistent with the photo-consent honest-copy rule from
  Phase A).
- The success state does NOT claim "this trip is now approved"
  — it claims "Signed — your provider has been notified." The
  trip's go/no-go is the provider's decision; the e-sign is
  their compliance evidence.

---

## §8. Compliance-evidence verification gate (the strictest in the arc)

**Eight live steps, same caliber as the consent-attachments
cross-tenant gate.** Run on the preview environment against the
seeded fixtures (Jeff/2549scio, klsnay/Audrey, Dominique). NO
MERGE for Y1 until all eight pass. Y2 cannot start until Y1
merges.

### §8a. The eight steps

1. **Y1 prerequisite — the schema applied.** Verification SQL
   in the migration header (Seth runs against production via
   the Supabase web SQL editor + screenshots per the
   `CLAUDE.md` verification-gap rule) confirms:
   - `acknowledgments` has the three new columns + the new
     CHECK + the WORM trigger.
   - `consent_templates` + `consents_pending_esign` exist
     with their RLS policies attached.
   - `profiles.medium_risk_consents_enabled` exists with the
     5-key default jsonb.

2. **Provider enables one category + creates a template** for
   Vanessa (or the provider fixture). Confirms `profiles`
   jsonb flips + `consent_templates` row written.

3. **Provider sends to parent A (klsnay) for child Audrey.**
   Confirms:
   - `consent_esign_send` returns a UUID.
   - `consents_pending_esign` row written with the right
     `provider_id`, `child_id`, `consent_type`,
     `template_body_at_send`, `consent_template_id`.
   - `notification_log` row written with `change_type =
     'consent_esign_send'`, `recipient_type = 'parent'`,
     `child_id` correct.

4. **Provider edits the template body** between send and
   completion. Confirms `consent_templates` archive-then-insert
   protocol: prior row gets `archived_at`, new row inserted
   with same `provider_id` + `consent_type` and incremented
   `body_text_version`.

5. **Parent A (klsnay) completes the e-sign.** Two sub-checks:
   - **(a) Stale-read protection**: the client posts the OLD
     body (the one fetched before the edit). RPC raises
     `template_changed_since_send`. Card displays the new
     body. Parent re-confirms.
   - **(b) Successful completion**: client posts the NEW body.
     RPC writes the acknowledgments row.

   Verify on the acknowledgments row:
   - `acknowledged_via = 'parent_portal_esign'`
   - `typed_signature_text` matches what the parent typed (case
     + whitespace preserved)
   - `template_snapshot_text` matches the NEW body verbatim
     (the snapshot survives the template edit between send
     and completion AT the completion moment)
   - `consent_template_id` references the NEW template row
   - `acknowledged_by_user_id` = klsnay's auth.uid()
   - `provider_id` = Vanessa's auth.uid()
   - `subject_type = 'child'`, `subject_id` = Audrey's id

6. **Snapshot survives later template edits.** After step 5,
   provider re-edits the template (archives the row from
   step 4, inserts a third). Confirm:
   - The acknowledgments row from step 5 STILL has the body
     from step 4 in `template_snapshot_text` (the snapshot is
     immutable per the WORM trigger).
   - `consent_template_id` references the now-archived
     template row.

7. **Cross-tenant denial — parent A attempts to complete a
   pending sent to parent B.** Provider Vanessa sends a
   pending for child Liam (Dominique family). Parent A
   (klsnay, not linked to Dominique) calls
   `consent_esign_complete` with that pending_id. **Expect:**
   error `caller is not an active parent for this child`,
   error code 42501. No acknowledgments row written.

8. **Provider-opt-in bypass attempt.** Provider Vanessa
   DISABLES the category. Parent klsnay attempts to call
   `consent_esign_complete` on a still-pending row that was
   sent before the disable.
   - Expect: completion still succeeds (the pending row was
     authorized at send time; disabling the category mid-flight
     doesn't retroactively revoke). The disable governs FUTURE
     `consent_esign_send` calls only.
   - **Separately**: parent attempts to call `consent_esign_send`
     directly via PostgREST. Expect: error `category X is not
     enabled for this provider`, error code 42501. No pending row
     written. **The parent has no INSERT path into
     `consents_pending_esign` either via direct UPDATE — the RLS
     policy denies parent INSERT.**

### §8b. Additional invariants

- **WORM**: parent A's signed row from step 5 — attempt UPDATE
  (as any role) setting `typed_signature_text` or
  `template_snapshot_text`. Expect the
  `block_esign_evidence_update_trg` to raise
  `block_esign_evidence_update: signature_text / template_snapshot_text / consent_template_id are WORM`.
- **WORM exception — archival**: provider Vanessa archives the
  row from step 5 via `archived_at = now()`. Expect success.
  The trigger checks only the evidence columns, not
  `archived_at`.

### §8c. Engine integration

After step 5 (the successful completion), the Phase 1 engine
should report the corresponding requirement as `on_file`:
- For `field_trip_permission` → requirement #13 (`consent_field_trip_permission`).
- For `transportation_routine_annual` → requirement #14.
- For `water_activities_on_premises_seasonal` → requirement #15.
- For `transportation_nonroutine_per_trip` → requirement #16 (recency).
- For `water_activities_off_premises_per_trip` → requirement #17 (recency).

The engine reads `parent_portal_esign` as satisfying parent-signed
once §9 below lands.

---

## §9. Engine connection — PARENT_SIGNED_SATISFYING_CHANNELS

**Three in-tree copies of the constant** (confirmed by grep
2026-06-04):

1. `src/lib/childFiles.js` — original.
2. `src/lib/complianceState.js` — duplicated to avoid pulling
   `supabase` into the pure module.
3. `src/lib/medication.js` — duplicated for the same reason.

**All three must add `'parent_portal_esign'` in lockstep.**

```js
const PARENT_SIGNED_SATISFYING_CHANNELS = Object.freeze([
  'parent_portal',
  'in_person_paper',
  'parent_portal_esign',   // NEW (Phase Y)
])
```

**Test update**: `src/lib/complianceState.test.js`'s backward-
compat smoke locks the duplication invariant — the channels-
satisfy test asserts `parent_portal` and `in_person_paper`
satisfy. **Extend it** to also assert `parent_portal_esign`
satisfies, and add the assertion that `provider_override` does
NOT (the existing case).

Pattern A's `state_resolver` reads the constant via direct
duplication; once all three copies + the test land, the engine
treats e-signed rows as `on_file` without registry change.

---

## §10. Migration plan (Y1)

### File

`supabase/migrations/033_parent_self_service_phase_y1_esign.sql`
(next sequential after 031; 032 was deleted on the Phase X
emergency-refresh branch).

### Order of operations inside the migration

1. `CREATE TABLE public.consent_templates` + RLS + indexes.
2. `CREATE TABLE public.consents_pending_esign` + RLS + indexes.
3. `ALTER TABLE public.profiles ADD COLUMN
    medium_risk_consents_enabled jsonb …`.
4. `ALTER TABLE public.acknowledgments`:
   a. Drop the old channel CHECK.
   b. Add the new channel CHECK including `parent_portal_esign`.
   c. Add the three new columns (`typed_signature_text`,
      `template_snapshot_text`, `consent_template_id`).
   d. Add the new `chk_acknowledgments_esign_shape` CHECK.
5. `CREATE FUNCTION block_esign_evidence_update()` + trigger.
6. `CREATE FUNCTION consent_esign_send(...)`.
7. `CREATE FUNCTION consent_esign_complete(...)`.
8. `CREATE FUNCTION consent_esign_rescind(...)`.
9. Verification SQL in the header comment — Seth runs these
   against production via the Supabase web SQL Editor and saves
   the screenshot evidence BEFORE writing the runbook entry per
   the `CLAUDE.md` verification-gap rule.
10. Runbook entry only after evidence exists.

### Forward-only + additive

- No DROP COLUMN.
- No data backfill required.
- The new CHECK on `acknowledgments` is satisfied by every
  existing row (which has `acknowledged_via <> 'parent_portal_esign'`
  and the new columns NULL).
- The WORM trigger fires on UPDATE only — existing rows are
  unaffected; future UPDATEs that don't touch the evidence
  columns are allowed.

### Down migration

Documented in the migration header as commented SQL. Roll-back
order is the reverse:
1. Drop the three RPCs.
2. Drop the WORM trigger + function.
3. Drop the `chk_acknowledgments_esign_shape` CHECK.
4. Drop the three new `acknowledgments` columns.
5. Restore the original channel CHECK (drop the new, recreate
   with three values).
6. Drop `profiles.medium_risk_consents_enabled`.
7. Drop the two new tables.

Note: rolling back AFTER any production e-sign rows exist would
violate compliance-evidence retention. Document a hard rule in
the migration header: "Do NOT roll back this migration if any
row in `acknowledgments` has `acknowledged_via =
'parent_portal_esign'`."

---

## §11. Tests

### §11a. Y1 tests (pure + integration where possible)

- **`PARENT_SIGNED_SATISFYING_CHANNELS` duplication test** — extend
  the existing backward-compat smoke in `complianceState.test.js`
  to include the new channel. Lock the three-copy duplication
  invariant against drift.
- **Engine integration test**: simulate an e-signed
  acknowledgments row for `field_trip_permission`. Confirm
  `getRequirementState({ key: 'consent_field_trip_permission' })`
  returns `{ kind: 'on_file', ... }` with the engine treating
  `parent_portal_esign` as satisfying.
- **Per-occurrence integration test**: the same shape for
  requirement #16 (transport nonroutine per-trip) — engine
  reports the corresponding recency requirement as `on_file`
  when an e-signed row exists within the 12-month window.

No test-side coverage of the RPCs themselves — those are
verified at the live boundary gate in §8 against real auth,
not via mocked Supabase. (The pure module's no-Supabase
contract means we can't easily test RPC behavior client-side.)

### §11b. Y2 tests

- UI component tests for the BusinessInfoPage section + the
  template editor + the per-child send modal + the parent
  pending card. Shape per the prior Phase X UI testing posture
  — vitest + the existing Supabase-mock pattern.
- No new RPC behavior to test (Y2 reuses Y1's RPCs).

---

## §12. Out of scope (explicitly deferred)

Named so they're not silently absorbed.

- **Parent revoke / withdraw of medium-risk consents.** Provider
  amends on paper for V1. Parent-revoke is a future PR if real
  provider demand surfaces.
- **Medication parent e-sign.** Stays in the provider's modal.
- **Religious-objection / immunization waivers.** Provider-only
  with attachment.
- **Per-template versioning history UI.** Each edit archives
  prior + inserts new; the UI shows the current template only.
  History reachable via "show archived" toggle if Seth wants it
  in a fast-follow.
- **Multi-parent co-sign.** Single-parent in V1.
- **Pre-fill the typed name from `parent_profiles.full_name`.**
  Per parent doc §13 recommendation, leave empty so the typing
  IS the affirmative gesture. Seth flag §13 OQ#7.
- **Provider notification on every Y1 send.** The send RPC writes
  a notification_log row; the existing dispatcher emails the
  parent. Y2 may add a confirmation toast to the provider, but
  Y1 doesn't need a separate provider-side notification.
- **Audit log of every template view by the parent.** Out of
  scope. The compliance evidence is the signed row.

---

## §13. Open questions for Seth

The genuinely open calls. Recommendations included; Seth picks.

1. **§2a — `consent_template_id` ON DELETE behavior.**
   Recommendation: `SET NULL` (preserves the signed row when a
   template is later deleted; snapshot text retains the
   evidence). Alternative: leave the FK without a delete rule
   so a delete is REJECTED while signed rows reference. The FK
   pattern in migration 029 (`consent_attachments.target_id`)
   used neither — the polymorphic shape there made it hard to
   enforce. For a typed FK like this, `SET NULL` is the
   conservative choice.

2. **§3b — stale-read body comparison.** Recommendation: the
   RPC's body comparison uses `IS DISTINCT FROM` (NULL-safe
   exact text). Alternative: tolerate whitespace-only
   differences. Recommendation: do NOT tolerate — the parent's
   sign action is keyed to the exact text shown; allowing
   "near-match" undermines the boundary's intent.

3. **§3b — what to do when `template_changed_since_send` fires.**
   Recommendation: the parent UI re-fetches the new body, shows
   an inline notice, and re-enables the sign button. The parent
   can also cancel (close the card) and revisit later. Reject
   silent retry; the parent should knowingly re-read.

4. **§7a — surface placement for the pending card.**
   Recommendation: Option A (new "To-do" tab on
   `/parent/acknowledge`). Option B (top of Consents tab) is
   also viable.

5. **§5 — Business-tab section vs sibling tab.** Recommendation:
   new section on `BusinessInfoPage`. Alternative: sibling tab.
   Section is lower friction for the small surface area.

6. **§4 — template starter wording.** This needs Seth + licensing
   consultant. CC has drafted the COMPLIANCE-REQUIRED ELEMENTS
   per rule; the literal sentences are placeholders until human
   review. Confirm the wording-review path before Y2 ships:
   whose desk does it land on? Recommendation: Seth drafts the
   first version against §4's elements; the consultant reviews
   before Y2 merges to production.

7. **§12 — pre-fill typed name** (carried from parent doc §13).
   Recommendation: leave empty. The typing IS the affirmative
   gesture. Pre-filling makes the sign action mechanical.

8. **Y1 verification timing.** Recommendation: ship Y1 to
   production behind the OFF-by-default `medium_risk_consents_enabled`
   defaults BEFORE Y2 starts. The data layer is dormant until
   Y2 surfaces the toggles + flows. This lets the §8 boundary
   gate run on production data without any user-visible
   surface change.

9. **Notification email copy for the parent send.** Y2 work, but
   flag now: the email needs to clearly identify the provider,
   the child, the consent category, and the time-limited
   nature. Avoid claims about what happens if the parent
   doesn't sign. Recommendation: draft in Y2's scope doc
   alongside the UI work.

---

## Halt for review — what Seth reads next

This doc, with these focus areas:

1. **§2 — the schema.** Two new tables + four column-extension
   actions on `acknowledgments` + the WORM trigger. The
   compliance-evidence boundary lives here.
2. **§3 — the three RPCs.** The send + complete + rescind
   contracts, including the §3b stale-read protection.
3. **§4 — the template starter ELEMENTS.** Wording flagged for
   consultant review.
4. **§8 — the verification gate.** Eight steps; live; same
   caliber as the consent-attachments boundary.
5. **§1 — the Y1 / Y2 sub-split.** Two PRs, two branches, two
   gates.
6. **§13 — the nine open questions.**

After Seth reacts:
- Y1 branch (`feature/parent-self-service-phase-y1-evidence-boundary`)
  cuts; CC implements §2-3-9 + the test extensions. Seth applies
  migration 033 + runs the §8 gate. Y1 merges only on the gate
  passing.
- Y2 branch starts after Y1 merges.

Status: **DRAFT for review.**

---

**End of parent-self-service Phase Y scope doc — DRAFT.** No
code, no migration, no commit, no branch. Untracked. Halting
for the build PR planning.
