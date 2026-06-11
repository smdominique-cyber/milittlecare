# PR Scope — Consent Attachments: Scanned Paper Forms

**Date:** 2026-06-02
**Status:** Scope — **FINAL, ready for build** (both watch-items —
decision 3 Edge Function auth check and decision 6 consent-link
shape — resolve cleanly; see §"DECISIONS — RESOLVED" and §8 for the
locked details).
**Branch (suggested):** `feature/consent-attachments`
**Builds on:** the canonical compliance-document pattern from
migration 008 + `src/lib/fundingDocuments.js` +
`src/components/funding/FundingDocumentSlot.jsx` (existing, shipped
and exercised); the polymorphic acknowledgments engine from
migration 024 (existing, shipped); PR #20's
`medication_authorizations` table and its parent-permission ack
types in `acknowledgments` (shipped 2026-06-02). The
`children → families → parent_family_links` join path that this
feature's privacy boundary depends on is the same path migration
024's parent-side SELECT policy on `acknowledgments` already uses.

---

## Summary

Let a provider attach a scanned/photographed copy of a signed paper
consent form to a consent record across every consent surface (R
400.1907 intake bundle items; Phase A `field_trip_permission` and
`photo_sharing_consent`; Phase B routine transport + on-premises
water; Phase C non-routine transport + off-premises water; PR #20
medication permission + OTC-blanket). The provider sees their own
scans directly via storage-bucket RLS (owner-only — first path
segment is `auth.uid()`). **Parents see scans for their own
children's consents and only those** — read goes through a new
server-side Edge Function (service-role) that enforces the
`parent → parent_family_links → family → children → consent →
attachment` join in app code before minting a 15-minute signed URL.

The new schema is one table + one bucket. The acknowledgments and
medication tables are untouched (purely additive). The
parent-side privacy boundary lives in the Edge Function, NOT in
storage RLS — explicitly chosen so the storage policy stays the
same simple `auth.uid() = first-folder-segment` shape every other
bucket in this codebase uses.

What this scope does NOT do: build a retention-sweep cron (still
pending across all compliance buckets — see §13); reconcile the
`message-photos` bucket's untracked production schema (named §10);
consolidate the stranded `children.immunization_record_url` column
(named §10).

---

## DECISIONS — RESOLVED

Every choice this scope locks. Each is folded into the design body
below.

