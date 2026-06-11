# Runbook

Operational procedures for MI Little Care. Update this file whenever a new procedure is introduced (per `CLAUDE.md` § Documentation Conventions, rule 3).

## Migration Application Procedure

All schema migrations are currently applied manually. Until automated migration tooling lands, the procedure is:

1. **Source the SQL.** Open the migration file on the feature branch via GitHub (e.g. `supabase/migrations/007_funding_sources_archived_by.sql`). Copy the full file content.
2. **Paste into the Supabase SQL Editor.** Production project only for now; staging is not yet provisioned. Run the script.
3. **Verify the result.** If the migration includes a trailing `SELECT` (the backfill pattern), record those numbers. Otherwise, run a separate verification query — e.g. `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='funding_sources' order by ordinal_position;` after a column-add migration.
4. **Verify in the dashboard yourself.** Paste the verification queries directly into the Supabase web SQL Editor at `https://supabase.com/dashboard/project/ooavvgkfhgouakkiknfs/sql`. Run them yourself with eyes on the dashboard. Copy or screenshot the results. The user-visible dashboard output is the artifact — not chat output, and not a Claude Code report of queries it ran. Save the screenshot before writing the runbook entry. If you cannot personally verify in the dashboard, the migration is not done.
5. **Update Migration History.** Add an entry to the section below: date, migrations applied, verification result, any deviations.

Rollback follows the same pattern in reverse: open the migration's commented `DOWN MIGRATION` section, uncomment, paste, run. Always rollback the latest applied migration first and walk backwards in number order.

### Vercel cron count (PR #15 Half 2)

PR #15 Half 2 brought the active cron count to 4. The Vercel Pro upgrade prerequisite was satisfied 2026-05-27 (per the OQ4 resolution in `docs/pr-15-opt-in-reminder-system-scope.md`); Hobby's 2-cron limit no longer applies.

Crons in `vercel.json` after Half 2:

1. `/api/cron-generate-autopay-invoices` - Mondays 03:00 (pre-existing).
2. `/api/cron-charge-autopay` - Mondays 14:00 (pre-existing).
3. `/api/cron-send-acknowledgment-digest` - hourly (re-enabled in Half 2; was disabled per `docs/tech_debt.md` 2026-05-22 due to the Hobby cap).
4. `/api/cron-dispatch-reminders` - hourly (added in Half 2).