| # | Decision | Resolution |
|---|---|---|
| 1 | New table for attachment metadata | **`public.consent_attachments` join table.** Columns modeled on `funding_documents` (migration 008) — see §"The two assets" for the full sketch. Provider-gated RLS: `auth.uid() = provider_id`. SELECT/INSERT/UPDATE only; NO DELETE policy (soft-delete via `archived_at` — CLAUDE.md never-hard-delete rule). |
| 2 | New private storage bucket | **`consent-attachments`** (private). RLS template identical to migrations 002/008: INSERT/SELECT/DELETE (no UPDATE — objects immutable), gated by `auth.uid()::text = (storage.foldername(name))[1]`. **Owner-only at the storage level** — parent read is solved by the Edge Function (decision 3), not by a cross-table-join storage policy. |
| 3 | Parent read mechanism (THE PRIVACY BOUNDARY) | **A new server-side Edge Function** at `api/consent-attachment-url.js` (or similar). Service-role for DB queries. Verifies the JWT-derived parent identity → resolves the requested `attachment_id` to a child via the polymorphic target (§6) → checks `parent_family_links (parent_id=auth.uid(), family_id=child.family_id, status='active')`. Only on success mints a 15-minute signed URL (matches funding-docs TTL). Otherwise 403/404. **Storage RLS stays owner-only — the function is the cross-tenant boundary.** Provider read does NOT go through the function (provider's own auth.uid() matches the storage path; direct `createSignedUrl` works). See §8 for the explicit auth-check spec. |
| 4 | Upload / replace / remove flows | **Mirror `FundingDocumentSlot`**: atomic upload-then-insert with orphan cleanup on failed insert; soft-delete via `archived_at` (the storage object survives in the bucket per retention); shared file validation (10 MB cap, PDF/JPG/PNG/HEIC/HEIF allowlist). **No archive-then-insert single-active constraint** — multiple scans per consent are explicitly allowed (the funding-docs partial-unique was for one-doc-per-type; here a consent may have several signed-paper iterations or supplementary scans). |
| 5 | UI placement | **Hook into the three existing consent modals** — `ChildIntakeModal`, `EnrollmentConsentsModal`, `MedicationModal`. Per-consent "Attach signed form" affordance + a recent-N thumbnail/filename list of existing attachments with view + remove (soft-delete) actions. UI placement is a proposal (§12); the data model is the locked part. |
| 6 | Consent-link shape (THE STRUCTURAL ONE) | **Polymorphic target** — `target_type text NOT NULL` + `target_id uuid NOT NULL` with a CHECK constraint enumerating the allowed values: `'acknowledgment'` (FK semantic to `acknowledgments.id`) and `'medication_authorization'` (FK semantic to `medication_authorizations.id`). See §6 for the analysis — option (a) FK-to-acknowledgments-only would cover today's use case because every CONSENT in this codebase is an `acknowledgments` row, but polymorphic is chosen for forward-compat with future "attach medication-plan document" cases that target the authorization (not its ack). **Tradeoff explicitly named**: no DB-level FK integrity on polymorphic; the Edge Function and the insert path both validate the target exists. Names diverge from acknowledgments' own `(subject_type, subject_id)` deliberately to avoid the semantic-overloading bug — `target_*` reads as "the row this attachment targets," distinct from acknowledgments' `subject_*` which means "what the consent is about." |
| 7 | Retention | **Inherit funding-docs convention.** `retention_until date NOT NULL DEFAULT (current_date + interval '4 years')::date`. Soft-delete via `archived_at`. Storage object survives the archive. **No retention-sweep cron** ships with this feature — same gap funding-docs has. Named §13; not a blocker. |
| 8 | Migration number | **`029_consent_attachments.sql`** — next free after 028 confirmed against files on disk. If another PR ships first, renumber sequentially. |
| 9 | Provider read path | **Direct via storage RLS** (no Edge Function on the provider side). The first folder segment of every object's path is the provider's auth.uid(); the existing storage SELECT policy lets them read their own. Provider modal calls `createSignedUrl` directly, same as `FundingDocumentSlot`. |
| 10 | Helper extraction | **Extract domain-agnostic parts of `src/lib/fundingDocuments.js` to a shared `src/lib/storage.js`** in this PR. The pure helpers — `validateFile`, `buildStoragePath`, `defaultRetentionUntil`, `getSignedUrl` — are bucket-agnostic; only the `BUCKET` constant differs. The funding-docs surface and this new surface both import from the shared module. This is a tiny refactor; the alternative (duplicate the helpers under a `consentAttachments.js` namespace) accumulates drift risk between the two callers' validation logic. |
| 11 | Path template | `<provider_user_id>/<target_id>/<uuid>.<ext>`. First segment satisfies the storage RLS; second segment makes per-consent listing trivial. Same shape as funding-docs' `<user_id>/<funding_source_id>/<uuid>.<ext>`. |

---

## The parent-read auth check (single canonical statement)

A parent's request to read `attachment_id` is authorized when, AND
ONLY WHEN, **the Edge Function — running with service-role — can
verify all of the following in app code, in this order**:

1. The request carries a valid Supabase Auth JWT; `auth.uid()` is
   resolved from it.
2. The attachment exists and is active:
   `SELECT target_type, target_id, storage_path
      FROM public.consent_attachments
     WHERE id = $attachment_id AND archived_at IS NULL`
   → if no row, **404 Not Found** (no leakage of whether it ever
   existed via a different status code).
3. The attachment's target resolves to a child via one of the two
   polymorphic paths (§6):
   - `target_type = 'acknowledgment'`:
     `SELECT subject_type, subject_id FROM acknowledgments WHERE id = target_id`.
     - If `subject_type = 'child'`: child_id = subject_id.
     - If `subject_type = 'medication_authorization'`:
       `SELECT child_id FROM medication_authorizations WHERE id = subject_id`.
     - **Any other `subject_type` value** (caregiver, family, provider,
       NULL, etc.) — these consents aren't child-scoped → **403
       Forbidden**. Mirrors migration 024's parent-side SELECT policy
       on `acknowledgments` which only grants parent access to
       `subject_type = 'child'`.
   - `target_type = 'medication_authorization'`:
     `SELECT child_id FROM medication_authorizations WHERE id = target_id`.
4. If the resolved `child_id` is NULL (e.g., the underlying row was
   archived or never existed) → **403 Forbidden**.
5. The parent has an active link to that child's family:
   `EXISTS (
      SELECT 1
        FROM parent_family_links pfl
        JOIN children c ON c.family_id = pfl.family_id
       WHERE pfl.parent_id = $auth_uid
         AND pfl.status = 'active'
         AND c.id = $resolved_child_id
   )`
   → if false, **403 Forbidden**. **This is the cross-tenant boundary
   — a parent requesting an attachment for a child they are not
   linked to MUST be denied.**
6. Only on full success: mint a 15-minute signed URL via
   `supabase.storage.from('consent-attachments').createSignedUrl(storage_path, 900)`.
   Return `{ signedUrl }`.

The function does **NOT** trust any client claim about parent
identity, family, or child. Every value is re-derived from
`auth.uid()` + `attachment_id`. The function MUST NOT accept
`storage_path` from the client (path-traversal / cross-tenant
leakage class).

---

## Why this is its own PR (and what's still deferred)

This is a substrate addition, not a domain-specific feature. The
five existing consent surfaces (intake, enrollment, per-occurrence,
medication, future) all want the same shape: "attach a signed
paper scan to this consent row." Shipping it as a substrate +
per-modal hooks avoids reinventing per-surface attachment logic
five times.

**Still deferred (named so they're not absorbed silently):**
- **Retention-sweep cron.** Across `funding_documents`,
  `consent_attachments`, and any future compliance-doc table. Same
  gap migration 008 named in 2026-05-13; this scope inherits it
  unchanged. See §13.
- **`message-photos` bucket schema capture.** Per `docs/tech_debt.md`
  line 89, the messages tables and the `message-photos` bucket exist
  in production but are not in tracked migrations. This feature
  does NOT touch that area — it deliberately doesn't piggyback on
  the messages bucket's (unknown-shape) parent-read RLS. The
  untracked-schema gap is acknowledged as separate cleanup work.
- **`children.immunization_record_url` cleanup.** The stranded text
  column from migration 024 (gather finding ⑤). Not consolidated
  here — different use case (intake's immunization record, not a
  per-consent scan). Flagged as separate cleanup; this feature
  does not extend it or remove it.
- **Provider mobile-camera capture flow.** This scope accepts file
  upload via the standard file-picker (same as `FundingDocumentSlot`).
  An optional "use camera" affordance for direct phone capture is a
  fast-follow UX improvement; the data model already supports it.
- **OCR / auto-extract of the signature panel.** Out of scope. The
  scan is opaque pixels to the app. Auditor verification is
  human-eyeball at the destination.

---

## The two assets in this PR — the consent_attachments table + the consent-attachments bucket

### Table — `public.consent_attachments`

Sketch (the migration writes the canonical SQL; this is the design
shape). Modeled on `funding_documents` (migration 008 lines 55-89);
columns match where the semantic carries over.

```
id                   uuid PRIMARY KEY default gen_random_uuid()
provider_id          uuid NOT NULL references auth.users(id) on delete cascade
                         -- The licensee who owns the consent + the scan.

-- Polymorphic target (decision 6).
target_type          text NOT NULL
                         CHECK (target_type IN
                           ('acknowledgment','medication_authorization'))
target_id            uuid NOT NULL
                         -- No DB-level FK (polymorphism). The insert
                         -- path + Edge Function validate the row
                         -- exists for the named type.

-- Storage pointer (same shape as funding_documents).
storage_path         text NOT NULL
original_filename    text NOT NULL
content_type         text NOT NULL
file_size_bytes      bigint NOT NULL CHECK (file_size_bytes > 0)

uploaded_at          timestamptz NOT NULL default now()
uploaded_by_user_id  uuid references auth.users(id) on delete set null
                         -- Separate from provider_id so a future
                         -- staff seat can upload without owning.

retention_until      date NOT NULL
                         default (current_date + interval '4 years')::date

archived_at          timestamptz
archived_by          uuid references auth.users(id) on delete set null
notes                text

created_at           timestamptz NOT NULL default now()
updated_at           timestamptz NOT NULL default now()
```

### Indexes (planning level — finalized in the migration)

- `(provider_id)` — owner-side reads.
- `(target_type, target_id) WHERE archived_at IS NULL` — hot-path
  per-consent attachment listing.
- `(retention_until) WHERE archived_at IS NOT NULL` — retention-sweep
  helper (same shape as funding-docs).
- **No partial-unique** — multiple active attachments per
  `(target_type, target_id)` are EXPECTED (a consent may have
  multiple scans: original + revised, or one per signing event).

### RLS — provider-scoped

Mirrors `funding_documents` policies verbatim with `provider_id` in
place of `user_id`:

- SELECT: `provider_id = auth.uid()`
- INSERT: `with check (provider_id = auth.uid())`
- UPDATE: `provider_id = auth.uid()` (used only for soft-delete via
  `archived_at`)
- **No DELETE policy.** Soft-delete only.

**No parent-side SELECT policy on this table.** Parents read scans
through the Edge Function exclusively (decision 3). Direct
PostgREST access from the parent client returns zero rows.

### Bucket — `consent-attachments`

```
insert into storage.buckets (id, name, public)
values ('consent-attachments', 'consent-attachments', false)
on conflict (id) do nothing;
```

Storage RLS policies (identical template to migrations 002/008):

- INSERT: `bucket_id = 'consent-attachments' AND auth.uid()::text = (storage.foldername(name))[1]`
- SELECT: same predicate
- DELETE: same predicate (used only for orphan cleanup; no UI path
  archives the storage object)
- **No UPDATE policy** — objects immutable.

**The storage policy is provider-only.** Parents do not match the
first-folder-segment predicate (parent's `auth.uid()` ≠ provider's
`auth.uid()`), so a parent's direct `createSignedUrl` against this
bucket returns an RLS denial. Parents go through the Edge Function
(decision 3), which uses service-role and therefore bypasses the
storage RLS — that's the whole point of the function.

---

## Classification note for the compliance score (PR #22)

Consent attachments are **evidence artifacts**, not compliance
state by themselves. Their presence STRENGTHENS the audit position
for a consent that's already in place (a scan corroborates the
captured ack row); their absence does NOT weaken a consent that's
properly captured via the parent-signed channel rule.

**Proposal for #22** (not locked here; flagged for #22's contract):
- A consent with a scan attached is "audit-evidence-attached" — a
  positive secondary signal.
- A consent WITHOUT a scan is NOT a compliance gap — the
  acknowledgment record is the primary signal.
- The MOST useful #22 signal is probably: "consents marked
  parent_signed via `provider_override` that lack a scan" — those
  are the audit-fragile rows where a scan would strengthen the
  attestation.
- This feature provides the data; #22 picks the weighting.

---

## §6. The consent-link shape — polymorphic target

### Locked (decision 6): polymorphic `(target_type, target_id)`

```
target_type text NOT NULL CHECK (target_type IN
  ('acknowledgment','medication_authorization'))
target_id   uuid NOT NULL
```

`target_type='acknowledgment'`: `target_id` is `acknowledgments.id`.
Covers every CONSENT in the system today — intake bundle items,
enrollment consents (Phase A), time-bound consents (Phase B),
per-occurrence consents (Phase C), and medication parent
permission (PR #20's `medication_permission` and
`medication_permission_otc_blanket` ACK_TYPES).

`target_type='medication_authorization'`: `target_id` is
`medication_authorizations.id`. Reserved for the future case where
the scan is OF the medication plan itself (e.g., a photo of the
prescription bottle's label per R 400.1931(4)) rather than of a
signed consent form. **Not exercised by any v1 UI; the
authorization column shape is in place so a future feature
doesn't need a migration to wire it.**

### The honest tradeoff — and why we're not going with option (a)

Option (a) was: `target_id uuid NOT NULL REFERENCES acknowledgments(id) ON DELETE RESTRICT`. Strict FK; type-safe at the DB.

Option (a) IS sufficient for the v1 feature. The gather observation holds: every CONSENT in this codebase is an `acknowledgments` row. The medication permission rows are in `acknowledgments` (via the two ACK_TYPES from PR #16's catalog). The `medication_authorizations` table is the medication PLAN, not the consent — so attaching a scan to "the medication consent" means attaching to the ack row, which option (a) handles.

The reason to go polymorphic anyway:
1. **Future medication-plan documentation.** R 400.1931(4) requires the prescription label to show physician name, child name, instructions, name+strength. A future feature might want to attach a scanned/photographed label image to the `medication_authorizations` row itself (not to the consent). Polymorphism reserves that capability without a future migration.
2. **Consistency with the consent system's existing polymorphism.** The acknowledgments table is itself polymorphic (`subject_type`, `subject_id`). Following the same pattern at the attachment layer keeps the consent substrate uniform.

### The cost — and what mitigates it

- **No DB-level FK integrity** on the polymorphic reference. A row could be inserted with `target_type='medication_authorization', target_id='<random uuid>'` and the DB wouldn't reject it.
- **Mitigation 1:** the INSERT path goes through a helper (in `src/lib/consentAttachments.js`, new) that validates the target row exists before inserting. Same defensive pattern Phase C's `buildOccurrenceMetadata` uses.
- **Mitigation 2:** the Edge Function (decision 3) re-validates the target on every read by following the resolution paths in §"parent-read auth check" step 3. An orphan attachment (target row deleted somehow) resolves to a NULL child_id → 403.
- **Mitigation 3:** the medication tables use `ON DELETE RESTRICT` for their foreign keys (per migration 028), and acknowledgments use soft-delete via `archived_at` (per migration 024). Hard-delete of a target row is not a normal user action — both consent stores effectively never lose rows.

### Naming — why `target_*` and not `subject_*`

The user's prompt suggested mirroring acknowledgments' `(subject_type, subject_id)`. Locked-in naming is `(target_type, target_id)` instead, because:

- In `acknowledgments`, `subject_type='child'` / `subject_id=<child.id>` means "this consent is ABOUT this child." Subject = the entity the consent CONCERNS.
- For attachments, the analogous shape `subject_type='acknowledgment'` / `subject_id=<ack.id>` would mean "this attachment is about this ack row" — but the same naming is confusing because it overlaps with acknowledgments' own column NAMES that mean a different thing (the child the ack is about, not the ack itself).
- `target_type='acknowledgment'` / `target_id=<ack.id>` reads unambiguously as "the row this attachment points at." No overlap with `acknowledgments.subject_*`.

This is a small naming divergence from the prompt's framing; the SHAPE (polymorphic discriminator + uuid) is exactly as the prompt described.

---

## §7. Storage RLS — owner-only at the bucket; parent read via Edge Function

The bucket's own RLS template is the same template every other
bucket in this codebase uses (receipts mig 002; funding-documents
mig 008): the first folder segment of every object's path must
equal the uploader's `auth.uid()`. Concretely the path is
`<provider_user_id>/<target_id>/<uuid>.<ext>`.

**Providers** match this template trivially — their `auth.uid()` IS
the first folder segment of every object they own. They use
`supabase.storage.from('consent-attachments').createSignedUrl(path, ttl)`
directly from the client. Same shape as `getSignedFundingDocUrl`.

**Parents** do NOT match this template — their `auth.uid()` is the
parent's user id, not the provider's. So `createSignedUrl` from a
parent client returns an RLS-denial error.

This is intentional. Parents read via the Edge Function (decision
3), which runs with service-role and therefore bypasses storage
RLS. The function is the only path by which a parent's request
ever reaches the bucket.

### Why we chose this over cross-table-join storage RLS

Storage RLS policies CAN subquery `public.*` tables (Postgres
permits it). A more complex SELECT policy could express: "parent's
`auth.uid()` is linked via `parent_family_links → children →
acknowledgments → consent_attachments` to the object with this
path." Doable, but rejected because:

1. **Cost per object.** That subquery runs on every storage read.
   With multiple JOINs at the storage layer, every `createSignedUrl`
   pays the cost. The Edge Function pays the cost only when a
   parent actually requests an attachment.
2. **Auditable in one place.** The cross-tenant denial logic is
   reviewable in `api/consent-attachment-url.js` — a single file a
   human can read end-to-end. A storage policy with JOINs is harder
   to read, harder to test, and bypassing it (service-role) hides
   its enforcement from the function's surface.
3. **The `message-photos` precedent is production-only.** That bucket
   reportedly solves a similar parent-read problem in production,
   but its schema isn't tracked. Mimicking an unknown shape is
   higher risk than building from a clean template here.
4. **Future-flexibility.** The Edge Function can grow audit logging,
   rate limiting, fine-grained denial reasons (debug headers in
   dev), or anti-enumeration backoff without altering storage RLS.

---

## §8. The Edge Function — the privacy boundary

### File

`api/consent-attachment-url.js` (sibling to the existing
`api/scan-receipt.js`, `api/send-message-notification.js`, etc.).

### Request shape

`POST /api/consent-attachment-url`

Headers:
- `Authorization: Bearer <parent's Supabase JWT>`

Body (JSON):
```
{ "attachment_id": "<uuid>" }
```

### Response shape

On success (`200 OK`):
```
{ "signedUrl": "https://...", "expires_at": "2026-06-02T15:30:00Z" }
```

On denial:
- `404 Not Found` — attachment_id doesn't resolve to an active row.
  Same response shape used for "attachment doesn't exist" AND "you
  aren't authorized to learn that it exists" — no leak of which
  attachment ids are valid vs invalid via differential status codes.
- `403 Forbidden` — request is authenticated but the parent isn't
  linked to the target child's family. (Optional: collapse 403 →
  404 to harden against attachment-id enumeration; flag for the
  build to decide.)
- `401 Unauthorized` — no/invalid JWT.
- `400 Bad Request` — malformed body.

### Authorization algorithm (verbatim)

Spelled out in §"The parent-read auth check" above. The algorithm
runs server-side, with service-role for DB queries, and refuses
to fetch the signed URL until every check passes.

### What the function explicitly does NOT do

- Does not accept `storage_path` from the client. The client only
  knows `attachment_id`; the function looks up the path. Accepting
  client-supplied paths is a path-traversal / cross-tenant leakage
  class.
- Does not return `403` with the same body shape as `200`. Errors
  use a distinct error body so the client doesn't accidentally try
  to treat a denial as a success.
- Does not log the JWT contents. Standard secret-hygiene.
- Does not call `loadAll()` on the parent's family-tree refresh
  path (lesson from PR #20 fix-forward). The function is read-only
  for the parent; nothing about a read should trigger a parent-side
  refresh cascade.

### Provider side — no Edge Function needed

The provider client gets signed URLs directly via
`supabase.storage.from('consent-attachments').createSignedUrl(...)`.
The storage RLS template (`auth.uid() = first-folder-segment`)
gates this naturally. The Edge Function is exclusively for
parents.

---

## §9. Upload / replace / remove flows

Mirror `FundingDocumentSlot` exactly. The pure helpers from
`src/lib/fundingDocuments.js` extract to `src/lib/storage.js`
(decision 10) and both surfaces import from there.

### Upload

1. `validateFile(file)` — shared helper, rejects > 10 MB,
   non-allowlist MIME/extension, empty files. Word docs rejected
   with "export to PDF" guidance (per the existing pattern).
2. `path = buildStoragePath({ userId: providerId, targetId, file })`
   → `<provider_user_id>/<target_id>/<uuid>.<ext>`.
3. `supabase.storage.from('consent-attachments').upload(path, file, { contentType })`.
4. On upload success: `INSERT consent_attachments` row with
   `target_type`, `target_id`, `storage_path = path`,
   `original_filename = file.name`, `content_type`, `file_size_bytes`,
   `uploaded_by_user_id = providerId`, `retention_until = default`.
5. **Orphan cleanup on metadata-insert failure** (same pattern as
   `FundingDocumentSlot.jsx` lines 261-267):
   ```
   await supabase.storage.from('consent-attachments').remove([uploadedPath])
   ```
6. Refresh the per-consent attachment list in the modal.

### Replace

**Not exposed in v1.** Multiple attachments per consent are allowed
(decision 4 — no archive-then-insert single-active constraint),
so "replace" reduces to "add another scan + soft-delete the prior."
The UI exposes Upload + Remove only; "replace" is two clicks
instead of one. If a single-click replace becomes useful, it's a
fast-follow.

### Remove (soft-delete)

1. `UPDATE consent_attachments SET archived_at = now(), archived_by = auth.uid() WHERE id = $attachment_id`.
2. **The storage object is NOT removed.** It survives the
   `retention_until` window (same convention as funding-docs).
3. Refresh the per-consent attachment list.

### View

- **Provider side:** `getSignedConsentAttachmentUrl(storagePath)` —
  thin wrapper around `supabase.storage.from('consent-attachments').createSignedUrl(path, 15*60)`. 15-minute TTL matches funding-docs.
- **Parent side:** call the Edge Function (decision 3); use the
  returned signedUrl.

### File validation

Reuses the funding-docs allowlist verbatim — PDF, JPG, PNG, HEIC,
HEIF. Same 10 MB cap. Same MIME-or-extension fallback (iOS Safari
HEIC quirk). Same Word-doc rejection with PDF guidance.

---

## §10. Backward compatibility + does-not-foreclose

### Backward-compat invariant

**Every consent shipped before this PR is unaffected.**

- `acknowledgments` table: zero ALTER. No new column. The existing
  table accepts attachments by virtue of being the `target_type='acknowledgment'`
  branch in `consent_attachments`; no schema change required.
- `medication_authorizations` / `medication_administration_events`:
  zero ALTER.
- The Phase B `expires_at` column, Phase C `occurrence_metadata`
  column, the `acknowledgments_active_unique` partial unique index
  — all untouched. The new table sits beside them.
- All existing RLS policies on `acknowledgments` and the medication
  tables: untouched.

### Does-not-foreclose check

| Future possibility | Status under this scope |
|---|---|
| Attach a medication-plan photo (prescription bottle label) to a `medication_authorizations` row | Open — the `target_type='medication_authorization'` branch is reserved exactly for this. |
| Attach a scan to a non-consent entity (e.g., a child's photo for their profile) | Out of this feature's contract — would need a new `target_type` value or a separate table. |
| Build a retention-sweep cron | Same gap funding-docs has; this feature inherits, doesn't fix. The retention index is in place to support an eventual sweep. |
| Cross-tenant attachment sharing (one provider sharing scans with another) | Architecturally separate — not a parent-read concern; would need a different join path. Not foreclosed by this design. |
| Migrating off the Edge Function to a cross-table-join storage RLS later | Possible. The function logic becomes the policy SQL. Not foreclosed. |

### The `message-photos` bucket — explicitly not touched

The gather found the `message-photos` bucket already solves a
similar parent-read problem in production (parents read message
attachments tied to threads tied to their own children). The
bucket's schema isn't in tracked migrations (per
`docs/tech_debt.md`).

**This feature does NOT touch the messages bucket or its RLS.** The
chosen Edge Function path is independent — parents read consent
scans through `api/consent-attachment-url.js`, not through any
messages-side mechanism. The untracked-schema gap remains as
separate cleanup work; it doesn't block this feature, and this
feature's design doesn't extend the gap.

### The stranded `children.immunization_record_url` column — explicitly not consolidated

Migration 024 added `children.immunization_record_url text` as a
forward-looking URL pointer to a stored immunization record. The
gather confirmed no `src/` code references it.

**This feature does NOT consolidate that column** into the new
attachments mechanism. Different use case (intake's immunization
record is per-child profile data, not per-consent evidence), and
mixing them would force a design that handles both — over-fitting
the scope. Flagged as separate cleanup: either wire the column to
the new attachments table at a later date (replacing it with a
join to `consent_attachments WHERE target_type='child'`, which
would require expanding the CHECK), or remove the column as dead
schema.

---

## §11. Migration sketch (NOT SQL)

A planning sketch only. The migration is written in the build PR.

### File

`supabase/migrations/029_consent_attachments.sql` — next free
sequential after 028 (confirmed against files on disk). Renumber
if any other PR ships first.

### Contents at a high level

1. **Header comment** in migration 024 / 028 style:
   - Authoritative scope: this doc.
   - Dependency: applies after migration 028 (medication tables
     exist) and migration 024 (acknowledgments + parent_family_links
     RLS pattern that this feature mirrors).
   - Design decisions: polymorphic target shape; Edge Function for
     parent read; retention inherited from funding-docs.
   - Expected verification queries.
2. **`CREATE TABLE public.consent_attachments`** with the columns
   sketched in §"The two assets" above. Includes the CHECK on
   `target_type`.
3. **Indexes** per §"The two assets."
4. **`set_updated_at` trigger** (existing function, same usage as
   `funding_documents`).
5. **RLS** — enable + four policies (provider SELECT/INSERT/UPDATE;
   no DELETE; no parent SELECT).
6. **`INSERT INTO storage.buckets`** — `('consent-attachments', 'consent-attachments', false)`.
7. **Storage policies** — three policies on `storage.objects`
   (INSERT/SELECT/DELETE), each gated by
   `bucket_id = 'consent-attachments' AND auth.uid()::text = (storage.foldername(name))[1]`.
8. **No data backfill.** Existing acknowledgments / medication rows
   have no attachments; the table is empty post-migration.
9. **Down migration** commented at file bottom (drop policies, drop
   bucket, drop table; caveat about uploaded objects in the
   bucket).
10. **Runbook entry** per CLAUDE.md same-PR doc discipline.

The Edge Function (`api/consent-attachment-url.js`) is application
code; it ships in the SAME PR as the migration so the parent-read
path lands atomically with the schema.

---

## §12. UI design

### Where the attach affordance lives

| Modal | Where | Per |
|---|---|---|
| `ChildIntakeModal` | Under the existing per-subitem section (or beside the envelope-level `Send to portal` action — proposal) | Per `acknowledgments` row in the intake bundle. Most natural: one attachment slot at the envelope level for the bundle as a whole, with the option to add per-subitem if a paper covers only specific items. |
| `EnrollmentConsentsModal` | Inside each consent card (`field_trip_permission`, `photo_sharing_consent`, Phase B `transportation_routine_annual` + `water_activities_on_premises_seasonal`, Phase C per-occurrence cards) | Per ack row. The per-occurrence Phase C cards already render one row per occurrence; the attachment slot lives on that row. |
| `MedicationModal` | Inside each authorization card AND on the OTC-blanket consent card | Per ack row (`medication_permission` ack per authorization, `medication_permission_otc_blanket` ack per child). Both target `target_type='acknowledgment'`. |

### Visual elements per attach slot

- **Attach control:** a small drop-zone + file-picker button. Same
  visual language as `FundingDocumentSlot`'s `DropZone` — drag-drop
  + click-to-choose.
- **Recent-N list of existing attachments** (limit 5 like the
  per-occurrence list): filename + uploaded date + view + remove
  buttons per row. View is a thin wrapper that opens the signed URL
  in a new tab.
- **Validation surfacing:** inline error banner if validation fails
  (same pattern as `FundingDocumentSlot`'s `ErrorBanner`).
- **Save confirmation:** mirror the PR #20 medication-modal
  pattern from 2026-06-02 — inline ✓ chip on successful upload,
  list updates in place, modal stays open. Lesson learned from the
  medication-modal fix-forward: don't fire `onSaved` that triggers
  the parent's `loadAll()` cascade. Refresh the modal's own state
  only.

### The decision: extract `FundingDocumentSlot` to a shared component?

Two options, named for the build to decide:

- **(a) Extract `<DocumentSlot>` to `src/components/storage/DocumentSlot.jsx`**
  parameterized by `bucket`, `tableName`, target shape, validation
  helper. Both `FundingDocumentSlot` and the new consent-attachment
  slots become thin wrappers.
- **(b) Build a new `ConsentAttachmentSlot.jsx`** under
  `src/components/families/` that's similar-but-separate.

Recommend **(a) extraction** as part of decision 10's helper extract
— two surfaces sharing the same component avoids drift. The build
PR can revisit if extraction turns out larger than expected.

### Parent-side rendering

Parents view scans in `ParentEnrollmentConsentsPanel` (and the
parallel intake / medication parent surfaces, if they exist).
- The panel calls the Edge Function on click to obtain a signed URL.
- The thumbnail/filename list is read from `consent_attachments`
  via a parent-side SELECT policy (NEW)? No — per decision 1 there
  is NO parent-side SELECT policy on this table. The parent can't
  even know the list of attachments for their child's consent
  without going through the Edge Function.
- **Resolution:** the Edge Function also serves a "list attachments
  for a consent I'm authorized to view" endpoint, OR a parent-side
  RLS policy on `consent_attachments` SELECT (mirror of migration
  024's parent-side policy on `acknowledgments`) is added. The
  latter is simpler — the RLS check is the same join shape that
  works for `acknowledgments`. State the decision:

### Sub-decision (parent-side metadata list): add a parent SELECT policy

For parent-side LISTING of attachments (filename / uploaded date),
add a SELECT-only RLS policy on `consent_attachments`:

```
create policy "Parents can view consent attachments for their children"
  on public.consent_attachments for select to authenticated
  using (
    target_type = 'acknowledgment'
    and exists (
      select 1
        from public.acknowledgments a
        join public.children c on (
          (a.subject_type = 'child' and c.id = a.subject_id)
        )
       where a.id = consent_attachments.target_id
         and c.family_id in (
           select pfl.family_id from public.parent_family_links pfl
            where pfl.parent_id = auth.uid() and pfl.status = 'active'
         )
    )
    -- (medication_authorization branch added similarly when needed)
  )
```

Note: this RLS policy gives parents METADATA (filename, uploaded
date, etc.) — it does NOT give them storage read access. The
storage bucket remains owner-only. They still need the Edge
Function to read the actual file content.

This is the same "you can see WHAT exists; you have to go through
the function to see the CONTENT" split that gives the function its
auditable cross-tenant boundary while letting the parent UI render
a useful list.

---

## §13. Retention + the missing sweep job

Inherit funding-docs convention. Specifically:

- **`retention_until date NOT NULL DEFAULT (current_date + interval '4 years')::date`** on every attachment row. Editable per row for special cases (active dispute, longer-retention LEP records). Same default the funding-docs migration uses.
- **Soft-delete via `archived_at` / `archived_by`.** Never hard-delete (CLAUDE.md never-hard-delete rule). The storage object survives the archive.
- **No retention-sweep cron ships with this feature.** Same gap migration 008 has. A future cron job (server-side, service-role, outside RLS) would `SELECT id, storage_path FROM consent_attachments WHERE archived_at IS NOT NULL AND retention_until < CURRENT_DATE` and purge both the storage object and the metadata row. The `(retention_until) WHERE archived_at IS NOT NULL` index is in place to support that scan efficiently.
- **What this feature can do:** nothing automatic. Manual cleanup if needed (rare; the storage cost is bounded for v1).

---

## §14. Tests

- **`consent_attachments` table shape** test — every documented column present with the expected type/nullable/default.
- **RLS policies** — provider can SELECT/INSERT/UPDATE their own rows; parent SELECT policy returns only their children's attachments (RLS-level testing via the supabase-js client signed in as a test parent).
- **Storage bucket exists** with the expected RLS policies; owner-only path predicate.
- **Pure helpers** in `src/lib/storage.js`:
  - `validateFile` — happy path, oversize, wrong type, MIME-or-extension fallback (the HEIC iOS quirk).
  - `buildStoragePath` — produces the `<provider>/<target>/<uuid>.<ext>` shape; throws on missing inputs.
  - `defaultRetentionUntil` — current_date + 4 years.
- **Edge Function** — the privacy-boundary tests:
  - Provider's own request → succeeds.
  - Linked parent's request for their child's consent → succeeds, signed URL returned.
  - Different parent (or parent of a different child) → 403 (or 404 if the harden-against-enumeration variant is taken). **THIS IS THE PRIVACY BOUNDARY.**
  - No JWT → 401.
  - JWT for a user not in `parent_family_links` at all → 403/404.
  - Archived attachment → 404.
  - Non-existent attachment_id → 404.
  - `target_type='medication_authorization'` resolution path (when v2 wires it).
- **Upload / orphan cleanup integration test** (mocked or real Supabase) — failed metadata insert removes the just-uploaded storage object.
- **Soft-delete behavior** — `archived_at` set; storage object survives; subsequent reads return zero rows for the metadata; storage path remains queryable from history if needed.
- **Build clean, vitest green, lint passes (`--max-warnings 0`).**

---

## §15. Verification gate — the three-test live check

This is the build's verification gate (per the CLAUDE.md "schema
verification requires user-visible dashboard evidence" rule + the
"don't claim it works on tests alone" lesson from every prior PR).

### Setup

- Migration 029 applied to production (via Supabase web SQL editor;
  screenshots per runbook).
- Two real test children belonging to TWO different test families.
- The signed-in provider's auth.uid() (uploader).
- Two real test parent accounts, one linked via `parent_family_links`
  to family A, the other linked to family B.

### The three tests (must all pass for the gate)

#### Test 1 — Provider upload + provider read

1. Provider signs into the preview.
2. Opens (say) `EnrollmentConsentsModal` for a Family A child.
3. Uploads a scan to the field_trip_permission consent.
4. The attachment appears in the list; provider clicks "View" — opens the signed URL in a new tab; the file renders.

**Pass:** the upload + read round-trip works on the provider side.

#### Test 2 — Linked parent read (Parent A → Family A's consent)

1. Parent A signs into the parent portal.
2. Navigates to the consents tab for their Family A child.
3. Sees the attachment in the list (parent-side SELECT RLS works).
4. Clicks "View." The client calls `api/consent-attachment-url` with `attachment_id`.
5. The function returns a signed URL; the parent's tab opens it; the file renders.

**Pass:** the legitimate cross-tenant read works via the Edge Function.

#### Test 3 — Unlinked parent denied (Parent B → Family A's consent) — THE PRIVACY BOUNDARY

1. Parent B (linked to Family B only) signs in.
2. Via DevTools / curl / a crafted request, calls `api/consent-attachment-url` with the `attachment_id` that belongs to Family A (which Parent B should NEVER see).
3. The function denies — **403 (or 404)** — and **no signed URL is returned**. No file leaks. No path leaks.

**Pass:** the cross-tenant denial works. **This is the test that has to be proven live, not assumed.** A bug here is a privacy breach class.

Also recommend, as a belt-and-suspenders check:
- Parent B's PostgREST query against `consent_attachments` directly (no Edge Function) returns zero rows for Family A's attachment id (the parent-side SELECT RLS policy correctly filters).
- A NOT-signed-in client gets `401` from the Edge Function.

### What "FAIL" looks like

If Test 3 succeeds in returning a signed URL — the Edge Function's auth check is broken. **Halt the deploy; the feature is not safe to ship.** The whole point of the function is to make this denial fail-closed.

---

## §16. Out of scope (explicitly deferred)

Named so they're not absorbed silently.

- **Retention-sweep cron.** See §13. Same gap funding-docs has.
- **`message-photos` bucket schema capture.** See §10. Acknowledged tech-debt gap; this feature is independent.
- **`children.immunization_record_url` consolidation.** See §10. Separate cleanup; this feature doesn't consume or remove the column.
- **Mobile-camera capture flow** (direct photo from the device camera vs file picker). Fast-follow UX improvement; data model supports it as-is.
- **OCR / signature-panel extraction.** The scan is opaque pixels.
- **Provider-to-provider attachment sharing.** Architecturally distinct from parent-read; not foreclosed by this design.
- **Per-modal attachment count badges in audit-state.** The `getChildFilesAuditState` helper could grow a `consent_attachments_count` field, but PR #22's contract is the right place to design that — out of scope here.
- **`target_type='medication_authorization'` UI wiring.** The schema reserves the type; no v1 UI exercises it. Future feature wires it without a migration.

---

## §17. Halt for review — show

When CC picks this up for the build PR:

1. The migration file (one CREATE TABLE, one bucket insert, indexes + RLS policies; matches 024/028 header style; runbook entry).
2. The shared `src/lib/storage.js` (decision 10) + the two callers (`FundingDocumentSlot` and the new consent-attachment slot/component) importing from it.
3. The Edge Function (`api/consent-attachment-url.js`) with the auth-check algorithm from §8.
4. The UI hooks in `ChildIntakeModal`, `EnrollmentConsentsModal`, `MedicationModal`.
5. The parent-side rendering in `ParentEnrollmentConsentsPanel` (and any other parent consent surfaces).
6. Test coverage matching §14.
7. Confirmation that the three live tests from §15 are runnable + scripts/SQL prepared.

Do NOT deploy or merge until **all three** live tests pass — particularly Test 3.

---

**End of consent-attachments scope — FINAL.** Both watch-items
resolve cleanly:

- **Decision 3 (Edge Function auth check):** the auth algorithm
  enumerates explicit resolution paths to `child_id` and explicit
  denial branches; the cross-tenant test (Test 3 in §15) is the
  proof gate. Clean.
- **Decision 6 (consent-link shape):** polymorphic `(target_type,
  target_id)` with a CHECK enumerating allowed values; the FK-only
  alternative is documented and rejected for forward-compat reasons;
  the lack-of-DB-FK tradeoff is named and mitigated. Clean.

Ready to hand to CC for the build PR.