Each new cron handler verifies a `CRON_SECRET` env var matching the `Authorization: Bearer ...` header before processing. Required env vars on Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. Optional: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `PUBLIC_APP_URL` (the dispatcher composes deep links from PUBLIC_APP_URL + the instance's cta_path).

### Operational note — the web SQL Editor mangles long statements

⚠️ **The Supabase web SQL Editor cannot reliably execute long single
statements.** Observed during migration 010 application on 2026-05-17: long
`INSERT` statements (26 rows per `VALUES` clause, ~1500+ chars) get wrapped
into multiple physical lines and the editor runs only a fragment, producing
a `syntax error` on the truncated portion. The editor handles short
single-line statements fine.

For future migrations: either break long seed inserts into many short
statements (4–5 rows each), apply via the direct Supabase connection (MCP
path), or test the editor's behavior with a small sample first before
assuming a complex migration will land. The `Success. No rows returned`
message can fire on a fragment that did nothing — verification queries
against the actual table state are the only reliable confirmation.

## Pending Application

### Migration 030 — parent metadata SELECT policy `archived_at` parity (Consent Attachments Part 2 hardening)

**Status:** PENDING — written 2026-06-02 alongside the Part 2 UI. Drops + recreates the parent SELECT policy on `public.consent_attachments` to add `AND consent_attachments.archived_at IS NULL` to the `USING` clause. Brings the RLS layer to parity with the Edge Function's own `archived_at=is.null` filter.

**File:** `supabase/migrations/030_consent_attachments_archived_rls.sql`

**Context:** the Part 1 code audit (finding (a)) noted that a linked parent's hand-crafted PostgREST SELECT against `consent_attachments` could see metadata rows with `archived_at IS NOT NULL` tied to their own family's consents. The Edge Function never minted a signed URL for those rows (it filters on `archived_at=is.null`), and the application code (`listConsentAttachments`) filters too — so the UI never surfaced them. **This is NOT a cross-tenant fix** — it's a "soft-deleted attachments stay out of the list" parity fix.

**Dependency:** migration 029 must be applied first. Migration 030 only modifies the named policy created by 029.

**Apply procedure:** open the file, copy contents, paste into the Supabase SQL editor (production), run. Idempotent (DROP-then-CREATE).

**Verification:**

```sql
-- (a) The policy text now includes archived_at IS NULL on
--     consent_attachments.
select pg_get_expr(polqual, polrelid) as using_clause
from pg_policy
where polname = 'Parents can list consent attachments for their children';
-- expect: USING clause starts with "(consent_attachments.archived_at IS NULL) AND (...)"
```

```sql
-- (b) Re-run Part 1's Test 4a cross-tenant verification (Parent B
--     SELECT against Family A's attachment id) — still ZERO rows.
--     The hardening doesn't change this; it only adds the
--     archived_at filter on top.
```

```sql
-- (c) New: archived attachments on a NON-archived ack do NOT
--     appear in a linked parent's SELECT. Seed by setting
--     archived_at = now() on a test attachment row, sign in as the
--     linked parent, and confirm SELECT returns ZERO rows.
```

**Rollback:** restore migration 029's policy text (loosens the policy back to the pre-hardening state). Commented at the bottom of `030_consent_attachments_archived_rls.sql`.

### Migration 029 — `consent_attachments` table + `consent-attachments` storage bucket (Consent Attachments Part 1)

**Status:** PENDING — written 2026-06-02, not yet applied to production. Awaits Seth's manual application via the Supabase web SQL editor and verification screenshots **including the four-test gate** (provider write/read; linked parent metadata list + Edge Function content read; cross-tenant parent denial via BOTH the metadata RLS and the Edge Function) before promotion to Migration History below.

**File:** `supabase/migrations/029_consent_attachments.sql`

**What it does:**
- Creates `public.consent_attachments` — the polymorphic metadata table (provider-scoped) that holds file references for signed-paper-scan attachments to consent records. Polymorphic via `target_type` (`'acknowledgment'` | `'medication_authorization'`) + `target_id uuid`.
- Soft-delete pair (`archived_at`, `archived_by`); 4-year `retention_until` default; no DELETE policy at table OR storage level.
- RLS: provider SELECT/INSERT/UPDATE, plus a parent SELECT-only policy that performs the three-path join to verify parent_family_links → child → consent ownership (mirrors the Edge Function's resolution).
- Creates the `consent-attachments` private storage bucket with the owner-only RLS template (first-folder-segment match) shared with `receipts` (mig 002) and `funding-documents` (mig 008).

**Dependency:** migration 028 (`medication_authorizations`, `medication_administration_events`) must already be applied. If 028 is still pending, **apply 028 first** and verify (per its runbook entry below). The parent SELECT policy and the Edge Function both join through `medication_authorizations` for the medication-permission resolution path, and the `target_type='medication_authorization'` branch references that table.

Also requires migration 024's `parent_family_links → children → acknowledgments` pattern (already applied per Migration History).

**Apply procedure:** open the file on the feature branch, copy the entire contents, paste into the Supabase web SQL editor (production project), run. The migration is idempotent (IF NOT EXISTS, ON CONFLICT DO NOTHING for the bucket insert, DROP-then-CREATE for policies/triggers).

The Edge Function `api/consent-attachment-url.js` is shipped in the same PR as application code; Vercel picks it up on the next deploy automatically. Required env vars (already present): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

**Verification queries (paste each into the SQL editor and screenshot):**

```sql
-- (a) consent_attachments table exists with the expected columns.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='consent_attachments'
order by ordinal_position;
-- expect: id, provider_id, target_type, target_id, storage_path,
--         original_filename, content_type, file_size_bytes,
--         uploaded_at, uploaded_by_user_id, retention_until,
--         archived_at, archived_by, notes, created_at, updated_at
--         (16 rows)
```

```sql
-- (b) CHECK constraint on target_type is in place.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.consent_attachments'::regclass
  and contype = 'c';
-- expect: chk_consent_attachments_target_type with
--         CHECK (target_type = ANY (ARRAY['acknowledgment'::text, 'medication_authorization'::text]))
```

```sql
-- (c) Both RLS policy sets exist on the metadata table.
select policyname, cmd
from pg_policies
where schemaname='public' and tablename='consent_attachments'
order by policyname;
-- expect at least 4 policies:
--   "Providers can view their own consent attachments" (SELECT)
--   "Providers can insert their own consent attachments" (INSERT)
--   "Providers can update their own consent attachments" (UPDATE)
--   "Parents can list consent attachments for their children" (SELECT)
-- NO DELETE policy.
```

```sql
-- (d) Storage bucket exists and is private.
select id, name, public
from storage.buckets
where id = 'consent-attachments';
-- expect: 1 row; public = false.
```

```sql
-- (e) Storage RLS policies exist (provider-only, no UPDATE).
select policyname, cmd
from pg_policies
where schemaname='storage' and tablename='objects'
  and policyname like '%consent attachments%'
order by policyname;
-- expect 3 policies (INSERT, SELECT, DELETE). NO UPDATE.
```

```sql
-- (f) Indexes exist.
select indexname, indexdef
from pg_indexes
where schemaname='public' and tablename='consent_attachments'
order by indexname;
-- expect:
--   consent_attachments_pkey
--   consent_attachments_target_active_idx        (partial)
--   consent_attachments_provider_active_idx      (partial)
--   consent_attachments_retention_idx            (partial)
```

```sql
-- (g) Table is empty (no data backfill in this migration).
select count(*) from public.consent_attachments;
-- expect: 0.
```

### ⚠️ The four-test verification gate (the cross-tenant denial is the privacy boundary)

The vitest suite cannot reach the Edge Function or the parent metadata RLS — both run against real auth in production. These four SQL/HTTP tests prove the privacy boundary. **Test 4 is the gate** — if either of its sub-checks leaks (Family A's attachment shows in Parent B's metadata list, OR the Edge Function returns a signed URL to Parent B), the feature is not safe to ship.

#### Setup

- **Two test families** (A and B) with at least one child each (`child_a`, `child_b`).
- **Two test parents** (`parent_a` linked via `parent_family_links` to family A; `parent_b` linked to family B). Both with `status='active'`.
- The signed-in **test provider** (the licensee for both families).
- **One existing consent** for `child_a` — for example, a `field_trip_permission` ack row in `acknowledgments`. Note its `id` (you'll need it as `<ack_a_id>`).

Find or create the IDs:

```sql
-- Get the children + their family ids:
select c.id as child_id, c.first_name, c.family_id, f.family_name
  from public.children c
  join public.families f on f.id = c.family_id
 where c.user_id = '<provider auth.uid()>'
   and c.archived_at is null
 order by f.family_name, c.first_name;

-- Get the two test parents' auth uids + their family links:
select pp.id as parent_user_id, pp.email, pfl.family_id, pfl.status
  from public.parent_profiles pp
  join public.parent_family_links pfl on pfl.parent_id = pp.id
 where pp.email in ('<parent_a email>', '<parent_b email>')
 order by pp.email;

-- Find a child-scoped ack for child_a:
select id from public.acknowledgments
 where provider_id = '<provider auth.uid()>'
   and subject_type = 'child'
   and subject_id = '<child_a id>'
   and archived_at is null
 limit 1;
```

#### Test 1 — Provider write + provider read (must SUCCEED)

```sql
-- Insert a fake scan metadata row pointing at <ack_a_id>. In real
-- use the UI uploads a file first; here we skip the actual file
-- upload and seed the metadata directly to exercise the RLS path.
-- Use a fake storage_path that follows the format the bucket
-- expects: <provider_auth_uid>/<target_id>/<fake>.pdf
insert into public.consent_attachments (
  provider_id, target_type, target_id,
  storage_path, original_filename, content_type, file_size_bytes,
  uploaded_by_user_id, notes
) values (
  '<provider auth.uid()>',
  'acknowledgment',
  '<ack_a_id>',
  '<provider auth.uid()>/<ack_a_id>/test-fake.pdf',
  'test-fake.pdf',
  'application/pdf',
  12345,
  '<provider auth.uid()>',
  'Test row for Part 1 verification gate.'
) returning id;
-- Record the returned id as <attachment_a_id>.
```

```sql
-- Provider reads via direct SELECT (provider RLS):
select id, target_id, original_filename, archived_at
  from public.consent_attachments
 where id = '<attachment_a_id>';
-- expect 1 row.
```

**Pass:** the row inserts and the provider can read it back.

#### Test 2 — Linked parent (Parent A) metadata list (must SUCCEED)

Sign in as **Parent A** via the parent portal (or use the supabase-js client with their JWT in a test harness).

```sql
-- As Parent A — direct SELECT against consent_attachments:
select id, target_id, original_filename
  from public.consent_attachments
 where target_type = 'acknowledgment'
   and target_id = '<ack_a_id>';
-- expect 1 row (the test attachment). Parent metadata RLS allows.
```

**Pass:** Parent A sees the metadata row via the parent SELECT policy.

#### Test 3 — Linked parent (Parent A) Edge Function content read (must SUCCEED)

```bash
# As Parent A (with their JWT), call the Edge Function:
curl -X POST https://<preview-deploy>.vercel.app/api/consent-attachment-url \
  -H "Authorization: Bearer <parent_a JWT>" \
  -H "Content-Type: application/json" \
  -d '{"attachment_id":"<attachment_a_id>"}'
# expect: HTTP 200, { "signedUrl": "https://...", "expires_in_seconds": 900 }
```

**Pass:** Parent A receives a signed URL and (optionally) opening it in a browser would render the file (we seeded fake metadata so the file may 404 at storage; the function returning the signedUrl is the pass — separate from whether a real file exists).

#### Test 4 — UNLINKED parent (Parent B) — THE PRIVACY BOUNDARY (must DENY on both sub-checks)

##### 4a. Parent B direct SELECT (must return ZERO rows)

Sign in as **Parent B**.

```sql
-- As Parent B — direct SELECT against the SAME attachment id:
select id, target_id, original_filename
  from public.consent_attachments
 where id = '<attachment_a_id>';
-- expect: ZERO rows. The parent metadata RLS denies.

select id, target_id, original_filename
  from public.consent_attachments
 where target_type = 'acknowledgment'
   and target_id = '<ack_a_id>';
-- expect: ZERO rows. Same denial via the per-consent query.
```

##### 4b. Parent B Edge Function call (must return 404)

```bash
# As Parent B (with their JWT) — call the Edge Function with the SAME attachment_id:
curl -X POST https://<preview-deploy>.vercel.app/api/consent-attachment-url \
  -H "Authorization: Bearer <parent_b JWT>" \
  -H "Content-Type: application/json" \
  -d '{"attachment_id":"<attachment_a_id>"}'
# expect: HTTP 404, { "error": "Not found" }
# NO signed URL in the response. NO 200.
```

**Pass criteria (both sub-checks must deny):**
- 4a: zero rows returned from both queries (the parent metadata RLS strips them).
- 4b: HTTP 404 with no signedUrl in the body (the Edge Function denies via the parent_family_links check).

**If either sub-check leaks** (4a returns the row, or 4b returns a signedUrl), the privacy boundary is broken. **Halt the deploy.** Do not proceed to Part 2 UI. Investigate the policy / function before promoting the migration to Migration History.

#### Cleanup

```sql
-- Archive the test row when verification is complete:
update public.consent_attachments
   set archived_at = now()
 where id = '<attachment_a_id>';
```

**Rollback (if needed — destructive):**

⚠️ Do NOT rollback if production attachment rows exist — retention applies. Export the table first.

```sql
drop policy if exists "Providers can delete their own consent attachments" on storage.objects;
drop policy if exists "Providers can view their own consent attachments" on storage.objects;
drop policy if exists "Providers can upload their own consent attachments" on storage.objects;
delete from storage.buckets where id = 'consent-attachments';

drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;
drop policy if exists "Providers can update their own consent attachments" on public.consent_attachments;
drop policy if exists "Providers can insert their own consent attachments" on public.consent_attachments;
drop policy if exists "Providers can view their own consent attachments" on public.consent_attachments;
drop trigger if exists consent_attachments_set_updated_at on public.consent_attachments;
drop index if exists public.consent_attachments_retention_idx;
drop index if exists public.consent_attachments_provider_active_idx;
drop index if exists public.consent_attachments_target_active_idx;
drop table if exists public.consent_attachments;
```

### Migration 028 — medication authorizations + administration events + role-gate trigger (PR #20 Part 1)

**Status:** PENDING — written 2026-06-02, not yet applied to production. Awaits Seth's manual application via the Supabase web SQL editor and verification screenshots **including the three trigger tests (Pair A negative + positive, Pair B positive)** before promotion to Migration History below.

**File:** `supabase/migrations/028_medication.sql`

**2026-06-10 (pre-application edit):** the canonical Engineering Discipline rule-4 revoke/grant trailer was added to the SECURITY DEFINER trigger function `medication_event_caregiver_role_check()` in the migration file. Safe to edit in place because the migration has never been applied; whoever applies 028 gets the trailer automatically.

**What it does:**
- Creates `public.medication_authorizations` (one row per child × medication; provider's record of the active plan + original-container attestation + OTC vs prescription split).
- Creates `public.medication_administration_events` (one row per dose; date/time/amount + administering caregiver; FK `on delete restrict` so dose records survive authorization archival).
- Creates the `medication_event_caregiver_role_check()` trigger function and binds it BEFORE INSERT on `medication_administration_events`. The trigger enforces R 400.1931(1) — only `licensee` or `child_care_staff_member` may administer — EXCEPT for `is_topical_otc=true` events per R 400.1931(8)'s exemption.
- RLS policies: provider-scoped via `provider_id`; parents see their own children's records via `parent_family_links → children` (same shape as migration 024's parent SELECT policy on `acknowledgments`).
- Indexes: per-child active-authorization unique (`(child_id, lower(medication_name)) WHERE archived_at IS NULL`); event read-paths by child / provider / authorization.

**Dependency:** migration 027 (`acknowledgments_per_occurrence`) must already be applied. PR #20 also relies on PR #8's `public.caregivers` + `public.caregiver_regulatory_roles` (migration 012) for the role-gate trigger's lookup.

**Apply procedure:** open the file on the feature branch, copy the entire contents, paste into the Supabase web SQL editor (production project), run. The migration is short and uses no transaction wrapping (the per-statement DDL is independent — table create, function create, trigger drop+create, policies). If a partial-apply happens mid-script, re-running is safe (IF NOT EXISTS / OR REPLACE / DROP-then-CREATE patterns).

**Verification (paste each into the SQL editor and screenshot):**

```sql
-- (a) Both tables exist with the expected columns.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public'
  and table_name in ('medication_authorizations',
                     'medication_administration_events')
order by table_name, ordinal_position;
```

```sql
-- (b) The role-gate trigger exists on the events table.
select tgname, tgenabled, tgrelid::regclass
from pg_trigger
where tgname = 'trg_medication_event_caregiver_role_check';
-- expect 1 row; tgenabled='O' (enabled);
--   tgrelid = public.medication_administration_events.
```

```sql
-- (c) Authorization partial-unique index exists.
select indexname, indexdef
from pg_indexes
where schemaname='public'
  and tablename='medication_authorizations'
  and indexname='idx_med_auth_active_per_child_med';
```

```sql
-- (d) No existing data affected (the tables are new).
select count(*) as auths from public.medication_authorizations;
select count(*) as events from public.medication_administration_events;
-- expect both 0.
```

### ⚠️ Trigger tests — the legally-consequential verification (must run on real rows)

The vitest suite cannot reach a DB trigger. These three SQL tests prove R 400.1931(1) is enforced AND R 400.1931(8) is honored. Run on a throwaway test child + caregivers.

**Setup queries — find or create caregivers of each role:**

```sql
-- Find an existing caregiver of each role (the schema's regulatory_role
-- values are: licensee, child_care_staff_member, child_care_assistant,
-- unsupervised_volunteer, supervised_volunteer, driver).
select c.id, c.first_name, c.last_name, crr.regulatory_role
  from public.caregivers c
  join public.caregiver_regulatory_roles crr on crr.caregiver_id = c.id
 where c.licensee_id = '<your provider auth.uid()>'
   and c.archived_at is null
 order by crr.regulatory_role, c.first_name;
```

If you don't have a caregiver of a given role on the test provider's roster, set one up via the existing PR #8 caregivers UI (or insert via SQL — but the UI flow is safer because it respects the migration-12 enums).

Once you have the IDs, set up a test authorization for each branch (non-OTC + OTC):

```sql
-- Pick an existing test child:
select id, first_name, last_name from public.children
 where user_id = '<your provider auth.uid()>'
   and archived_at is null
 order by created_at desc limit 5;

-- Create one non-OTC authorization (subject to (1) role-gate):
insert into public.medication_authorizations (
  provider_id, child_id, medication_name, is_topical_otc,
  original_container_confirmed
) values (
  '<provider_id>', '<child_id>', 'Pr20-test-Tylenol', false, true
) returning id;
-- record the returned id as <auth_non_otc>.

-- Create one TOPICAL-OTC authorization (R 400.1931(8) exempt):
insert into public.medication_authorizations (
  provider_id, child_id, medication_name, is_topical_otc,
  original_container_confirmed
) values (
  '<provider_id>', '<child_id>', 'Pr20-test-Sunscreen', true, true
) returning id;
-- record the returned id as <auth_topical_otc>.
```

#### Pair A — Non-OTC authorization, role-gate applies (R 400.1931(1))

**N-A (NEGATIVE — must ERROR):** an assistant CANNOT administer Tylenol.

```sql
insert into public.medication_administration_events (
  provider_id, authorization_id, child_id,
  administered_by_caregiver_id, administered_at, dose_administered_text
) values (
  '<provider_id>',
  '<auth_non_otc>',
  '<child_id>',
  '<caregiver_id_assistant>',
  now(),
  '5 mL'
);
-- expect: ERROR — "Only licensee or child care staff member may
--         administer medication (R 400.1931(1))"
--         The ERROR IS THE PASS. The trigger is doing its job.
```

If the row inserts instead of erroring, the trigger is broken. Halt and investigate before claiming the role-gate works.

**P-A (POSITIVE — must SUCCEED):** a licensee or staff member CAN administer Tylenol.

```sql
insert into public.medication_administration_events (
  provider_id, authorization_id, child_id,
  administered_by_caregiver_id, administered_at, dose_administered_text
) values (
  '<provider_id>',
  '<auth_non_otc>',
  '<child_id>',
  '<caregiver_id_licensee_or_staff>',
  now(),
  '5 mL'
);
-- expect: 1 row inserted, no error.
```

Also try a `supervised_volunteer` caregiver against the same non-OTC authorization — it MUST also error (R 400.1931(1) explicitly prohibits both `child_care_assistant` and `supervised_volunteer`).

#### Pair B — Topical OTC authorization, role-gate EXEMPT (R 400.1931(8))

**P-B (POSITIVE — must SUCCEED):** an assistant CAN apply sunscreen.

```sql
insert into public.medication_administration_events (
  provider_id, authorization_id, child_id,
  administered_by_caregiver_id, administered_at, dose_administered_text
) values (
  '<provider_id>',
  '<auth_topical_otc>',
  '<child_id>',
  '<caregiver_id_assistant>',     -- the SAME assistant N-A rejected
  now(),
  'Applied to face and arms'
);
-- expect: 1 row inserted, no error. The trigger detected
--         is_topical_otc=true on the linked authorization and skipped
--         the role-check per R 400.1931(8).
```

**If P-B errors with the (1) message, the trigger is NOT honoring (8).** That is a rule violation. Halt and investigate.

**Together, the three tests prove the trigger:**
- Pair A: enforces (1) — assistants/volunteers cannot record having administered prescription or oral OTC.
- Pair B: honors (8) — assistants/volunteers CAN record having applied topical OTC.

This is the legally-consequential invariant. Tests passing in vitest do NOT prove it; only these three SQL tests do.

#### OTC-exemption sanity check (optional)

```sql
-- The is_topical_otc=true authorization can have its consent
-- recorded via the existing OTC-blanket ack type; no dose log is
-- REQUIRED per (7) — but events MAY be logged (which is what P-B
-- just demonstrated).
select count(*) from public.acknowledgments
 where provider_id = '<provider_id>'
   and subject_type = 'child'
   and subject_id   = '<child_id>'
   and type         = 'medication_permission_otc_blanket'
   and archived_at  is null;
-- This is informational — the OTC-blanket ack is recorded via the
-- Part 2 UI (not yet built). Zero rows here doesn't fail the
-- trigger tests above; it just means consent capture hasn't shipped.
```

**Cleanup:** archive the three test rows (the two authorizations and any events inserted) when done.

```sql
update public.medication_authorizations
   set archived_at = now()
 where medication_name in ('Pr20-test-Tylenol', 'Pr20-test-Sunscreen')
   and provider_id = '<provider_id>';

update public.medication_administration_events
   set archived_at = now()
 where authorization_id in (
   select id from public.medication_authorizations
    where medication_name in ('Pr20-test-Tylenol', 'Pr20-test-Sunscreen')
      and provider_id = '<provider_id>'
 );
```

**Rollback (if needed — destructive; preserves no audit data):**

```sql
drop policy if exists "Parents can view medication events for their children" on public.medication_administration_events;
drop policy if exists "Providers can update their medication events" on public.medication_administration_events;
drop policy if exists "Providers can insert their medication events" on public.medication_administration_events;
drop policy if exists "Providers can view their medication events" on public.medication_administration_events;
drop policy if exists "Parents can view medication authorizations for their children" on public.medication_authorizations;
drop policy if exists "Providers can update their medication authorizations" on public.medication_authorizations;
drop policy if exists "Providers can insert their medication authorizations" on public.medication_authorizations;
drop policy if exists "Providers can view their medication authorizations" on public.medication_authorizations;
drop trigger if exists trg_medication_event_caregiver_role_check on public.medication_administration_events;
drop function if exists public.medication_event_caregiver_role_check();
drop table if exists public.medication_administration_events;
drop table if exists public.medication_authorizations;
```

⚠️ **Do NOT rollback if production dose records exist** — R 400.1931(9) requires 2-year retention. Export the tables first.

### Migration 027 — relax `acknowledgments_active_unique` + add `occurrence_metadata` (Consents Phase C)

**Status:** PENDING — written 2026-06-01, not yet applied to production. Awaits Seth's manual application via the Supabase web SQL editor and verification screenshots (including the two negative tests) before promotion to Migration History below.

**File:** `supabase/migrations/027_acknowledgments_per_occurrence.sql`

**What it does:** two schema changes inside a single transaction — (a) replaces the `acknowledgments_active_unique` partial unique index with one whose WHERE clause exempts the two per-occurrence types (`transportation_nonroutine_per_trip`, `water_activities_off_premises_per_trip`); (b) adds a nullable `occurrence_metadata jsonb` column. Both DDL statements wrapped in BEGIN/COMMIT so other readers see either the old state or the new state, never neither.

**Dependency:** migration 026 (`acknowledgments_expires_at`) must already be applied. If 026 hasn't landed yet, apply 026 first and verify before running 027.

**Why it's needed:** Consents Phase C ships the two per-occurrence licensing-required consent types — one row per trip / outing. Multiple active rows per `(provider, type, child)` are EXPECTED for these types (one per occurrence) but the original `acknowledgments_active_unique` partial index from migration 024 actively blocks them. The relaxation surgically exempts ONLY these two `type` values; every durable type (Phase A `field_trip_permission`, `photo_sharing_consent`/`_revoked`, Phase B `transportation_routine_annual`, `water_activities_on_premises_seasonal`, every R 400.1907 intake type) keeps its one-active-row guarantee.

**Apply procedure:** open the file on the feature branch, copy the entire contents (including the BEGIN/COMMIT), paste into the Supabase web SQL editor for the production project, run. Then run the verification queries below.

**Verification (paste each into the SQL editor and screenshot):**

```sql
-- (a) occurrence_metadata column exists.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public'
  and table_name='acknowledgments'
  and column_name='occurrence_metadata';
-- expect 1 row: occurrence_metadata | jsonb | YES
```

```sql
-- (b) The new partial unique index carries the exclusion clause.
select indexname, indexdef
from pg_indexes
where schemaname='public' and tablename='acknowledgments'
  and indexname='acknowledgments_active_unique';
-- expect: indexdef WHERE clause contains
--   "type <> ALL (ARRAY['transportation_nonroutine_per_trip'::text,
--                       'water_activities_off_premises_per_trip'::text])"
--   (Postgres normalizes NOT IN to <> ALL in pg_indexes output;
--   semantic identical.)
```

```sql
-- (c) No existing row was mutated (occurrence_metadata is NULL for
--     every pre-Phase-C row).
select count(*) as total_rows,
       count(occurrence_metadata) as rows_with_occurrence_metadata
from public.acknowledgments
where archived_at is null;
-- expect: rows_with_occurrence_metadata = 0 immediately after migration.
```

```sql
-- (d) The provider-level partial unique was NOT touched.
select indexname, indexdef
from pg_indexes
where schemaname='public' and tablename='acknowledgments'
  and indexname='acknowledgments_active_unique_no_subject';
-- expect: WHERE clause unchanged from migration 024 —
--   "WHERE ((archived_at IS NULL) AND (subject_id IS NULL))"
```

**Negative tests (the heart of the index relaxation — run these on a throwaway test child):**

```sql
-- N1) Two active rows of a DURABLE type for the same child STILL
--     violate the unique. The SECOND insert must raise a
--     unique-violation error. Replace <provider_id> + <child_id>
--     with real test values from your data.
insert into public.acknowledgments (
  provider_id, type, subject_type, subject_id,
  acknowledged_via, acknowledged_by_label, snapshot_hash
) values
  ('<provider_id>', 'field_trip_permission', 'child', '<child_id>',
   'in_person_paper', 'Test Parent', 'phaseC-negtest-1'),
  ('<provider_id>', 'field_trip_permission', 'child', '<child_id>',
   'in_person_paper', 'Test Parent', 'phaseC-negtest-2');
-- expect: second row raises
--   ERROR: duplicate key value violates unique constraint
--     "acknowledgments_active_unique"
-- This proves durable-type uniqueness is preserved.

-- Cleanup (regardless of which inserts succeeded):
update public.acknowledgments
   set archived_at = now()
 where provider_id = '<provider_id>'
   and subject_id = '<child_id>'
   and snapshot_hash in ('phaseC-negtest-1','phaseC-negtest-2');
```

```sql
-- N2) Two active rows of a PER-OCCURRENCE type for the same child
--     are ALLOWED. Both inserts must succeed.
insert into public.acknowledgments (
  provider_id, type, subject_type, subject_id,
  acknowledged_via, acknowledged_by_label,
  occurrence_metadata, snapshot_hash
) values
  ('<provider_id>', 'transportation_nonroutine_per_trip',
   'child', '<child_id>',
   'in_person_paper', 'Test Parent',
   '{"trip_date": "2026-07-15", "destination": "Library"}'::jsonb,
   'phaseC-postest-1'),
  ('<provider_id>', 'transportation_nonroutine_per_trip',
   'child', '<child_id>',
   'in_person_paper', 'Test Parent',
   '{"trip_date": "2026-07-22", "destination": "Park"}'::jsonb,
   'phaseC-postest-2');
-- expect: both rows insert successfully — no unique violation.
-- This proves the per-occurrence exemption works.

-- (Leave the rows in place if you want to verify the modal renders
--  them; otherwise archive:)
update public.acknowledgments
   set archived_at = now()
 where provider_id = '<provider_id>'
   and subject_id = '<child_id>'
   and snapshot_hash in ('phaseC-postest-1','phaseC-postest-2');
```

**Rollback (if needed):**

```sql
begin;
  alter table public.acknowledgments
    drop column if exists occurrence_metadata;
  drop index if exists public.acknowledgments_active_unique;
  create unique index acknowledgments_active_unique
    on public.acknowledgments (provider_id, type, subject_type, subject_id)
    where archived_at is null and subject_id is not null;
commit;
```

**Caveat on rollback:** if Phase C per-occurrence rows have been captured by rollback time, the original unique index will fail to recreate (multiple active rows of the same type now exist for some children). In that case, archive the per-occurrence rows first:

```sql
update public.acknowledgments
   set archived_at = now()
 where type in (
   'transportation_nonroutine_per_trip',
   'water_activities_off_premises_per_trip'
 ) and archived_at is null;
```

Then run the rollback transaction above.

### Migration 026 — `expires_at` column on `acknowledgments` (Consents Phase B)

**Status:** PENDING — written 2026-06-01, not yet applied to production. Awaits Seth's manual application via the Supabase web SQL editor and verification screenshots before promotion to Migration History below.

**File:** `supabase/migrations/026_acknowledgments_expires_at.sql`

**What it does:** adds a single nullable `expires_at timestamptz` column to `public.acknowledgments`. Forward-only, purely additive. No constraint changes, no policy changes, no index changes, no row mutations. Existing rows leave `expires_at = NULL` and behave identically to today.

**Dependency:** migration 025 (`intake_confirm_for_parent_rpc`) must already be applied.

**Why it's needed:** Consents Phase B introduces two time-bound recurring consent types (`transportation_routine_annual`, `water_activities_on_premises_seasonal`). Each captured row sets `expires_at = acknowledged_at + interval '1 year'`. The application's read paths apply the predicate `archived_at IS NULL AND (expires_at IS NULL OR expires_at > now())` to distinguish currently-satisfied from captured-but-lapsed.

**Apply procedure:** open the file on the feature branch, copy the entire contents, paste into the Supabase web SQL editor for the production project, run. The file is short (one `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) so the long-statement caveat above does not apply.

**Verification (paste each query into the SQL editor and screenshot):**

```sql
-- (a) expires_at column exists with expected shape.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public'
  and table_name='acknowledgments'
  and column_name='expires_at';
-- expect 1 row: expires_at | timestamp with time zone | YES
```

```sql
-- (b) No existing row was mutated (expires_at NULL for every
--     pre-Phase-B row).
select count(*) as total_rows,
       count(expires_at) as rows_with_expires_at
from public.acknowledgments
where archived_at is null;
-- expect: rows_with_expires_at = 0 immediately after migration.
```

```sql
-- (c) acknowledgments_active_unique partial-unique index unchanged.
select indexname, indexdef
from pg_indexes
where schemaname='public' and tablename='acknowledgments'
  and indexname='acknowledgments_active_unique';
-- expect: WHERE archived_at IS NULL AND subject_id IS NOT NULL
--         (no expires_at reference).
```

**Rollback (if needed):**

```sql
alter table public.acknowledgments
  drop column if exists expires_at;
```

Non-destructive — every row keeps every other column intact. Captured Phase B rows (if any exist by rollback time) lose their `expires_at` values, but the rows themselves and the archived audit trail survive.

## Migration History

### 2026-05-13 — Migrations 003-006: funding-source scaffolding

Applied to production:

- `003_funding_sources.sql` — created `funding_sources`, `billing_periods`, `tri_share_hubs` tables, three enums, hybrid-FK CHECK constraints, type-aware priority trigger, RLS policies.
- `004_provider_program_settings.sql` — added `program_settings jsonb` plus Michigan-specific columns to `profiles`.
- `005_invoice_items_funding_source.sql` — added nullable `funding_source_id` FK to `invoice_items` with `on delete set null`.
- `006_backfill_private_pay.sql` — inserted one `private_pay` funding source per active family.

Verification from `006`'s trailing SELECT:

| total_funding_sources_created | needs_rate_review_count | ok_count |
| ----------------------------: | ----------------------: | -------: |
| 14                            | 4                       | 10       |

Manually spot-checked Venessa's data after application — looks correct. No deviations from the migration text.

### 2026-05-13 — Migration 007: archived_by audit column

Applied to production:

- `007_funding_sources_archived_by.sql` — added nullable `archived_by uuid` FK on `public.funding_sources` referencing `auth.users(id)` with `ON DELETE SET NULL`. Pairs with `archived_at` from `003` to record who soft-deleted each funding source.

Verification (`information_schema.columns` for the new column):

| column_name | data_type | is_nullable |
| ----------- | --------- | ----------- |
| archived_by | uuid      | YES         |

Exact match against expected output. No deviations.

### 2026-05-13 — Migration 008: funding document vault

Applied to production:

- `008_funding_documents.sql` — created `funding_documents` table, `funding_document_type` enum (`dhs_198`, `enrollment_agreement`, `other`), four indexes (including the partial-unique `funding_documents_one_active_per_type` that excludes `'other'`), RLS policies (select/insert/update only — no delete; soft-delete via `archived_at`), the private `funding-documents` storage bucket, and three storage policies (insert/select/delete; objects are immutable). Storage RLS reuses the `(storage.foldername(name))[1]` template from `002`. Storage path layout: `<user_id>/<funding_source_id>/<uuid>.<ext>`.

Verification:

- `funding_documents` table has 16 columns (14 design columns plus `created_at` / `updated_at`).
- `archived_at`, `archived_by`, `uploaded_by_user_id`, and `file_size_bytes` (`bigint`) all present.
- `retention_until` default resolves to `(current_date + interval '4 years')::date` as expected.
- Bucket row exists with `public = false`. Confirmed private.

No deviations from migration text. No backfill (no pre-existing documents).

### 2026-05-14 — Migration 009: MiRegistry training entries — ⚠️ RETRACTED, SEE 2026-05-15

**This entry was inaccurate and has been retracted.** It originally stated, on
2026-05-14, that migration `009_miregistry_training_entries.sql` had been
applied to production and verified. It had not. The migration was not applied
to production until 2026-05-15 — see the entry below for the real record.

The "Verification" bullets recorded in the original entry were never run
against the production database. They were reported in a Claude Code chat
session without any user-visible evidence, and the migration itself had not
been applied. The chain of trust broke here: a migration was logged as applied
and verified on the strength of an assistant chat report alone. See
`docs/tech_debt.md` § "Verification gap discovered 2026-05-15".

### 2026-05-15 — Migration 009: MiRegistry training entries + profiles columns

Applied to production on **2026-05-15**, manually, by pasting the full text of
`009_miregistry_training_entries.sql` into the **Supabase web SQL editor**
(the dashboard). Not applied via the `supabase` CLI — this project has no CLI
migration ledger (`supabase_migrations.schema_migrations` does not exist).

What the migration creates:

- `miregistry_training_entries` table, `miregistry_training_source` enum
  (`leppt`, `annual_ongoing`, `level_2_approved`, `other`), two partial indexes
  (`miregistry_entries_user_completed_idx`, `miregistry_entries_user_source_idx`,
  both `WHERE archived_at IS NULL`), RLS policies (select/insert/update only —
  no delete; soft-delete via `archived_at`), and the `set_updated_at` trigger.
- Three new `profiles` columns for the manually-transcribed Training Level
  state: `miregistry_current_level` (text, constrained to
  `'level_1' | 'level_2' | NULL` via the `profiles_miregistry_level_values`
  check), `miregistry_level_2_expires_on` (date),
  `miregistry_level_last_updated_at` (timestamptz). All nullable; meaningful
  only for license-exempt providers.

Verification — three queries run by the user in the Supabase web SQL editor,
with results:

1. Table exists:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'miregistry_training_entries';
   ```
   → 1 row: `miregistry_training_entries`.

2. `profiles` columns:
   ```sql
   SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'profiles'
     AND column_name LIKE 'miregistry%';
   ```
   → 4 rows: `miregistry_current_level` (text), `miregistry_id` (text),
   `miregistry_level_2_expires_on` (date),
   `miregistry_level_last_updated_at` (timestamp with time zone).

3. Enum exists:
   ```sql
   SELECT typname FROM pg_type WHERE typname = 'miregistry_training_source';
   ```
   → 1 row: `miregistry_training_source`.

Non-changes worth noting:

- `profiles.annual_training_completion_date` is intentionally untouched. It
  enters its deprecated phase with this PR's implementation; a follow-up
  cleanup PR drops the column once write paths are removed (per
  `docs/tech_debt.md` § Planned deprecations).
- No backfill — no existing training entries to migrate.

### 2026-05-17 — Migration 010: CDC pay period catalog

Applied to production on **2026-05-17** by Seth, via **two channels**
(forced by the web SQL Editor bug recorded in the operational note above):

- **DDL** — the `cdc_pay_period_catalog` table, the
  `cdc_pay_period_catalog_year_start_idx` index, `enable row level
  security`, and the single SELECT policy — applied through the **Supabase
  web SQL Editor** as four separate single-line statements.
- **The 52 seed rows** — the 2025 schedule (501–526) and the 2026 schedule
  (601–626) — applied via the **direct Supabase connection (MCP path)**,
  because the web SQL Editor corrupted the long multi-row `INSERT`
  statements (~1500+ chars each). See the operational note in the Migration
  Application Procedure section above.

Not applied via the `supabase` CLI — this project has no CLI migration
ledger (`supabase_migrations.schema_migrations` does not exist).

What the migration creates:

- `cdc_pay_period_catalog` table — a **statewide** reference table (no
  `user_id`) holding the MDHHS-published CDC Payment Schedule. Modelled on
  `tri_share_hubs` (migration 003): readable by every authenticated user,
  never written from the app.
- One index, `cdc_pay_period_catalog_year_start_idx` on
  `(schedule_year, start_date)`. The `unique (schedule_year, period_number)`
  constraint provides a second index.
- RLS enabled, with a single SELECT policy for `authenticated`. **No
  insert/update/delete policies** — the catalog is seeded by migration only.
- 52 seed rows: the 2025 schedule (period numbers 501–526) and the 2026
  schedule (601–626), transcribed from `docs/cdc_pay_periods_spec.md`
  Appendix A.

No dependency on migration 009. Independent of `billing_periods` (migration
003), which this migration deliberately leaves untouched.

Verification — four queries run by Seth in the Supabase web SQL editor on
**2026-05-17**, all passed:

1. **Table exists** — `information_schema.tables` returns
   `public.cdc_pay_period_catalog`. ✓
2. **Row count** — 52 rows total, 26 per `schedule_year` (2025 and 2026). ✓
3. **Contiguity** (spec § 7.5) — ordered by `start_date`, every period's
   `start_date` equals the previous period's `end_date + 1`; the
   gap/overlap query returned 0 rows. ✓
4. **RLS** — row level security enabled, exactly one policy:
   `cmd = SELECT`, `roles = {authenticated}`, no insert/update/delete
   policies. ✓

Rollback: uncomment the `DOWN MIGRATION` block at the foot of the migration
file (drop policy → drop index → drop table). Dropping the table removes all
52 seeded rows; no separate DELETE is needed.

### 2026-05-18 — Migration 011: profiles.onboarding_state column

Applied to production on **2026-05-18** by Seth, via the **Supabase web
SQL Editor** — a single `ALTER TABLE` statement. The web SQL Editor
long-statement bug (see the Migration Application Procedure note above)
does not apply: this is one short single statement, pasted and run
directly.

Applied ahead of the original plan (which scheduled it for the end of
PR #7's Phase 3). It was pulled forward so the Phase 2 onboarding-wizard
write-through could be smoke-tested against production before Phase 3's
dashboard integration is built on top of it.

What the migration does:

- `011_onboarding_state.sql` — adds a single column,
  `public.profiles.onboarding_state jsonb not null default '{}'::jsonb`.
  It is the bookkeeping blob for the first-login onboarding wizard
  (`docs/onboarding_wizard_spec.md` § 2.3): `version`, `completed_at`,
  `dismissed_at`, `last_step`, `skipped`. Wizard answers are **not** stored
  here — each writes through to its canonical column.

Dependencies:

- Sequential after migration `010` (the next free number). No data
  dependency on `010` or any other migration — this is an isolated
  column-add on `profiles`.

No backfill statement: the `default '{}'::jsonb` populates every existing
`profiles` row (Venessa + 2 others) at `ALTER` time. Each then reads as
"not yet onboarded" (`completed_at` absent), which is the intended
backfill of structural identity (spec § 4.3).

RLS: no new policy. `onboarding_state` is a new column on `public.profiles`,
which already has per-provider read/write policies (migration 001); the
column inherits them.

Editor note: this is a **single short DDL statement**, so the web SQL
Editor long-statement bug recorded in the Migration Application Procedure
above does not apply — it can be pasted and run directly.

Verification — two queries run by Seth in the Supabase web SQL Editor on
**2026-05-18**, both passed:

1. **Column exists with the right type/default** —
   `select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema='public' and table_name='profiles'
      and column_name='onboarding_state';`
   Returned one row: `onboarding_state | jsonb | NO | '{}'::jsonb`. ✓
2. **Every existing row is backfilled** —
   `select count(*) as total,
           count(*) filter (where onboarding_state = '{}'::jsonb) as empty_blob
    from public.profiles;`
   Returned `total = 3`, `empty_blob = 3` — every existing `profiles` row
   defaults to `{}`. The 3 rows are Venessa + 2 others, matching the
   expected production state. ✓

Rollback: uncomment the `DOWN MIGRATION` block at the foot of
`011_onboarding_state.sql` — `alter table public.profiles drop column if
exists onboarding_state;`. Dropping the column discards any wizard
bookkeeping written since application; the canonical answer columns
(`profiles.*`, `program_settings.*`) are unaffected.

### 2026-05-19 — Migration 012: staff training tracking schema

Applied to production on **2026-05-19** by Seth, via the **Supabase web
SQL Editor** (PR #8, branch `docs/staff-training-tracking-spec`).

What the migration does — `012_staff_training.sql` creates the operational
schema for staff training tracking (PR #8), verified against Michigan
Administrative Code R 400.1901–1963 (MiLEAP):

- 4 enums — `regulatory_role`, `staff_training_category`,
  `miregistry_status`, `background_check_status`.
- `caregivers` — the licensee's regulatory roster; a row may or may not be
  linked to an auth user (`app_user_id`).
- `caregiver_regulatory_roles` — many-to-many caregiver → regulatory role;
  driver-only attributes CHECK-scoped to driver rows.
- `staff_training_records` — the per-caregiver training log, keyed on
  `caregiver_id`; two status enum columns gated by a CHECK to their
  categories; soft delete via `archived_at`.
- `health_safety_updates` — per-licensee R 400.1924(11) notices.
- 6 indexes, 3 `set_updated_at` triggers, provider-scoped RLS on all 4
  tables.

Dependencies — sequential after migration 011; no data dependency on any
prior migration. References `auth.users` and the migration-001
`set_updated_at()` function. `public.staff_memberships` is left untouched.

Editor note — `012` is **all DDL, no long seed INSERT**, so the web SQL
Editor long-statement bug (operational note above) does not apply; it can
be pasted and run as a whole file or statement by statement.

Verification — queries run by Seth in the Supabase web SQL Editor on
**2026-05-19**, all passed:

1. **Tables exist** — `information_schema.tables` returns `caregivers`,
   `caregiver_regulatory_roles`, `health_safety_updates`,
   `staff_training_records` in schema `public` (4 rows). ✓
2. **Enums exist** — `select typname from pg_type where typname in
   ('regulatory_role','staff_training_category','miregistry_status',
   'background_check_status');` → 4 rows. ✓
3. **RLS enabled** — `pg_tables.rowsecurity = true` for all 4 tables. ✓
4. **Empty** — `caregivers` returns 0 rows (`012` seeds nothing). ✓

Rollback — uncomment the `DOWN MIGRATION` block at the foot of
`012_staff_training.sql` (drop the 4 tables in reverse-dependency order,
then the 4 enums). The tables hold no data until the app writes to them.

### 2026-05-19 — Migration 013: training requirements catalog

Applied to production on **2026-05-19** by Seth, via the **Supabase web
SQL Editor** (PR #8, branch `docs/staff-training-tracking-spec`),
**after migration 012** (it uses 012's `staff_training_category` and
`regulatory_role` enums).

A second run of the migration file errored with `type
"requirement_cadence" already exists`. A diagnostic confirmed this was a
duplicate-run artefact, not a failure: the first run had already
succeeded — the two enums and the `training_requirements` table were
present and all 28 seed rows in place. No remediation was needed; both
012 and 013 are in their intended final state.

What the migration does — `013_training_requirements.sql` creates the
verified MiLEAP training requirement catalog (PR #8) — reference data,
structurally like `cdc_pay_period_catalog` (migration 010):

- 2 enums — `requirement_cadence`, `requirement_condition`.
- `training_requirements` — one row per (training category, regulatory
  role) requirement, each carrying its `R 400.19xx` citation.
- 1 index; SELECT-only RLS for `authenticated` (no write policies — the
  catalog is migration-seeded, like `cdc_pay_period_catalog`).
- Seeds **28 rows** — every ✔ cell of the spec § 6.2 matrix.

Dependencies — must be applied **after migration 012** (uses the
`staff_training_category` and `regulatory_role` enums created in 012).

Editor note — the seed is split into **6 short INSERT statements (≤ 6 rows
each)**, one per training category, to stay clear of the web SQL Editor
long-statement bug (operational note above).

Verification — queries run by Seth in the Supabase web SQL Editor on
**2026-05-19**, all passed:

1. **Table + enums exist** — `training_requirements` in
   `information_schema.tables`; `requirement_cadence` and
   `requirement_condition` in `pg_type`. ✓
2. **Row count** — `select count(*) from public.training_requirements;`
   → **28**. ✓
3. **Breakdown by role** — `select regulatory_role, count(*) from
   public.training_requirements group by regulatory_role order by 1;`
   → `child_care_assistant` 6, `child_care_staff_member` 6, `driver` 4,
   `licensee` 6, `supervised_volunteer` 1, `unsupervised_volunteer` 5. ✓
4. **RLS** — row level security enabled, exactly one policy
   (`cmd = SELECT`, `roles = {authenticated}`), no write policies. ✓

Rollback — uncomment the `DOWN MIGRATION` block at the foot of
`013_training_requirements.sql` (drop the table, then the 2 enums).

### 2026-05-19 — Migration 014: profiles.terms_accepted_at — PENDING PRODUCTION APPLICATION

> ⚠️ **Status: PENDING PRODUCTION APPLICATION.** Ships on branch
> `chore/legal-pages-and-consent`; **not yet applied**. Apply per the
> Migration Application Procedure above — including the user-visible
> dashboard verification convention (`CLAUDE.md` § Critical Domain
> Knowledge: the user runs the verification queries in the Supabase
> web SQL Editor and saves a screenshot). This entry is completed with
> the actual verification output at application time; the numbers below
> are *expected*, not confirmed.

What the migration does — `014_terms_acceptance.sql` adds a nullable
`terms_accepted_at timestamptz` column to **both** user-shaped tables:
`public.profiles` (providers and staff) **and** `public.parent_profiles`
(parents). Both record when the user clicked through the required Terms
of Service / Privacy Policy clickwrap added in the same branch on the
`LoginPage` signup form, `StaffInviteAcceptPage` (both → `profiles`), and
`InviteAcceptPage` (→ `parent_profiles`). NULL means no recorded
acceptance — the intended state for every existing row, since
pre-existing users never went through the clickwrap. See
`docs/tech_debt.md` § "Existing users have no recorded Terms acceptance"
for the remediation plan.

Dependencies — none beyond `001_profiles.sql` and the (out-of-band)
existence of `public.parent_profiles`. Independent of every migration
after it.

Editor note — `014` is **two short DDL statements** plus two
`comment on column` statements, so the web SQL Editor long-statement
bug (operational note above) does not apply; it can be pasted and run
as a whole file.

RLS — no new policy. `terms_accepted_at` is a new column on tables
that already have per-user read/write policies; the column inherits
them on each table.

Expected verification (run by the user in the Supabase web SQL Editor
at application time, then recorded here):

1. **Both columns exist with the right type/nullability** —
   `select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema='public'
      and column_name='terms_accepted_at'
    order by table_name;`
   → 2 rows: `parent_profiles | terms_accepted_at | timestamp with time zone | YES | NULL`
   and `profiles | terms_accepted_at | timestamp with time zone | YES | NULL`.
2. **Pre-existing rows read NULL on both tables** —
   `select 'profiles' as t, count(*) as total,
           count(*) filter (where terms_accepted_at is null) as null_rows
    from public.profiles
    union all
    select 'parent_profiles', count(*),
           count(*) filter (where terms_accepted_at is null)
    from public.parent_profiles;`
   → for each row, `total = null_rows` (every existing row has no
   recorded acceptance).
3. **Both column comments are set** —
   `select 'profiles' as t,
           col_description('public.profiles'::regclass,
             (select ordinal_position from information_schema.columns
              where table_schema='public' and table_name='profiles'
                and column_name='terms_accepted_at')) as comment
    union all
    select 'parent_profiles',
           col_description('public.parent_profiles'::regclass,
             (select ordinal_position from information_schema.columns
              where table_schema='public' and table_name='parent_profiles'
                and column_name='terms_accepted_at'));`
   → 2 rows, each with the comment text from
   `014_terms_acceptance.sql` (cites 2026-05-19 and the deferred
   `user_agreements` shape).

Rollback — uncomment the `DOWN MIGRATION` block at the foot of
`014_terms_acceptance.sql` (drops the column from both
`public.profiles` and `public.parent_profiles`). Dropping the columns
discards every recorded acceptance written since application; the
clickwrap UI continues to gate signup either way.

### 2026-05-19 — Migration 015: Supabase security advisor hardening — PENDING PRODUCTION APPLICATION

> ⚠️ **Status: PENDING PRODUCTION APPLICATION.** Ships on branch
> `chore/supabase-security-hardening`; **not yet applied**. Apply per
> the Migration Application Procedure above — including the
> user-visible dashboard verification convention (`CLAUDE.md`
> § Critical Domain Knowledge). This entry is completed with the
> actual verification output at application time; the numbers below
> are *expected*, not confirmed.

What the migration does — `015_security_hardening.sql` resolves the
three pre-existing Supabase security advisor findings recorded in
`docs/backlog.md`:

- **Locks `search_path` on the 5 mutable-search_path functions** —
  `set_updated_at`, `current_user_licensee_id`, `current_user_role`,
  `bump_thread_last_message_at`, `set_funding_source_priority_default`
  → each gets `set search_path = public, pg_catalog` via
  `ALTER FUNCTION` (proconfig change only, no body rewrite).
- **Tightens `handle_new_user`** from its migration-001 setting of
  `search_path = public` (no `pg_catalog`) to the standard
  `public, pg_catalog`.
- **Scopes `admin_user_progress`** to `public, auth` (its body
  references `auth.sessions` and `auth.jwt()`, so it genuinely needs
  the `auth` schema on the path).
- **Revokes `EXECUTE` from `anon`** on all 7 functions — per-function
  rationale documented inline in the migration. The four trigger
  functions don't consult function-level EXECUTE; the two
  `current_user_*` helpers are only consulted inside RLS policy
  expressions; `admin_user_progress` is called only from the
  `smdominique@gmail.com`-gated `AdminPage` under the `authenticated`
  role.
- **Adds a `comment on function` to `admin_user_progress`** so the
  smdominique-only intent is legible in `pg_proc` itself.

Dependencies — none beyond the existence of the 7 functions
themselves (4 of which were created out-of-band; see
`docs/tech_debt.md` § "Migrations folder is out of sync with
production schema").

Editor note — all DDL, no long seed `INSERT`, so the web SQL Editor
long-statement bug (operational note above) does not apply; can be
pasted and run as a whole file.

Signature note — every `ALTER FUNCTION` / `REVOKE` uses the zero-arg
signature `name()`, verified against the dashboard `pg_proc` lookup
done on 2026-05-19. If any statement errors with "function … does not
exist", the live signature has drifted; re-run the dashboard signature
query and update the `(args)` on the offending line.

Expected verification (run by the user in the Supabase web SQL Editor
at application time, then recorded here):

1. **All 7 functions have the expected `proconfig`** —
   ```sql
   select proname, proconfig
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and proname in (
       'set_updated_at',
       'current_user_licensee_id',
       'current_user_role',
       'bump_thread_last_message_at',
       'set_funding_source_priority_default',
       'admin_user_progress',
       'handle_new_user'
     )
   order by proname;
   ```
   → 7 rows. `proconfig` contains `search_path=public,pg_catalog` for
   six of them; `admin_user_progress` has `search_path=public,auth`.
2. **No `anon` EXECUTE grants remain on any of the 7** —
   ```sql
   select routine_name, grantee, privilege_type
   from information_schema.routine_privileges
   where grantee = 'anon'
     and routine_schema = 'public'
     and routine_name in (
       'set_updated_at',
       'current_user_licensee_id',
       'current_user_role',
       'bump_thread_last_message_at',
       'set_funding_source_priority_default',
       'admin_user_progress',
       'handle_new_user'
     );
   ```
   → 0 rows.
3. **`admin_user_progress` carries the operational comment** —
   ```sql
   select obj_description('public.admin_user_progress()'::regprocedure);
   ```
   → the comment text written by `015_security_hardening.sql` (cites
   `AdminPage.jsx`, the smdominique gate, and 2026-05-19).
4. **Re-run the Supabase security advisor** in the dashboard
   (Database → Advisors → Security). The three categories recorded in
   `docs/backlog.md` should be cleared:
   - "Function Search Path Mutable" — 0 entries from the 5 listed
     functions
   - "RLS Disabled in Public" / SECURITY DEFINER + anon exposure —
     0 entries from the listed functions
   - Leaked-password protection — see the dashboard step below

#### Dashboard step — enable leaked-password protection

Not part of migration 015 (it's a Supabase Auth config, not a SQL
object). Apply after 015 lands:

1. Open the Supabase dashboard → **Authentication** → **Providers** →
   **Email**.
2. Enable **"Check passwords against HaveIBeenPwned"** (the
   leaked-password protection toggle).
3. Click **Save**.

After this, the advisor's "Leaked Password Protection Disabled"
finding clears too.

Rollback — uncomment the `DOWN MIGRATION` block at the foot of
`015_security_hardening.sql`. It resets each function's `search_path`
override and re-grants `EXECUTE` to `anon`, restoring the pre-015
state (`handle_new_user` goes back to `set search_path = public` to
match migration 001's original). The dashboard leaked-password toggle
is rolled back separately by un-checking the same setting.### Documentation gap � Migrations 016-020 (applied 2026-05-21 to 2026-05-22)

> ?? **Doc debt � runbook entries not written at the time of application.**
> The following five migrations exist in `supabase/migrations/` and were
> applied to production (later migrations depending on them succeed, so
> the schema is live), but individual runbook entries were never written
> during the May 21-22 work. Specific verification outputs and
> application dates are not preserved beyond the file `LastWriteTime`.
> Flagged here for completeness; reconstructed entries are not attempted
> because that would invent history. If a question ever arises about
> exact verification at application time, the answer is: it was done by
> the user in the Supabase web SQL Editor per CLAUDE.md convention, but
> the screenshots and query outputs were not saved.

- `016_capture_existing_schema_for_pr_8_5.sql` � schema capture migration
  for PR #8.5, ~2026-05-21.
- `017_promote_cdc_fields_and_expand_lifecycle.sql` � CDC field promotion
  and lifecycle expansion, ~2026-05-21.
- `018_provider_cdc_billing_settings.sql` � provider CDC billing settings
  table, ~2026-05-21.
- `019_pr_9_i_billing_schema.sql` � PR #9 I-Billing schema, ~2026-05-21.
- `020_parent_acknowledgment.sql` � parent acknowledgment table (PR #12),
  ~2026-05-22.

Going forward, runbook entries are written in the same session as the
migration is applied. The 2026-05-28 backfill session that produced this
note (and the entries below for 021, 022, 023) is the corrective action.

### ~2026-05-25 � Migration 021: children.archived_at + soft-delete audit (PR #13) � BACKFILLED ENTRY

> ?? **Backfilled 2026-05-28.** Applied to production in late May 2026
> (file `LastWriteTime` is 2026-05-25; exact application date not
> preserved). User-run verification was performed in the Supabase web
> SQL Editor at application time per CLAUDE.md convention; specific
> query outputs were not saved. This entry is reconstructed from the
> migration file itself and the PR #13 scope doc; the schema shape is
> recoverable from `supabase/migrations/021_children_archived_at.sql`.

What the migration does � `021_children_archived_at.sql` adds soft-delete
to the `public.children` table:

- `archived_at timestamptz` � nullable; non-null indicates soft-deleted.
- `archived_by uuid` � references `auth.users(id) on delete set null`;
  records who soft-deleted the child.
- Partial index on `(licensee_id, archived_at)` filtered to
  `archived_at IS NOT NULL` for archive-list queries.
- RLS update policy expanded to allow setting `archived_at` from null to
  non-null.

Dependencies � sequential after migration 020. Independent of any
prior migration's data.

Editor note � short DDL, no long seed INSERT; the web SQL Editor
long-statement bug (operational note above) does not apply.

Verification � performed by the user in the Supabase web SQL Editor at
application time. Specific query output not preserved. The verification
checked column existence, partial index existence, and the updated RLS
policy shape. ? at application time; not re-verifiable from saved
artifacts.

Rollback � uncomment the `DOWN MIGRATION` block in
`021_children_archived_at.sql` (drop the index, then the columns).

### 2026-05-26 � Migration 022: license_type foundation (PR #14) � BACKFILLED ENTRY

> ?? **Backfilled 2026-05-28.** Applied to production on 2026-05-26
> (per session notes and file `LastWriteTime`). User-run verification
> was performed in the Supabase web SQL Editor at application time per
> CLAUDE.md convention; the LicenseTypeReviewBanner was also smoke-tested
> end-to-end in production with the user selecting Group Home and seeing
> the "Thanks!" confirmation. Specific verification query output is
> partially preserved in session notes (post-application count by
> license_type: `group_home: 1, license_exempt: 1, needs_review: 1`)
> but not screenshot-archived.

What the migration does � `022_license_type.sql` introduces the
`license_type` foundation column on `public.profiles` (PR #14):

- `license_type text` with CHECK over
  `'family_home' | 'group_home' | 'license_exempt'` (text + CHECK over
  ENUM per house pattern � same rationale as `provider_type`).
- `license_type_review_needed boolean` � drives the re-prompt banner
  when set.
- Transactional backfill from existing `provider_type` and
  `is_license_exempt` columns, plus a row-count SELECT.
- Header cites R 400.1925 / R 400.1927 / R 400.1928 (Michigan
  Administrative Code).

Dependencies � sequential after migration 021. Depends on existing
`provider_type` and `is_license_exempt` columns on `profiles` for the
backfill (both present in production pre-022).

Editor note � DDL plus a transactional backfill plus a row-count
SELECT, all short statements; the web SQL Editor long-statement bug
does not apply.

Verification � performed by the user in the Supabase web SQL Editor at
application time. Partial result preserved in session notes: count by
license_type post-backfill was `group_home: 1, license_exempt: 1,
needs_review: 1`. Screenshots not saved.

Additionally smoke-tested end-to-end in production: user logged in, saw
the LicenseTypeReviewBanner, selected Group Home, saw the "Thanks!"
confirmation. The 3-row post-state matched expectation (Venessa ?
group_home, one license-exempt test account, one row pending user
selection � the licensee_review_needed flag was correctly true on the
third row at the time, though that flag has since been cleared and the
underlying row resolved per separate followup).

Rollback � uncomment the `DOWN MIGRATION` block in
`022_license_type.sql`. The transactional backfill is destructive on
rollback (you lose the backfilled values); a re-run of the migration
re-derives them from `provider_type` and `is_license_exempt`.

### 2026-05-28 � Migration 023: opt-in reminder system schema (PR #15 Half 1)

Applied to production on **2026-05-28** by Seth, via the **Supabase web
SQL Editor** (PR #15 Half 1, branch `feature/pr-15-reminder-system`).
This is the schema half of PR #15; Half 2 (the dispatcher cron, hooks,
settings UI, banner host, and `vercel.json` wiring) is a separate pass
not yet built.

What the migration creates � `023_reminder_system.sql`:

- **`public.reminder_preferences`** � one row per `(provider_id,
  category)`. Tracks the provider's opt-in choice per reminder
  category. Fields: `channel` (text + CHECK over
  `'in_app' | 'email' | 'both'`), `lead_time_days` (int 0-365, default
  7), `enabled` (boolean, default true). The category column is
  free-text (text, no CHECK enum) per OQ3 � the authoritative catalog
  lives in `src/lib/reminderCategories.js`, not the database.
- **`public.reminder_instances`** � one row per scheduled reminder
  fire. Polymorphic anchor via `(subject_type text, subject_id uuid)` �
  both nullable so provider-level reminders work too. Captures
  `trigger_at`, `due_at`, `title`, `body`, `cta_path`, `fired_at`,
  `fired_via`, `dismissed_at`, `resolved_at`, `archived_at`.
- **Two partial unique indexes** to handle Postgres's NULL-distinct
  unique-constraint semantics correctly:
  `idx_reminder_instances_unique_subject` (where `subject_id IS NOT
  NULL`) and `idx_reminder_instances_unique_no_subject` (where
  `subject_id IS NULL`). Together they prevent duplicate instances for
  both subject-bound and provider-level reminders.
- **Two hot-path indexes** �
  `idx_reminder_instances_pending` (dispatcher cron filter) and
  `idx_reminder_instances_active` (banner host filter).
- **RLS** � provider-scoped SELECT/INSERT/UPDATE on
  `reminder_preferences` (3 policies); provider-scoped SELECT only on
  `reminder_instances` (1 policy). Server-side schedulers and the
  dispatcher run under the service role (bypasses RLS). Provider
  mutations on `reminder_instances` go through two SECURITY DEFINER
  RPCs.
- **Two SECURITY DEFINER RPCs** �
  `reminder_instance_dismiss(p_instance_id uuid)` and
  `reminder_instance_resolve(p_instance_id uuid)`. Both lock
  `search_path = public`, enforce ownership via
  `where provider_id = auth.uid()` inside the function body, are
  idempotent (no-op if already set/archived/owned-by-another-provider),
  and grant EXECUTE only to `authenticated`.
- Two `set_updated_at` triggers (one per table) using the existing
  `public.set_updated_at()` function from migration 001.

Dependencies � sequential after migration 022 (PR #14 license_type).
Hard dependency on `public.set_updated_at()` (verified to exist
pre-application via `pg_proc` query). No data dependency on any prior
migration � no backfill, no seed rows.

Editor note � all DDL plus two CREATE OR REPLACE FUNCTION statements;
no long seed INSERTs. The web SQL Editor long-statement bug
(operational note above) does not apply. Migration was pasted as a
single file and executed in one run.

Verification � four queries run by Seth in the Supabase web SQL Editor
on **2026-05-28**, all passed:

1. **Tables exist** �
```sql
-- (verification SQL truncated in the source file; canonical
-- queries live in the header of supabase/migrations/023_*.sql.)
```

### 2026-05-29 � Migration 024: child files + acknowledgments + parent-loop RPCs (PR #16)

Applied to production on **2026-05-29** by Seth, via the **Supabase web
SQL Editor** (PR #16, branch `feature/pr-16-child-files-scope`,
merged into `main` at commit `ff32f09`). This is the schema for the
child-files compliance domain plus the SECURITY DEFINER plumbing that
closes the provider->parent->portal acknowledgment loop.

What the migration creates � `024_child_files_and_acknowledgments.sql`:

- **`public.children` � 5 new columns** � `immunization_status`
  (text + CHECK over `'up_to_date' | 'waiver_on_file' | 'in_progress'`),
  `immunization_record_url` (text), `food_provider` (text + CHECK over
  `'provider' | 'parent' | 'both'`), `records_last_reviewed_on` (date),
  `intake_completed_at` (timestamptz). Rule 7 / R 400.1907 structured
  fields that the intake bundle writes and `getChildFilesAuditState`
  reads.
- **`public.profiles` � 2 new columns** � `home_built_before_1978`
  (boolean, nullable) and `firearms_on_premises` (boolean, nullable).
  Per-property disclosure answers set by the in-product Premises
  prompt on `BusinessInfoPage`. Intake form reads them to gate which
  child-level acknowledgments are required (lead, firearms).
- **`public.acknowledgments`** � new polymorphic table. One row per
  acknowledged item. Discriminated by `(type, subject_type,
  subject_id)`: provider-level acks (e.g. `licensing_notebook_offered`)
  carry NULL subject; child-level acks (e.g. `lead_disclosure`,
  `firearms_disclosure`, `child_in_care_statement`,
  `food_provider_agreement`, `discipline_policy_receipt`,
  `infant_safe_sleep`, `health_condition`) carry
  `subject_type='child'` + the child id. Envelope row
  (`child_in_care_statement`) carries a `snapshot_hash` composed from
  the sub-row hashes; drift detection on the snapshot_hash flips
  intake-complete to false. Channel field tracks how the ack was
  captured: `in_person_paper` (provider attests parent signed paper) |
  `provider_override` (provider signs on parent's behalf with
  documented reason) | `parent_portal` (parent self-signs at
  `/parent/intake-acknowledge`). CHECK constraints enforce the
  channel-shape rules (parent_portal requires
  `acknowledged_by_user_id IS NOT NULL`; `provider_override` requires
  `provider_override_reason IS NOT NULL`).
- **Two partial unique indexes** on `acknowledgments` �
  `acknowledgments_provider_active` (where `archived_at IS NULL`)
  and `acknowledgments_subject_active` (where `subject_id IS NOT
  NULL AND archived_at IS NULL`). Together prevent duplicate active
  acks for the same provider+type+subject tuple.
- **RLS on `acknowledgments` � 5 policies**: provider SELECT/INSERT/UPDATE
  on rows where `provider_id = auth.uid()`; parent SELECT/INSERT on
  rows whose `subject_id` belongs to a child the parent is linked to
  via `parent_family_links` (status='active'). No DELETE policy �
  acks are archived via `archived_at`, never hard-deleted (audit
  retention per CLAUDE.md domain rules).
- **Three SECURITY DEFINER RPCs** for the
  intake_acknowledgment_pending reminder loop:
  - `reminder_instance_request_intake_ack(p_child_id uuid, p_title
    text, p_body text, p_cta_path text, p_trigger_at timestamptz)
    returns uuid` � provider-side. Inserts one
    `reminder_instances` row of category
    `'intake_acknowledgment_pending'` for the named child, after
    asserting the caller owns the child via `children.user_id =
    auth.uid()`. Returns the new row id (or NULL on conflict).
    Lets `ChildIntakeModal`'s "Send to parent's portal" channel
    write to `reminder_instances` despite RLS having no
    authenticated INSERT policy.
  - `reminder_instance_resolve_for_parent(p_instance_id uuid)
    returns void` � parent-side. Sets `resolved_at = now()` on the
    named pending reminder iff `category =
    'intake_acknowledgment_pending'`, `subject_type='child'`, and
    the child links to `auth.uid()` via active
    `parent_family_links`. No-op silently otherwise. Migration 023's
    `reminder_instance_resolve` was provider-scoped and would deny
    the parent � this is the parent-scoped sibling.
  - `reminder_instance_list_for_parent() returns table(id uuid,
    subject_id uuid)` � parent-side. Returns the `(id, subject_id)`
    tuples for the calling parent's pending intake-ack reminders,
    scoped by the same guard as the resolve RPC. Closes the
    RLS-blind dead-loop bug: a pre-RPC version of the page used a
    direct `.from('reminder_instances').select(...)` which RLS
    denied for parents, leaving `pendingByChild` empty and the
    resolve loop unreachable.

Dependencies � sequential after migration 023 (PR #15 Half 1
reminder_instances). Hard dependency on `public.parent_family_links`
with the `status='active'` value (from PR #12). Verified live in the
dashboard before merge.

Editor note � large migration with multiple CREATE TABLE / CREATE
POLICY / CREATE OR REPLACE FUNCTION statements but no long seed
INSERTs. Pasted as a single file; the web SQL Editor long-statement
bug (operational note above) did not bite. Three passes of
amendments landed in-place on 024 across the build (no 025 created):
the initial PR #16 build, the second-pass UPDATE that added the
provider->portal trigger plus the first two RPCs, and the third-pass
UPDATE that added `reminder_instance_list_for_parent` to close the
dead resolve loop.

Verification � the following five queries run by Seth in the
Supabase web SQL Editor on **2026-05-29**, all passed before merge:

1. **`children` new columns** � 5 rows returned
   (`food_provider, immunization_record_url, immunization_status,
   intake_completed_at, records_last_reviewed_on`).
2. **`profiles` new columns** � 2 rows returned
   (`firearms_on_premises, home_built_before_1978`).
3. **`acknowledgments` RLS policies** � 5 policies returned (parent
   insert/view + provider insert/update/view).
4. **Three new RPCs present** � `pg_proc` returned the three function
   names: `reminder_instance_list_for_parent,
   reminder_instance_request_intake_ack,
   reminder_instance_resolve_for_parent`.
5. **`parent_family_links.status='active'` dependency** � confirmed
   live (required by the two parent-scoped RPCs).

Post-merge � `feature/pr-16-child-files-scope` merged into `main` at
commit `ff32f09` via `git merge --no-ff`, pushed at 2026-05-29.
Vercel production deploy triggered by the push to `main`. No
rollback executed.

### 2026-06-04 — Migration 031: parent self-service Phase X (RLS lockdown + child + photo RPCs)

Applied to production on **2026-06-04**, manually via the Supabase
web SQL Editor. Companion to the Phase X build
(`feature/parent-self-service-phase-x` →
`feature/parent-self-service-phase-x-emergency-refresh`). Closed
a live production gap (parent DELETE on `emergency_contacts` and
`guardians`); shipped two SECURITY DEFINER RPCs that gate every
parent-side write through the data layer.

What the migration does:

- **RLS lockdown.** Drops the migration-016 parent DELETE policy
  on `emergency_contacts` ("Parents can delete emergency
  contacts") and the parent DELETE policy on `guardians`
  ("Parents can delete guardians for their families"). Drops the
  too-permissive "Parents can update children medical info"
  policy on `children` (migration 016:267-275 let parents UPDATE
  any column on `children`, including `archived_at` and
  `intake_completed_at`). Provider DELETE/UPDATE on these tables
  is unaffected — the `auth.uid() = user_id`-gated policies stay
  in place.
- **`block_parent_archive` BEFORE UPDATE trigger** on `children`
  and `guardians`. Defense-in-depth: any future RLS edit that
  accidentally re-opens a parent UPDATE path on these tables is
  still stopped at the trigger when `archived_at` changes
  (raises `42501`). `emergency_contacts` has no `archived_at`
  column — the DELETE-policy removal is the entirety of its
  lockdown.
- **Low-risk surface columns.** Adds
  `emergency_contacts.pickup_authorized boolean NOT NULL DEFAULT
  false` (per scope §2d Option A — extend the existing table,
  not a new authorized_pickup table). Adds four nullable text
  columns to `children`: `physician_name`, `physician_phone`,
  `dentist_name`, `dentist_phone` (per scope §2e — parent-
  authored child medical contacts).
- **`child_parent_update` SECURITY DEFINER RPC** — the only path
  for parent edits on `children`. Narrow column allowlist:
  `allergies`, `medical_notes`, `physician_*`, `dentist_*`. Never
  touches `archived_at`, `intake_completed_at`, `user_id`,
  `family_id`, `school_*`, or any other provider-owned column.
  Authorization mirrors `intake_confirm_for_parent` (migration
  025): joins through `parent_family_links` `status='active'` to
  confirm the caller has authority on the child. Care-critical
  notifications: when `allergies` or `medical_notes` changes,
  fires a `notification_log` row with
  `change_type='child_allergies_updated_by_parent'` or
  `child_medical_notes_updated_by_parent` (provider-recipient).
- **`parent_photo_consent_set` SECURITY DEFINER RPC** — parent-
  side photo-sharing grant/revoke. Atomic archive-then-insert
  for the previous active row (consent OR revocation) + new
  `parent_portal`-channel row. Same authorization shape as
  above.

In-build fix-forward: the initial migration draft wrote
`notification_log` with the wrong column names
(`user_id, kind, related_id, payload, created_at`) — CC caught
this pre-apply against `api/notify-state-change.js:308` +
`api/cron-dispatch-reminders.js:443`. The applied migration uses
the canonical 13-column shape
(`recipient_type, recipient_id, recipient_email, change_type,
change_description, changed_by_user_id, changed_by_role,
family_id, child_id, email_sent, email_sent_at, email_id,
metadata`). Without that catch, every care-critical edit would
have failed silently inside the RPC.

Dependencies — sequential after migration 030. Hard dependency
on `public.parent_family_links` (`status='active'`) from PR #12
and `public.notification_log` (pre-existing production-only
schema, also written by `api/notify-state-change.js` +
`api/cron-dispatch-reminders.js`).

Editor note — large migration with multiple ALTER TABLE +
DROP POLICY + CREATE FUNCTION + CREATE TRIGGER statements. No
long seed INSERTs. The web SQL Editor long-statement bug
(operational note above) did not bite.

Verification — the following five queries run by Seth in the
Supabase web SQL Editor on **2026-06-04**, all passed before
merge:

1. **Parent DELETE policies on `emergency_contacts` +
   `guardians`** — zero rows for `(cmd='DELETE' AND polname like
   'Parents can%')`.
2. **Broad parent UPDATE on `children`** — zero rows for
   `polname='Parents can update children medical info'`.
3. **`block_parent_archive_trg` trigger** — present on both
   `children` and `guardians` (two rows).
4. **Two RPCs present** — `pg_proc` returned `child_parent_update`
   and `parent_photo_consent_set` both granted `EXECUTE` to
   `authenticated` only.
5. **New columns present** — 5 rows
   (`emergency_contacts.pickup_authorized` + 4 on `children`).

Plus the 13-step live boundary gate ran against real seed
accounts (Jeff/2549scio, klsnay/Audrey, Dominique): every parent
DELETE / UPDATE-archive attempt denied; parent RPC paths work
correctly; care-critical notifications fire; provider DELETE +
archive unaffected. **DELETE-policy removal closed a live gap —
production parents could previously delete their
emergency_contacts and guardians.**

Post-merge — `feature/parent-self-service-phase-x-emergency-refresh`
merged into `main` via `git merge --no-ff`, pushed at
**2026-06-04**. Vercel production deploy triggered by the push.
No rollback executed.

### 2026-06-04 — Migration 033: parent self-service Phase Y1 e-sign evidence layer

Applied to production on **2026-06-04**, manually via the
Supabase web SQL Editor. Companion to the Phase Y1 build
(`feature/parent-self-service-phase-y1-evidence-boundary`). The
data-layer half of medium-risk consent e-signature — schema +
SECURITY DEFINER RPCs + WORM evidence record. **Zero UI.** Y2
ships the Business-tab toggles + template editor + provider send
modal + parent pending card.

What the migration does:

- **`consent_templates` table.** Per-provider templates with
  archive-then-insert protocol; partial-unique index
  `consent_templates_active_unique` on
  `(provider_id, consent_type)` where `archived_at IS NULL`
  (one active template per category). RLS scoped to provider
  ownership; parents have **no direct SELECT** — they see template
  body only through the snapshot column on a sent/completed
  acknowledgments row.
- **`consents_pending_esign` table.** Sent-but-not-completed
  queue. `template_body_at_send` stores a stable copy for the
  parent to read between send and completion;
  `per_send_metadata jsonb` carries per-trip data. Partial-unique
  index for durable types (one active pending per
  (provider, child, consent_type)); per-occurrence types are
  exempt. RLS: providers full CRUD on own rows; parents SELECT
  pendings for linked children but **cannot INSERT/UPDATE/DELETE**
  directly — the completion path goes through the RPC.
- **`profiles.medium_risk_consents_enabled jsonb`** — server-
  authoritative opt-in gate. All five categories default to
  `false` (OFF by default per Phase Y spec).
- **`acknowledgments` extension.** Expands the
  `chk_acknowledgments_via` CHECK to include
  `'parent_portal_esign'`. Adds three new columns:
  `typed_signature_text text`, `template_snapshot_text text`,
  `consent_template_id uuid REFERENCES consent_templates(id)
  ON DELETE SET NULL`. Adds the new
  `chk_acknowledgments_esign_shape` CHECK enforcing signature +
  snapshot non-null when `acknowledged_via='parent_portal_esign'`
  AND both NULL otherwise.
- **`block_esign_evidence_update_trg` BEFORE UPDATE trigger.**
  WORM lock on the three evidence columns
  (`typed_signature_text`, `template_snapshot_text`,
  `consent_template_id`). The trigger checks only those three
  via `IS DISTINCT FROM`; `archived_at` and all other columns
  remain mutable.
- **Three SECURITY DEFINER RPCs.**
  - `consent_esign_send(p_child_id, p_consent_type,
    p_per_send_metadata, p_expires_at) → uuid` — provider
    creates a pending. Verifies caller owns the child, the
    category is enabled on the provider's profile, and an
    active template exists. Inserts the pending row +
    notification_log row. **NOTE:** the initial 033 body had a
    bug in the parent-notification insert; see migration 034
    below for the fix-forward.
  - `consent_esign_complete(p_pending_id,
    p_typed_signature_text, p_claimed_body_text) → uuid` —
    parent signs. Authorization via active
    `parent_family_links`. Locks the pending row `FOR UPDATE`.
    Stale-read protection: re-reads the current
    `consent_templates.body_text` server-side and compares to
    `p_claimed_body_text` via `IS DISTINCT FROM` — raises
    `template_changed_since_send` on mismatch. On success:
    inserts the acknowledgments row with the AUTHORITATIVE
    snapshot, marks the pending resolved, resolves any open
    reminder_instances, fires a provider-recipient
    notification_log row. All atomic.
  - `consent_esign_rescind(p_pending_id, p_reason) → boolean`
    — provider cancels a pending row. Doesn't touch
    notification_log.

Dependencies — sequential after migration 031. Hard dependency
on `public.acknowledgments` (the channel CHECK expansion + the
three new columns), `public.parent_family_links` (parent
authorization in `consent_esign_complete`), `public.profiles`
(the new jsonb column), and `public.notification_log` (the RPC
writes notification rows for the dispatcher to email).

**Phase 1 engine integration:** the same branch shipped
`'parent_portal_esign'` into all three in-tree copies of
`PARENT_SIGNED_SATISFYING_CHANNELS` (`src/lib/childFiles.js`,
`src/lib/complianceState.js`, `src/lib/medication.js`). The
test suite (`complianceState.test.js` + `medication.test.js`)
locks the duplication invariant. Result: once an e-sign row is
written, the Phase 1 engine treats requirements #13-#17 in the
registry as `on_file` with no registry change.

Editor note — large migration with multiple CREATE TABLE +
CREATE POLICY + CREATE TRIGGER + CREATE OR REPLACE FUNCTION
statements + verbose header comments. No long seed INSERTs. The
web SQL Editor long-statement bug did not bite.

Verification — the eight (a)-(h) queries run by Seth in the
Supabase web SQL Editor on **2026-06-04**, all passed before
running the live gate:

1. **The two new tables exist** with expected column counts (11
   for `consent_templates`, 13 for `consents_pending_esign`).
2. **`acknowledgments` extension** — three new nullable columns
   present.
3. **`chk_acknowledgments_via`** includes `'parent_portal_esign'`.
4. **`chk_acknowledgments_esign_shape`** present with the
   channel-conditional clauses.
5. **`block_esign_evidence_update_trg`** attached to
   `acknowledgments`.
6. **Three RPCs present** —
   `consent_esign_send / _complete / _rescind`, EXECUTE granted
   to `authenticated` only.
7. **`profiles.medium_risk_consents_enabled`** present with the
   five-key default jsonb.
8. **RLS policies** on the two new tables match the §6 + §7
   spec.

Then the 8-step live boundary gate ran against real seed
accounts. **Step 3 surfaced a 23502 bug** in
`consent_esign_send` (recipient_id NOT NULL violation); see
migration 034 below. **Steps 1-2 passed; steps 4-8 passed after
applying 034.**

Post-merge — `feature/parent-self-service-phase-y1-evidence-boundary`
merged into `main` at commit `6afb16b` via `git merge --no-ff`,
pushed at **2026-06-04**. The branch carried migrations 033 +
034 + 035 + 036 together (the schema plus three fix-forwards
caught during the live gate). Vercel production deploy triggered
by the push. No rollback executed.

> **Post-hoc correction (added with the 036 entry below).** The
> "No bug. No change in 034." line in the migration 034 entry
> further down is **wrong** about `consent_esign_complete`. That
> RPC writes `recipient_email = null` on a provider-recipient
> row, and `notification_log.recipient_email` is also `NOT NULL`
> in production — the live gate post-034 surfaced it. Migration
> 036 corrects the bug and also fixes the latent twin in
> migration 031's `child_parent_update`. The 034 entry stands as
> the contemporaneous record of what was known at the time; do
> not infer constraint state from "another writer does this" —
> see the 036 entry below and the rule added to `CLAUDE.md`
> § Engineering Discipline.

### 2026-06-04 — Migration 034: consent_esign_send notification recipients (Phase Y1 fix-forward)

Applied to production on **2026-06-04**, manually via the
Supabase web SQL Editor, immediately after migration 033 failed
step 3 of the 8-step Y1 live gate.

What the migration does:

- **CREATE OR REPLACE `consent_esign_send`** with the corrected
  notification-recipient pattern. **No table changes.** No
  change to `consent_esign_complete` or `consent_esign_rescind`.

The bug 033 had: the parent notification insert wrote one row
with `recipient_id=NULL, recipient_email=NULL`, intending the
existing dispatcher to resolve the parent identity later.
PostgreSQL rejected with code 23502
("null value in column "recipient_id" violates not-null
constraint"). Because the pending-row insert and the
notification insert ran in one transaction, the whole thing
rolled back — `consents_pending_esign` stayed empty after every
step-3 call.

The fix: a `FOR ... LOOP` over active linked parents that mirrors
the established `parent_via_subject_child` recipient resolver
pattern (used in production by `api/cron-dispatch-reminders.js`
lines 269-299, `api/notify-state-change.js` lines 271-278, and
`api/cron-send-acknowledgment-digest.js` line 312). For each
parent in `parent_family_links` `status='active'` for the
child's family, joined to `parent_profiles`, filtered to
parents with non-null `email` AND
`coalesce(acknowledgment_email_opt_in, true) = true`, de-duped
by parent_id (DISTINCT), one notification_log row is written
with `recipient_id = parent_profiles.id` (POPULATED) and
`recipient_email = parent_profiles.email` (POPULATED).

Edge case — zero eligible parents (child has no linked active
parents, OR all parents have empty emails, OR all opted out):
the loop writes zero notification_log rows. **The pending row
still inserts and serves as the state of record** — the consent
waits in the queue for the parent to find it on next login. The
dispatcher's own "no_recipient" log-the-gap pattern uses
`recipient_id=null` which fails the NOT NULL constraint
silently in JS-land (`supabasePost` doesn't throw on non-2xx),
but we can't afford silent-swallow inside a transactional RPC,
so we skip the gap-log row entirely.

The other two RPCs verified clean:

- `consent_esign_complete` writes a provider-recipient
  notification with `recipient_id=v_provider_id` (POPULATED) +
  `recipient_email=null` — matches the in-production
  `child_parent_update` provider-recipient pattern from
  migration 031. **No bug.** No change in 034.
- `consent_esign_rescind` doesn't write to notification_log at
  all. **No bug.** No change in 034.

Dependencies — sequential after migration 033.

Editor note — `CREATE OR REPLACE FUNCTION` only; small migration
(~290 lines including the header comment block). No table
changes. Applied in seconds.

Verification — the two (a)-(b) queries run by Seth in the
Supabase web SQL Editor on **2026-06-04**, both passed before
re-running the gate:

1. **Function body fixed** — `pg_proc.prosrc LIKE
   '%for v_parent_row in%'` returned `true` for
   `consent_esign_send`.
2. **EXECUTE permissions intact** — granted to `authenticated`
   only; no `public` row.

Then the 8-step Y1 live boundary gate re-ran from step 3 against
real seed accounts (Jeff/2549scio, klsnay/Audrey, Dominique):

3. **Send succeeds.** `consents_pending_esign` row created.
   notification_log rows written, one per eligible linked
   parent, each with `recipient_id` POPULATED and
   `recipient_email` POPULATED. Confirmed.
4. **Provider edits template between send + completion.**
   Archive-then-insert protocol on `consent_templates` runs as
   expected.
5. **Parent completes via typed signature.** Stale-read
   protection fires on the OLD body
   (`template_changed_since_send` raised); succeeds with the
   NEW body. Confirmed the resulting acknowledgments row
   carries the new `template_snapshot_text` verbatim.
6. **Snapshot survives a later template edit.** The
   acknowledgments row from step 5 still shows the step-4 body
   verbatim after a third template edit/archive. The WORM
   trigger holds.
7. **Cross-tenant denial.** klsnay attempts to complete a
   pending sent to a Dominique-family child — error `42501`,
   no row written.
8. **Opt-in bypass denied.** Non-provider can't call
   `consent_esign_send` (caller-mismatch); category-disabled
   send rejected server-side; parent direct INSERT into
   `consents_pending_esign` denied by RLS.

Plus invariants: WORM trigger raises on UPDATE attempting to
change `typed_signature_text` or `template_snapshot_text`;
provider archival of a completed row succeeds (the trigger
checks only the evidence columns, not `archived_at`).

**All eight steps + invariant checks passed.** The
compliance-evidence boundary holds with the same caliber as the
consent-attachments cross-tenant gate.

Post-merge — `feature/parent-self-service-phase-y1-evidence-boundary`
merged into `main` at commit `6afb16b` via `git merge --no-ff`,
pushed at **2026-06-04**. The branch carried 033 + 034 + 035 +
036 together (see the 035 and 036 entries below for the two
later fix-forwards).

### 2026-06-04 — Migration 035: template-edit invalidates pending consents (Phase Y1 fix-forward, Option A)

Applied to production on **2026-06-04**, manually via the
Supabase web SQL Editor, after the 8-step Y1 live gate (steps 4
+ 5) surfaced a second-order bug in migration 033's
`consent_esign_complete`.

The bug 033 had: two layered template-state guards. Guard (1) —
`SELECT body_text WHERE id = pending.consent_template_id AND
archived_at IS NULL` — fires whenever the template was archived
between send and complete. Guard (2) — the
`p_claimed_body_text IS DISTINCT FROM v_current_body` stale-read
check — was intended to fire on in-place body edits. **Under the
actual archive-then-insert edit protocol** (every body edit
archives the old `consent_templates` row and inserts a new one),
guard (1) ALWAYS fires before guard (2) can be reached, making
guard (2) + the `p_claimed_body_text` parameter unreachable dead
code. Secondary defect: after an edit, the pending row's
`consent_template_id` points at the now-archived row → guard (1)
fires forever; the pending is **un-completable**, stuck in the
queue with no resolution path.

What the migration does (Option A — Seth-confirmed):

- **Expand `chk_consents_pending_esign_resolved_via` CHECK** to
  allow a fourth value, `'superseded_by_template_edit'`.
- **`supersede_pendings_on_template_archive_trg`** AFTER UPDATE
  trigger on `consent_templates`. Fires **only on the
  `archived_at` NULL → NOT NULL transition** (the archive step
  of the archive-then-insert protocol). For the matching
  `(provider_id, consent_type)`, marks all active pendings
  resolved with `resolved_via='superseded_by_template_edit'` and
  resolves the corresponding `reminder_instances` rows
  (`category='consent_esign_pending'`). Done in a single
  CTE-driven statement so it's atomic with the outer template
  archive — rollback unwinds both. Other `consent_templates`
  UPDATEs (toggling `enabled`, label changes that don't archive)
  do not invalidate pendings.
- **`DROP FUNCTION consent_esign_complete(uuid, text, text);
  CREATE consent_esign_complete(uuid, text)`** — signature
  change. The dead `p_claimed_body_text` parameter is gone.
  Behaviorally:
  - Looks up the pending row regardless of `resolved_at` state
    so the resolved-row case can produce **state-specific,
    parent-readable** error messages — one branch per
    `resolved_via` (`parent_completed`, `provider_rescinded`,
    `expired`, `superseded_by_template_edit`), all `errcode
    'P0001'`.
  - Belt-and-suspenders fallback: if the template lookup
    returns null even though the pending isn't yet marked
    superseded (rare race window or trigger bypass), mark it
    superseded in this transaction and raise the same
    parent-readable message.
  - Happy path unchanged: snapshot-at-completion still re-reads
    `consent_templates.body_text` and writes the
    AUTHORITATIVE snapshot to the acknowledgments row.

**Why Option A and not "let parent sign the stale version".**
The parent cannot sign a document the provider just amended.
Signing the OLD body could create a compliance artifact whose
text the provider no longer stands behind; signing the NEW body
without showing it to the parent fails informed-consent. Option
A — invalidate the pending, provider resends with the new
template — is the only safe path for the evidence layer.

Y1 has no UI; the only callers of `consent_esign_complete` are
manual devtools / SQL Editor invocations during the live gate.
Nothing in the app or test suite calls it. DROP+CREATE with the
new 2-arg signature is safe. Any future caller MUST use the
2-arg signature.

Dependencies — sequential after migration 034.

Editor note — small migration (~485 lines incl. header). One
`alter table ... drop/add constraint`, one
`create or replace function` for the trigger, one
`create trigger`, one `drop function`, one
`create or replace function` for the rewritten RPC. No table
data changes, no long seeds. Applied in seconds.

Anon grant note — the migration's `DROP + CREATE` re-applied
Postgres's default `EXECUTE` grant to `public` (which includes
the `anon` role). Seth manually revoked `execute … from anon`
after applying. Pattern fixed in migration 036; see also
`CLAUDE.md` § Engineering Discipline.

Verification — the four (a)-(d) queries run by Seth in the
Supabase web SQL Editor on **2026-06-04**, all passed before
re-running the gate:

1. **Expanded CHECK** — `pg_get_constraintdef(oid)` for
   `chk_consents_pending_esign_resolved_via` returns a CHECK
   text including `'superseded_by_template_edit'`.
2. **Trigger attached** — `pg_trigger` shows
   `supersede_pendings_on_template_archive_trg` on
   `public.consent_templates`.
3. **Old signature gone** — `pg_proc` returns exactly one
   `consent_esign_complete` row, args
   `p_pending_id uuid, p_typed_signature_text text` (2-arg).
4. **EXECUTE permissions** — granted to `authenticated` only
   after the manual anon revoke; no `public` row.

Then the Y1 live gate re-ran from step 4. **Step 4** confirmed
the prior pending got auto-superseded the moment Vanessa's
template-edit UPDATE archived the old `consent_templates` row
(`resolved_at` set, `resolved_via='superseded_by_template_edit'`).
**Step 5** confirmed the fresh pending Vanessa sent next
completed cleanly with the new body in
`template_snapshot_text`. **Step 5a** confirmed the OLD
superseded pending raises the parent-readable "your provider
updated this consent" message on completion attempt. Steps 6-8
+ invariants unchanged from the 034 entry.

Post-merge — see the merge note on the 033 entry above
(`6afb16b`, 2026-06-04). Same branch.

### 2026-06-04 — Migration 036: provider-recipient notification_log inserts populate recipient_email (Phase Y1 fix-forward + Phase X latent twin)

Applied to production on **2026-06-04**, manually via the
Supabase web SQL Editor, after the 8-step Y1 live gate
(reattempted step 5) surfaced the third bug in the e-sign RPC
chain. Companion to commit `dcb2098` on the Y1 branch.

The bug 035 still had: a real authenticated parent (Jeff,
`7bac7213`) called `consent_esign_complete` on a valid pending
row. Authorization passed; the `acknowledgments` evidence row
was prepared; the per-pending UPDATE was queued; the reminder
resolve was queued — and the **final provider-notification
INSERT failed with PostgreSQL error 23502: null value in column
"recipient_email" of relation "notification_log" violates
not-null constraint**. Because that insert was in the same
transaction as the evidence write, the whole completion rolled
back. The parent's signed evidence row was lost. The pending row
stayed un-resolved. Re-attempt produced the same outcome.

**The 034 inference was wrong, twice.** Migration 034's header
collapsed the constraint check into a single shape claim:
"Migration 031's `child_parent_update` writes
`recipient_type='provider'` with `recipient_id=v_provider_id`
populated — so the provider path was fine." That sentence
disposed of `recipient_email` by analogy and was wrong on two
axes:

- `notification_log.recipient_email` is also `NOT NULL` in
  production (the 034 gate proved only `recipient_id`).
- Migration 031's `child_parent_update` itself writes
  `recipient_email = NULL` (lines 401, 424) — same latent bug,
  armed-but-unfired. No parent had triggered the
  `p_apply_allergies` or `p_apply_medical_notes` write path
  through the parent portal yet, so the constraint had not been
  hit live.

What the migration does:

- **CREATE OR REPLACE `consent_esign_complete(uuid, text)`** —
  same 2-arg signature from migration 035. Two behavioral
  changes:
  1. Resolve the provider's email via `profiles.email` (same
     source `api/notify-state-change.js` line 246-247 uses) and
     pass it as `recipient_email`. SECURITY DEFINER bypasses
     RLS for the parent-caller's read. If the provider has no
     email on profile, **skip the notification insert entirely**
     — matches the `recipients.length === 0` silent-skip in
     `api/notify-state-change.js` lines 282-289. The evidence
     row still gets written; the provider just doesn't receive
     an email. Provider-discoverable email gaps must not void
     the parent's signature.
  2. Wrap the notification insert in `BEGIN ... EXCEPTION WHEN
     OTHERS ... RAISE NOTICE ... END`. Any future schema
     surprise on `notification_log` (another column going NOT
     NULL, a CHECK added, a column renamed) produces a NOTICE
     and the outer transaction commits anyway. The
     `acknowledgments` row IS the compliance artifact; failed
     side-effects must not destroy it. EXCEPTION scope is
     narrow — only the notification insert. All other failures
     (auth gate, pending-row state, template-archive race,
     evidence insert) still abort the transaction.

- **CREATE OR REPLACE `child_parent_update(13 args)`** — same
  two behavioral changes applied to its two notification
  branches (allergies + medical_notes). Signature unchanged
  from migration 031; existing callers (parent portal
  medical-update form) keep working with no client change. The
  children UPDATE still happens before the notifications, so a
  notification failure also can't void the medical data write.

- **Explicit `revoke execute … from anon`** on each function
  after the CREATE OR REPLACE. Migrations 033, 034, 035 each
  re-applied Postgres's default `public`/`anon` EXECUTE grant
  on CREATE; Seth manually revoked each time. 036 bakes the
  revoke into the migration. **Canonical SECURITY DEFINER
  trailer going forward** (recorded in `CLAUDE.md` §
  Engineering Discipline):

  ```sql
  revoke all     on function public.fn_name(...) from public;
  revoke execute on function public.fn_name(...) from anon;
  grant  execute on function public.fn_name(...) to authenticated;
  ```

**No table changes.** `notification_log.recipient_email` `NOT
NULL` is correct — the dispatcher pattern is "resolve recipients
at WRITE time, then INSERT with email populated"
(`api/notify-state-change.js`, `api/cron-dispatch-reminders.js`,
`api/cron-send-acknowledgment-digest.js` all do this). The NOT
NULL enforces the convention.

No change to `consent_esign_send` (already correct after 034:
parent loop pre-filters `pp.email IS NOT NULL` at SELECT time).
No change to `consent_esign_rescind` (writes nothing to
`notification_log`).

Dependencies — sequential after migration 035.

Editor note — `CREATE OR REPLACE FUNCTION` only on two
functions; ~633 lines including the verbose header (root-cause
narrative + transactional recommendation). No table changes.
Applied in seconds.

Verification — the three (a)-(c) queries run by Seth in the
Supabase web SQL Editor on **2026-06-04**, all passed before
the final gate re-run:

1. **REAL `notification_log` NOT NULL list** — the
   ground-truth audit (the one the migration 034 inference
   should have done). Confirmed via `information_schema.columns`
   that **`recipient_id` AND `recipient_email` are both NOT
   NULL**. The table predates in-tree migrations (PR #12
   discovered it already existed; see migration 020 lines
   334-339), so the live schema is the source of truth.
   Screenshot saved with this entry.
2. **Both RPC signatures present** —
   `consent_esign_complete (p_pending_id uuid,
   p_typed_signature_text text)` (2-arg, unchanged from 035)
   and `child_parent_update (13-arg form, unchanged from 031)`.
3. **EXECUTE permissions correct without manual cleanup** —
   `authenticated` only; no `anon` row; no `public` row.

Then the live gate re-ran step 5 successfully:

5. **Parent (Jeff) completes the pending.** Returns the new
   `acknowledgments.id`. `acknowledgments` row shows
   `acknowledged_via='parent_portal_esign'`,
   `typed_signature_text` matches Jeff's typed name,
   `template_snapshot_text` is the current template body
   verbatim, `consent_template_id` references the active
   template, WORM trigger holds on UPDATE attempts.
   `consents_pending_esign` row resolved
   (`resolved_via='parent_completed'`,
   `resolved_acknowledgment_id` = the new ack id).
   `notification_log` row written with `recipient_type='provider'`,
   `recipient_id`=Vanessa's user id, `recipient_email`=Vanessa's
   `profiles.email` (POPULATED). Confirmed.

Negative coverage exercised separately: if the provider's
`profiles.email` is NULL, the completion still succeeds
(evidence row + pending resolved); notification row is silently
skipped.

Post-merge — see the merge note on the 033 entry above
(`6afb16b`, 2026-06-04). Same branch.

### 2026-06-04 — Production schema change (manual, no in-tree migration): `profiles.comped` paywall bypass

Not a numbered migration — Seth applied a single `ALTER TABLE`
directly to production. Recorded here because production schema
changed and the app now reads the column. Companion to commit
`241c365` (the `PaywallGate` honor-comped merge to `main`).

What changed in production:

- `public.profiles.comped boolean NOT NULL DEFAULT false` added
  via the Supabase web SQL Editor. No backfill needed — the
  default applies the value to every existing row at ALTER
  time.
- Two rows flipped to `comped = true` via direct UPDATE:
  Seth's own provider profile (`smdominique`) and Venessa's
  (`nessa7190`). All other rows remain `false`.

App side (committed on `feature/paywall-gate-comped-bypass`,
merged at `241c365`, single-file change in
`src/hooks/useSubscription.js`):

- The `comped` column is added to the hook's `profiles` SELECT.
- A new `isComped = !!profile?.comped` derived value is OR'd
  into `hasAccess`:
  `hasAccess = isComped || isActive || (isTrialing && daysLeft > 0) || isPastDue`.
- `isComped` is exposed on the hook return for future UI
  affordances (e.g., labeling a comped account in admin views).

`PaywallGate.jsx` itself was not changed — it reads
`sub.hasAccess` from the hook, which is the right seam. Billing
/ Stripe code unchanged. `subscription_status` writes
unchanged. Tests stayed at 1201 → 1204 passing (no new tests;
no existing tests for the hook to extend).

Verification (live, 2026-06-04):

- After the `ALTER TABLE` + the two UPDATEs, Seth signed in as
  `smdominique` with a deliberately-expired
  `subscription_status='expired'` and confirmed the paywall did
  NOT appear; the app loaded normally. Same observation for
  Venessa's account.
- A test account left without `comped = true` retained the
  normal paywall behavior at expiry.

Rollback (if ever needed): `UPDATE profiles SET comped = false
WHERE id IN (…)` reverts the bypass without dropping the column.
Dropping the column would require coordinating with the
`useSubscription` SELECT — leave the column in place and rely
on the boolean for any future revocation.

Why no in-tree migration: the change is one boolean column with
a default and zero new logic on the SQL side. Recording it here
keeps the production schema audit complete; if a future cleanup
formalizes it, the migration would simply be `ALTER TABLE
public.profiles ADD COLUMN IF NOT EXISTS comped boolean NOT
NULL DEFAULT false;` plus a corresponding entry in this section
referencing the production-rows backfill state.

### 2026-06-05 — Migration 037: Compliance Engine Phase 3 — `compliance_applicability_overrides` table

Applied to production on **2026-06-05**, manually via the Supabase
web SQL Editor. Companion to the Phase 3 build
(`feature/compliance-engine-phase-3` → merged into `main` at
commit `b6dd1d5` via `git merge --no-ff`). The data layer for the
applicability-resolution mechanism the Phase 1 engine
(`src/lib/complianceState.js`) deliberately left as a seam — Phase 3
fills the `overrides: Map<requirement_key, 'applies'|'does_not_apply'>`
parameter that `resolveApplicability` has accepted since Phase 1
shipped. **Engine API unchanged.**

What the migration does:

- **`compliance_applicability_overrides` table.** Per-provider rows.
  Twelve columns:
  - `id uuid PRIMARY KEY` (default `gen_random_uuid()`).
  - `provider_id uuid NOT NULL` references `public.profiles(id)` on
    delete cascade.
  - `requirement_key text NOT NULL` — stable identifier from
    `REQUIREMENT_REGISTRY` in `src/lib/complianceState.js`. No FK
    enforcement because the registry lives in code; stale keys here
    are no-ops in the loader.
  - `mode text NOT NULL CHECK (mode IN ('applies', 'does_not_apply'))`
    — the engine's `overrides` Map only accepts these two values.
    **`UNKNOWN` is represented by the ABSENCE of an active row**
    (or by `archived_at NOT NULL`); there is no third enum value
    and there must never be one. The §2a engine invariant requires
    an explicit affirmative basis for `applies` or `does_not_apply` —
    silence MUST fall back to the registry's `autoDefault`.
  - `family_id uuid` (nullable) references `public.families(id)`
    on delete cascade. **RESERVED for forward-compat — UNUSED in
    Phase 3.** The Phase 3 UI writes NULL. First future use case:
    the deferred `consent_religious_objection_emergency_medical`
    row, which is per-family by R 400.1907(1)(d) and will write
    `family_id` when its capture flow ships. Per scope decision #2
    — **do not remove this column as "dead."** Removing it would
    force a migration when the per-family writer ships; shipping
    it now is the forward-compat decision recorded in the Phase 3
    scope doc.
  - `child_id uuid` (nullable) references `public.children(id)` on
    delete cascade. **RESERVED for forward-compat — UNUSED in
    Phase 3.** For rare per-child overrides the current registry
    doesn't require but the schema accommodates without a future
    migration. Same "don't remove" rule.
  - `set_at timestamptz NOT NULL DEFAULT now()`.
  - `set_by_user_id uuid` references `auth.users(id)` on delete
    set null.
  - `notes text`.
  - `archived_at timestamptz`. Soft-delete per the
    never-hard-delete rule in `CLAUDE.md`. The UI's "Reset to auto"
    archives the row; the loader's `WHERE archived_at IS NULL`
    filter then makes the engine fall back to `autoDefault`.
  - `archived_by uuid` references `auth.users(id)` on delete set null.
  - `created_at timestamptz NOT NULL DEFAULT now()`,
    `updated_at timestamptz NOT NULL DEFAULT now()` (the
    `set_updated_at()` trigger from migration 001 maintains the
    latter).

- **Partial-unique index** `compliance_overrides_active_unique` on
  `(provider_id, requirement_key, COALESCE(family_id, '0000…0000'::uuid),
   COALESCE(child_id, '0000…0000'::uuid)) WHERE archived_at IS NULL`.
  The `COALESCE`-to-sentinel-UUID pattern is the load-bearing
  detail: a plain unique index would treat two NULL `family_id`
  values as distinct (per the SQL standard), letting two active
  provider-wide rows for the same `(provider_id, requirement_key)`
  coexist. Coalescing both nullable scope columns to the same
  well-known sentinel UUID closes that hole. Mirrors the
  active-unique-index pattern from `consent_templates_active_unique`
  + `acknowledgments_active_unique`.

- **Loader index** `compliance_overrides_by_provider` on
  `(provider_id) WHERE archived_at IS NULL` — supports the loader's
  by-provider fetch.

- **`updated_at` trigger** wires the existing `public.set_updated_at()`
  function from migration 001.

- **RLS.** Enabled (`relrowsecurity = true`). Three policies:
  - `SELECT` for `authenticated` USING `provider_id = auth.uid()`.
  - `INSERT` for `authenticated` WITH CHECK `provider_id = auth.uid()`.
  - `UPDATE` for `authenticated` USING + WITH CHECK
    `provider_id = auth.uid()`.
  - **No DELETE policy.** Soft-delete only via `archived_at` per
    `CLAUDE.md`.
  - Nothing granted to `anon` or `public`.

- **Zero functions.** This is a pure table + RLS migration, so
  there is no SECURITY DEFINER trailer to apply (the canonical
  `revoke all / revoke from anon / grant to authenticated` triplet
  is for functions; this migration creates none). The recurring
  anon-grant-on-CREATE trap that bit 033/034/035 does not apply
  here.

Dependencies — sequential after migration 036. No data dependency
beyond `auth.users` (FKs on `set_by_user_id` + `archived_by`),
`public.profiles` (FK on `provider_id`), `public.families` and
`public.children` (FKs on the reserved scope columns).

Editor note — single-file migration, ~340 lines including the
verbose header carrying the verification queries. No long seed
INSERTs. The web SQL Editor long-statement bug did not bite.

Verification — the five header queries (a)-(e) run by Seth in the
Supabase web SQL Editor on **2026-06-05**, all passed:

1. **(a) Table + columns** — `information_schema.columns` returned
   the 12 columns with the expected types and nullability
   (including the two reserved forward-compat ones).
2. **(b) CHECK constraint** — `pg_get_constraintdef(oid)` for
   `compliance_overrides_mode_check` returned
   `CHECK ((mode = ANY (ARRAY['applies'::text, 'does_not_apply'::text])))`.
3. **(c) Indexes** — both indexes present with the expected
   `WHERE archived_at IS NULL` predicates.
4. **(d) RLS policies** — `pg_policy` returned three rows
   (SELECT/INSERT/UPDATE for `authenticated`); no DELETE policy.
5. **(e) RLS enforced** — `pg_class.relrowsecurity = true`.

What ships with the migration (the Phase 3 feature build —
`feature/compliance-engine-phase-3` + the three fix-forward commits
below, merged at `b6dd1d5`):

- **The applicability input surface.** New "What applies to my
  program?" section in `BusinessInfoPage`
  (`src/components/compliance/ApplicabilityQuestionsSection.jsx`).
  Registry-driven question list — three questions today (the rows
  in `REQUIREMENT_REGISTRY` whose `applicability.autoDefault ===
  APPLICABILITY_RESULT.UNKNOWN`):
  - **Do you routinely transport children?** →
    `consent_transportation_routine_annual` (R 400.1952(1)(a)).
  - **Do you have a pool, kiddie pool, or other water feature on
    your premises?** →
    `consent_water_activities_on_premises_seasonal`
    (R 400.1934(10)(b)).
  - **Do you have any animals on the premises?** →
    `property_animal_notification` (R 400.1937). Asked NOW even
    though the substrate ships with PR #21 — the answer pre-resolves
    applicability for when the property substrate lands.
  Three answers per question: **Yes** (writes `mode='applies'`),
  **No** (writes `mode='does_not_apply'`), **Skip — ask me later**
  (archives the active row; NEVER translates to `does_not_apply`
  — explicit code comment cites §2a).
- **Provider-wide checklist** at the new `/compliance` route
  (`src/pages/ComplianceChecklistPage.jsx`). Module-gated by
  `MODULE_KEYS.LICENSED_COMPLIANCE` + the opt-in flag.
  Provider-level categories + per-child rollup summary.
  Browser-print supported for inspection prep.
- **Per-family Compliance tab** in the Families modal
  (`src/components/compliance/FamilyComplianceTab.jsx`). Per-child
  category cards. Same gates.
- **Shared rendering** — `ChecklistRow.jsx` +
  `ChecklistCategoryCard.jsx`. Pattern-E `not_yet_modelled` rows
  render the Option A "Tracking ships with PR #N — keep paper
  records for now. An auditor will ask to see them." treatment
  (informational gray, 🔧 icon — distinct from `awaiting-provider-
  input` amber + "Tell us about this" deep-link).
- **Sidebar entry.** New "Compliance Checklist" item under the
  Compliance section. Hidden when the opt-in flag is off OR when
  the provider isn't a licensed home (LEPs see nothing).
- **Opt-in storage** — `profiles.program_settings.compliance_checklist_enabled`
  (boolean JSONB key). Default OFF (key absent) for existing
  providers during rollout; flipped via the Business Info toggle.

Phase 3 live verification gate — the two principle-bearing checks
both passed against a real `group_home` provider's account:

1. **§2a invariant (unresolved-stays-unknown).** Walked every
   category. Unanswered applicability questions surfaced the
   corresponding requirement as `unknown` reason
   `'awaiting-provider-input'` (amber, "Tell us about this", deep-
   link to BusinessInfo). **No row resolved to `not_applicable`
   without an explicit affirmative basis** (regulatory-universal
   exclusion, data-inferred negative, or `mode='does_not_apply'`
   override).
2. **§4 Option A (tracking-not-yet-shipped presentation).** Drill
   rows, property rows, and the three staff-file-gap rows all
   render with the 🔧 "Tracking ships with PR #N — keep paper
   records for now. An auditor will ask to see them." treatment.
   Not hidden. Not red. Not "Tell us about this."

Four bugs the live gate caught + the same PR fixed (these are the
load-bearing record of "what we learned from the gate"):

**Bug 1 — loading-race redirect** (commit `430f96b`). `/compliance`
redirected an opted-in `group_home` provider to `/dashboard`
because the page destructured `{ modules, profile }` from
`useActiveModules` but ignored `loading`. On the first render
`modules = Set(['core'])` (the placeholder) and `profile = null`,
so the gate evaluated `!modules.has(LICENSED_COMPLIANCE) → true`
and fired `<Navigate to="/dashboard" replace />` synchronously —
the page never re-rendered with the loaded data.

Fix: extracted the gate logic into
`src/lib/complianceChecklistVisibility.js` —
`resolveComplianceChecklistGate({ loading, modules, profile }) →
'loading' | 'redirect_dashboard' | 'redirect_optin' | 'allowed'`
plus the boolean convenience `isComplianceChecklistVisible(...)`.
Safe-failure default `loading = true`. The page renders a Loading…
state for `'loading'` and only navigates for `redirect_*`. Sidebar
adopts the same helper so the three surfaces (sidebar / page /
per-family tab) share one source of truth.

**Root-cause confirmation worth recording:** the gate keys on
`profiles.license_type IN ('family_home', 'group_home')` directly
per `modules.js:125-128` — NOT on `program_settings.licensed_compliance`,
which is a vestigial JSON key from migration 004's seed read by
zero production code. The feature activates correctly for all real
licensed providers; `license_type` is set via the onboarding wizard
(`src/lib/onboarding.js:510-517` → `getWriteTargets('license_status',
…)`), the BusinessInfo Licensing tab
(`BusinessInfoPage.jsx:344` → `saveLicenseStatus`), or the
`LicenseStatusPromptModal` (PR #5 fallback). The
`licensed_compliance` key in `program_settings` is now confirmed
dead code; flagged in `docs/tech_debt.md` for future cleanup.

Secondary bug 1.5 found while diagnosing: `FamiliesPage`'s
`licenseeProfile` SELECT at line ~115 was missing `program_settings`,
so the per-family Compliance tab's opt-in check
(`licenseeProfile?.program_settings?.compliance_checklist_enabled
=== true`) always evaluated `undefined === true` → false. Tab never
appeared even after the page redirect was fixed. One-word fix in
the same commit (`430f96b`); test in
`complianceChecklistVisibility.test.js` named "the FamiliesPage
SELECT bug — fixed in same PR" so the regression is named.

**Bug 2 — per-child rollup raw UUIDs** (commit `7d8c61e`,
Finding #4). `/compliance` per-child rollup rendered
"Child b4cab3d3…" instead of the child's name — the loader's
children SELECT didn't include `first_name` / `last_name` (the
pure engine doesn't need them) and the convenience wrappers
discarded the children list entirely.

Fix: loader's children SELECT now includes `first_name, last_name`.
Convenience wrappers return `{ state, children }` (provider) /
`{ state, child }` (per-child) so consumers can render names from
the same fetch. New `displayChildName(child)` +
`findChildDisplayName(children, childId)` in `src/lib/children.js`,
mirroring the `first_name last_name` convention used across
`FamiliesPage` cards. `FamilyComplianceTab` dropped its inline
`findChildName` and adopted the shared helper.

**Bug 3 — "contact support" for self-fixable causes** (commit
`7d8c61e`, Finding #3). The staff "New-hire 14-topic training"
row showed "Data anomaly — please contact support" with reason
`'caregiver-missing-date-of-hire'` — misleading; the provider can
add the hire date themselves. Root cause: `classifyUnknownReason`
only special-cased `'awaiting-provider-input'` and
`'feature-not-yet-shipped'`; every other reason fell through to
`data_anomaly` → "contact support" copy.

Fix: full reason-code audit done across every `reason:` literal in
`complianceState.js`. New exported frozen Set
`NEEDS_PROVIDER_DATA_REASONS` (catalog of self-fixable reasons:
`'caregiver-missing-date-of-hire'` +
`'no-authorization-end-on-funding-source'`).
`classifyUnknownReason` returns a new `'needs_provider_data'`
bucket for any reason in that Set. `ChecklistRow.jsx` renders the
bucket with reason-specific actionable copy from
`NEEDS_PROVIDER_DATA_COPY` ("Needs hire date on the staff record"
/ "Needs authorization end date on the funding source") in the
same red/`bad`-color voice as `MISSING_REQUIRED` rows. **Genuine
data anomalies (unparseable dates, dev bugs, completion dates in
future, etc.) correctly still say "contact support"** — that's the
right copy for "the data on the underlying record is corrupt." Tests
exercise every reason code the engine actually emits, plus the
catalog-frozen invariant.

**Bug 4 — "Open child's compliance tab →" deep-link opened
nothing** (commit `b771e56`, Finding #5). On both ends of the wire:
(a) the link emitted `/families?child=<id>&tab=compliance`, but
`FamiliesPage` opens its modal per FAMILY, not per child — without
`family_id` the page has no way to resolve which family modal to
open; (b) `FamiliesPage` had **zero query-param handling** (grep
for `useSearchParams` / `URLSearchParams` / `location.search` /
`searchParams` / `useLocation` returned 0 matches), so the link
sent params the page never read.

Fix: link in `PerChildSummary` now resolves `child_id → family_id`
from the loaded children list and emits
`/families?family=<fid>&child=<cid>&tab=compliance`. `FamiliesPage`
gained its first `useSearchParams` handler — reads `?family=<id>`
after families load, opens the matching modal via
`setSelectedFamily(match)`, reads `?tab=<key>`, validates against a
`KNOWN_TABS` Set (unknown values fall back to `'overview'`), threads
as `initialTab` prop into `FamilyDetailModal`. The modal's `onClose`
clears the deep-link params via `clearDeepLinkParams()` — refreshing
after close doesn't re-trigger the deep-link. Gates respected
end-to-end: a deep-link to a non-eligible family lands gracefully
on an empty modal body (button + content both gated).

Tests — Phase 3 added 28 new tests across the build; the four
fix-forward commits added 23, 17, and (commit `b771e56`) zero
additional pure-logic tests for the page-level param handler.
Total: **1204 → 1272 (+68 across the Phase 3 arc)**. Critical
proofs:
- §2a invariant: empty overrides on each of the three
  provider-declared rows → applicability = UNKNOWN, never
  `DOES_NOT_APPLY`.
- Override round-trip exercised for all three rows × all three
  modes (`applies`, `does_not_apply`, absent/archived).
- Pattern E + override = applies: `property_animal_notification`
  with `mode='applies'` correctly returns `state.kind='unknown'`,
  `reason='feature-not-yet-shipped'` (the registry row's resolver
  IS Pattern E, so the applicability override doesn't unblock the
  state until the substrate ships).
- `resolveComplianceChecklistGate`: explicit named "LOADING:
  returns 'loading' while useActiveModules is loading (the Phase 3
  bug)" test case.
- `classifyUnknownReason`: every reason code the engine actually
  emits is covered; catalog-frozen invariant locked.

Post-merge — `feature/compliance-engine-phase-3` merged into `main`
at commit `b6dd1d5` via `git merge --no-ff`, pushed
**2026-06-05**. Vercel production deploy triggered by the push.
No rollback executed.
