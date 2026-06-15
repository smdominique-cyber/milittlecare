# Auditor Read-Only Portal — Design Document

**Status:** SCOPING. **Not implemented.** No code, no migration, no SQL committed
alongside this doc.
**Date:** 2026-06-15.
**Branch:** `docs/auditor-portal-scoping`.
**Authoritative companion docs:**
- `docs/pr-compliance-engine-scope.md` § 7 — earlier auth-mechanism
  sketch that this document narrows and updates against the current
  state of the codebase. Where this doc disagrees with §7, this doc
  wins (it's newer and reflects what's actually shipped).
- `docs/road-to-publishable.md` § 2.1, § 2.2 — the roadmap-level
  "audit packet" + "auditor portal" entries, both marked **NOT BUILT**
  as of 2026-06-15.
- `docs/backlog.md` § "Future PR — Auditor Read-Only Portal" — the
  ambient feature description; this doc supersedes it for design
  intent.

---

## 0. What this document is and is NOT

**Is:** a design-decisions surface. It enumerates the options Seth
needs to choose between, with the tradeoffs of each, and flags every
decision with `[DECISION — Seth]` so the eventual build PR can cite
this doc for "the call was made here."

**Is not:** a build PR. No schema is being committed. No code is
being committed. No migration is being added to
`supabase/migrations/`. No new function file is being scaffolded.

The purpose of producing this doc BEFORE the build is that this
feature exposes provider records to an outside party (a licensing
inspector). The security/privacy tradeoffs have to be examined
deliberately rather than discovered mid-implementation. The
consent-attachment Edge Function (`api/consent-attachment-url.js`)
is the pattern this portal will mirror; the *parallel* it draws to
how parents access provider data already shipped through
verification gates Y1 1-8 with cross-tenant denial confirmed live.
The auditor boundary is a sibling problem with a different actor.

---

## 1. What data would an auditor need to see — mapped to what EXISTS today

A Michigan licensing inspector arriving for a CDC scholarship /
Licensed Home rule-set audit (R 400.1901-1951) wants to see, in
rough priority order, what's in the regulation. This section walks
the regulatory list and reports what's already queryable in
production today vs what would need to be built first.

### 1.1 Already-queryable data (the portal could read these now)

| Category | Source table(s) | Notes |
|---|---|---|
| Provider profile (license_type, identifying info) | `profiles` | Migration 001 + 022. `daycare_name` writable since 2026-06-15. |
| Children roster | `children` (filtered `archived_at IS NULL` for current roster; including archived for historical scope) | Migration 016 / 021. Soft-deletes preserved. |
| Families + parent links | `families`, `parent_family_links` | Migration 016 / 024. |
| Caregivers (regulatory roster) | `caregivers`, `caregiver_regulatory_roles` | Migration 012. |
| Staff training records | `staff_training_records` | Migration 012. Per-caregiver, dated. The MiRegistry-mirror rows are tagged. |
| Acknowledgments (T&A, intake bundle, consents) | `acknowledgments` | Migration 020 + 024 + 026 + 027 + 041. The unified ack model. |
| Consent attachments (intake forms, medication permissions, photo waivers) | `consent_attachments` | Migration 029. Storage objects in the `consent-attachments` bucket. |
| Medication authorizations + administration events | `medication_authorizations`, `medication_administration_events` | Migration 028. The PR #20 surface. |
| Property records / compliance documents (fingerprint reprint, radon, heating, licensing notebook) | `compliance_documents` | Migrations 038 + 039 + 040. Storage objects in `compliance-documents` bucket. |
| Funding sources + funding documents (DHS-198 / I-Billing PDF, CDC packet) | `funding_sources`, `funding_documents` | Migrations 003 / 008. |
| Business policies + hours + closures | `business_policies`, `business_hours`, `closures` | Migration 016 / 020. |
| Intake packets (the new container) | `intake_packets` | Migration 041 (applied per runbook). Packet → ack fan-out. |
| Compliance state (the engine output — `applies` / `on_file` / `expired` / etc.) | Computed in `src/lib/complianceState.js` from the rows above | Phase 1 of the engine is SHIPPED (`REQUIREMENT_REGISTRY` populated, `getRequirementState` resolves, `complianceStateLoader.js` does the Supabase fan-out). |

**Bottom line on existing data:** essentially every reading an
auditor would want is already in the schema or computable from it
today. The portal does NOT need new domain data to be shipped first;
it needs **the access boundary** to be shipped.

### 1.2 Data that doesn't exist yet but might be desired

| Category | Status | Decision |
|---|---|---|
| Attendance per child (sign-in / sign-out logs over time) | `attendance` table exists (migration 016, capture); per-child / per-day query and the audit-window filter on top exist as features in the provider app | Already queryable. |
| Drill logs (Rule 39) | NOT BUILT. PR #19 scope is authoritative but the table does not yet exist. | If the portal ships before PR #19, the drill log section either shows "not yet tracked in app" or is hidden from the audit packet. Flag for the [DECISION] below. |
| Discipline policy acknowledgments | PR #17 scope, NOT YET BUILT | Same handling as drill logs. |
| Staff-file gaps (Rules 3, 6, 19, 20, 22, 33) | PR #18 scope, NOT YET BUILT | Same handling. |

### 1.3 The "audit packet" — PR #11 — does NOT exist in code

Confirmed by inventory:
- No `src/components/audit/` directory.
- No `AuditPacket*` files.
- No `audit_packets` table in `supabase/migrations/`.
- No PDF / ZIP generator.

`docs/road-to-publishable.md` § 2.1 also confirms: PR #11 is
**NOT BUILT**. It exists only as a backlog concept.

**Is the auditor portal blocked on PR #11?** **No, not strictly,
and the dependency was overstated in the backlog text.** PR #11's
deliverable as imagined is a *generated artifact* — a PDF / ZIP the
provider can hand the auditor. The auditor portal's deliverable is
a *live view* — the auditor browses, by reading endpoints. They
share data sources but they're different surfaces.

The portal CAN ship without the packet generator, reading the same
underlying tables. If both ship, they're two output formats of the
same source data: the portal is "browse live"; the packet is "export
snapshot for offline review or sharing with supervisor."

→ Recorded as `[DECISION — Seth]` in § 8.

---

## 2. The auth model — the load-bearing decision

The actor: a Michigan licensing inspector. Today the schema
recognizes two actor classes via RLS:

- **provider** — full-tenant, `auth.uid() = profiles.id`.
- **parent** — cross-tenant, scoped through `parent_family_links`
  to one or more children belonging to ONE OR MORE providers.

The auditor is a **third actor class**. The options below differ
not in WHO the auditor is but in HOW their session is authenticated
and how it maps to a Postgres RLS guarantee.

For each, I report: how access is granted, how it's scoped to one
provider's data, how it expires, how it's revoked, the leak risk,
and **the RLS / scope-check shape that makes it not-bypassable**.

### Option A — Signed expiring link via Edge Function (the consent-attachment pattern)

**How granted.** Provider opens a new "Auditor access" panel
(BusinessInfoPage or its own page). Picks expiry (default 24h),
optionally picks specific children (default = current active
roster), optionally types the auditor's name/email for the log.
Backend writes an `auditor_sessions` row (proposed in § 6) and
generates a signed URL of the form:

```
https://milittlecare.com/auditor/inspect?token=<opaque>
```

`<opaque>` is the session row's UUID plus an HMAC-signed payload.
Provider shows that URL to the auditor (in person, via SMS, by
email — that's the provider's choice). Auditor opens it in any
browser. **No signup, no signin.**

**How scoped to ONE provider's data.** The `/auditor/inspect`
route is served by a new Edge Function (`api/auditor-read.js`,
mirroring `api/consent-attachment-url.js`). The function runs as
service-role; every read it performs goes through an
*in-code* scope check before returning anything:

1. Verify the HMAC on the token. Invalid → 404.
2. Load the `auditor_sessions` row by UUID.
3. If `revoked_at IS NOT NULL` OR `expires_at <= now()` → 404.
4. The function only exposes typed read endpoints
   (`read.child(id)`, `read.acknowledgments(child_id)`,
   `read.medication_authorization(id)`, etc.). Each endpoint
   resolves the requested resource to a `child_id` (or a
   provider-level scope), and checks that child_id is in
   `auditor_sessions.child_id[]` (or that provider-level reads
   are enabled on the session). Else → 404.
5. The function NEVER accepts mutations. There is no `write.*` shape.
6. Every successful read inserts a row into
   `auditor_session_access_log` (proposed in § 6).

**How it expires.** `expires_at` is checked on every read.
Default 24h. Hard cap = 72h (`[DECISION — Seth]` confirm).

**How revoked.** Provider sets `revoked_at = now()` from the
panel. The Edge Function's step 3 catches it; next read returns
404. Real-time within the next request (no client-side cache to
flush — the token IS the auth; the session row IS the gate).

**Leak risk.** The token, if forwarded by the auditor to a third
party, IS the access. Mitigations:
- Provider-set short expiry (24h default).
- Provider-set child scope (the leaked link is bounded to the
  named children).
- Optional first-open "who are you" form (auditor types their name
  before browsing; recorded but not gating). Provides a
  human-readable accountability artifact in the log without
  becoming an auth hurdle.
- Provider can revoke any time.
- `auditor_session_access_log` records IP + user-agent for every
  read. Two simultaneous sessions from different IPs on one token
  is a visible signal in the log.

**RLS posture / why this can't be bypassed:**

| Layer | What protects |
|---|---|
| Storage RLS (consent-attachments bucket) | Already owner-only via first-folder-segment = `auth.uid()`. The Edge Function reads with service-role — same trick consent-attachment-url already uses. The auditor's "auth.uid()" doesn't exist; they have no JWT. They cannot access storage via the regular client at all. |
| `auditor_sessions` RLS | Provider can SELECT/INSERT/UPDATE their own rows (`provider_id = auth.uid()`). Auditor cannot SELECT this table because they're not authenticated against Supabase at all. |
| `auditor_session_access_log` RLS | INSERT-only via the Edge Function (service-role). Provider SELECT for their own sessions. No public SELECT. |
| Every domain table the auditor reads | UNCHANGED. The Edge Function reads as service-role; the scope check is the **in-code join** the function performs, identical pattern to `resolveChildIdFromAttachment` in `consent-attachment-url.js`. |

**The key insight, same as the parent boundary:** the auditor
NEVER authenticates against Supabase. There is no `auth.uid()` for
them, no policy that grants them anything. They get data **only
through the function's typed reads.** The function is the
boundary. RLS doesn't have a "for auditors" branch on every table;
the boundary is concentrated in one file we can read carefully and
verify with live tests.

**Pros:**
- No new auth actor in the schema (no third `auth.users` role).
- Reuses the proven consent-attachment pattern. The Phase Y1 8-step
  live verification gate is the model.
- Auditor friction: zero. Open a link, browse.
- Expiry + revocation enforced server-side, on every request.
- Read-only enforced by construction (no `write` endpoints exist).
- Full audit trail of every read in `auditor_session_access_log`.
- The single file `api/auditor-read.js` IS the entire access
  policy — readable, reviewable, testable.

**Cons:**
- A leaked link IS the access. Mitigated by scoping + expiry +
  revocation + the audit log, but not eliminated.
- No two-factor. (None of the options have 2FA. Option B's magic
  link is also single-factor.)

### Option B — Temporary provisioned auditor account (`auth.users` row + magic link)

**How granted.** Provider creates a session: types auditor's email,
picks children + expiry. Backend creates a real `auth.users` row
with that email, plus an `auditor_sessions` row referencing it.
System sends a Supabase magic-link email to the auditor. Auditor
clicks the link, lands in an authenticated session.

**How scoped to ONE provider's data.** RLS policies on every
table the auditor can read need a new branch:
`auth.uid() IN (SELECT auditor_user_id FROM auditor_sessions
                  WHERE provider_id = <row.provider_id>
                    AND child_id @> ARRAY[<row.child_id>]
                    AND revoked_at IS NULL
                    AND expires_at > now())`.

That branch has to be added to every table the auditor sees — a
policy expansion roughly on the order of: `children`,
`acknowledgments`, `consent_attachments`,
`medication_authorizations`, `medication_administration_events`,
`compliance_documents`, `staff_training_records`, `caregivers`,
`caregiver_regulatory_roles`, `attendance`, `funding_sources`,
`funding_documents`, `business_policies`, `business_hours`,
`closures`, `intake_packets`, … and ANY future table that
contains audit-relevant data. **Each new RLS branch is a place a
future migration can leak.**

**How expires.** The `auditor_sessions.expires_at` check is on
every RLS policy. If a future migration adds a table with audit
data but forgets the branch, the auditor sees nothing OR — depending
on direction — sees something they shouldn't.

**How revoked.** `auditor_sessions.revoked_at`. Same as A, on
every policy.

**Leak risk.** Magic link is one-time but the resulting JWT is
valid for ~1 hour and can be saved/replayed. The `auth.users` row
persists past the session (cleanup is a maintenance task). A magic
link in an inbox is a leak surface; an inbox is not as secure as a
URL the auditor never wrote down.

**RLS posture / why this can't be bypassed:**
- Scope-check is in EVERY policy on EVERY table the auditor reads.
- A missed policy = a leak (rows the auditor wasn't supposed to see
  become visible to their `auth.uid()`).
- Each new audit-relevant table = a new policy to write + a new
  thing to live-gate. The `auditor_sessions` table is the
  switchboard.

**Pros:**
- Auditor identity is captured by the auth system (email).
- Standard Supabase magic-link UX (the team has built this twice
  already for parent + provider invitations).

**Cons:**
- **New actor class in the schema.** Every policy on every
  audit-relevant table gains an `auditor_sessions` branch. That's a
  policy-surface-area expansion of roughly 12-15 tables today and
  more with each future audit-relevant feature.
- **Verifying the boundary is much harder.** Option A's boundary
  is one Edge Function; we read it, we cross-tenant-test it, we
  call it done. Option B's boundary is "every policy on every
  table" — verification means checking each policy with a real
  authenticated auditor JWT. The Phase Y1 8-step gate model would
  expand to a per-table-N-step gate.
- The `auth.users` row outlives the session and accumulates.
  Cleanup = a maintenance job that can drift.
- Magic links in email = leak surface that's HARDER to scope-bound
  than a URL the auditor pastes once.
- Auditor needs email access on a device. Field-friendliness is
  worse than A.

### Option C — Passcode / OTP (middle ground)

**How granted.** Provider creates a session. App generates a
6-digit or 8-character passcode. Auditor goes to
`https://milittlecare.com/auditor/inspect` and types the passcode.
On submission, the backend verifies it against
`auditor_sessions.passcode_hash`, sets a short-lived session cookie
specific to this audit session.

**How scoped to ONE provider's data.** Same as Option A — the
backend is the boundary; reads go through typed endpoints with
per-resource scope checks.

**How expires.** `expires_at` on the session row, checked on every
read. The session cookie itself is also short-lived (e.g., 4h
sliding) so a stolen cookie doesn't outlive a stolen passcode by
much.

**How revoked.** Provider sets `revoked_at`; next request fails.

**Leak risk.** Mixed.
- **Worse than A for accidental leakage:** a 6-digit passcode is
  trivially brute-forceable if the endpoint isn't rate-limited
  hard. Need explicit per-IP and per-passcode rate limits.
- **Better than A for forwarding:** a passcode is harder to
  forward than a URL. An auditor who tells their supervisor the
  passcode at least had to read it out — there's no copy-paste
  forward.
- **Worse than A operationally:** passcode delivery channel is
  in-band (provider says it to the auditor) — that's fine — but
  if it's lost mid-audit the recovery is "provider resets the
  passcode" which is more friction than A.

**RLS posture:** identical to A. The Edge Function is the
boundary. The passcode replaces the signed token.

**Pros:**
- Forwarding-resistant compared to a URL.
- Same boundary file as A; same verification rigor.

**Cons:**
- Brute-force surface (rate limiting becomes load-bearing — see
  the `015_security_hardening.sql` precedent for our seriousness
  about this).
- Extra UX step (the auditor types something).
- More moving parts than A for the same security posture, IF the
  rate limiting is done correctly.

### Comparison summary

| Dimension | A (signed link) | B (auth.users + magic link) | C (passcode) |
|---|---|---|---|
| New actor class in schema | No | **Yes** | No |
| RLS policy surface that protects | 1 Edge Function | ~15 table policies (and growing) | 1 Edge Function |
| Verification gate shape | Y1-style 8-step on the function | Per-table N-step on every policy | Y1-style 8-step on the function |
| Leak risk: forwarded URL | High (mitigated by scope/expiry/log) | Lower (link is one-time) | Lower (passcode harder to forward) |
| Leak risk: brute force | None (UUID + HMAC) | None | **Real** — requires hard rate limiting |
| Auditor field UX | Best (open link) | Worst (needs email access) | Middle (type code) |
| Auditor identity captured | Optional first-open form | Email automatic | Optional first-open form |
| Cleanup burden | Row stays; expired sessions still readable as log | `auth.users` row stays past session | Row stays; expired sessions still readable as log |

`[DECISION — Seth]` — pick A, B, or C. **Engineering recommends
A.** Reason: the security guarantee in Option A is concentrated in
one file we can read, test, and verify with a 1:1 model of Phase
Y1's 8-step gate. Option B's guarantee is spread across N policies
and grows with the schema; that's a per-PR-forever liability. Option
C is functionally A with worse brute-force exposure and worse UX.

---

## 3. The isolation surface — the thing that must never break

**Stated as the binding invariant:**

> An auditor invited by provider A must NEVER, under any
> circumstances, see provider B's data — not in a list, not by
> direct id, not in an aggregate, not in a search result, not in an
> error message that confirms a resource exists, not via any
> tracking or analytics surface. And within provider A's data, the
> auditor must never see data outside the session's scope (the
> child_id[] array on the session row).

This is the privacy-leak surface. Below: where the risk sits and
what each option does about it.

### 3.1 Risk: cross-tenant data exposure

**Where it sits:**
- The Edge Function (in A and C) resolves resource IDs to a
  `child_id`. If a resolution path FAILS — e.g., an attachment
  whose `target_type` is something the resolver doesn't handle —
  the code must return 404, not "no resolution found, default to
  visible." The consent-attachment function gets this right by
  treating any unrecognized `target_type` as a deny; the auditor
  function MUST do the same.
- In Option B, the scope-check is in EVERY policy. A missed
  branch = a leaked row. The risk is in the policy migration
  pipeline.

**Mitigation pattern (mirror Phase Y1):**
- Live verification gate, run before merge:
  1. Create session A for provider P, children [C1, C2].
     Auditor reads succeed for C1 + C2.
  2. Same token, request C3 (not in session) → 404.
     `auditor_session_access_log` records the denied attempt.
  3. Same token, request a child belonging to provider Q
     (different tenant entirely) → 404. Log records.
  4. Same token, expired session → 404. Log records.
  5. Same token, revoked session → 404. Log records.
  6. Tampered token (one byte flip in signature) → 404 BEFORE
     session_id lookup. Log records.
  7. Re-issue: provider creates a new session [C1] only; auditor
     gets C1, NOT C2. Log records.
  8. Cross-tenant from a fully-different login session: a parent's
     JWT or another provider's JWT cannot use an auditor token at
     all (the function rejects on the missing-JWT-but-token path
     and on the wrong-JWT-with-token path) → 404.

### 3.2 Risk: in-tenant scope violation

The token is for provider A. Provider A has 10 children; the
audit session only names 3 of them. The auditor must not see the
other 7.

**Mitigation:**
- Every read endpoint resolves to a `child_id` first; the
  `auditor_sessions.child_id[]` membership check is the gate.
- Provider-level resources (compliance documents, training records,
  caregivers) are governed by a separate `scope_includes_provider_level`
  boolean on the session row. By default this is TRUE for licensed
  homes (the audit reaches the whole home, not just specific
  children). Per `[DECISION — Seth]` below — should provider-level
  data be a separate opt-in?

### 3.3 Risk: PII over-exposure within scope

Even within scope, some data is more sensitive than others:
- Parent SSNs / driver's license numbers (collected for tax docs)
  — should an auditor see these?
- Child medical history beyond the audit-relevant fields
  (allergies, medication name) — what about full prescriber
  contact info?
- Caregiver email / phone / DOB.

**Mitigation:**
- Per-endpoint DTO: the function returns READ-ONLY DTOs (data
  transfer objects), not raw rows. Each endpoint specifies which
  columns ship.
- `[DECISION — Seth]` — should the DTO redact PII fields by default
  and have a provider opt-in to expose them?

### 3.4 Risk: side-channel via error messages or response timing

The consent-attachment function collapses 401/403/404 to 404 to
prevent enumeration. The auditor function must do the same.
Timing-side-channels are realistic for token verification (HMAC
check uses constant-time compare); the consent-attachment function
uses Node `crypto.timingSafeEqual`, the auditor function should too.

### 3.5 Risk: storage object access

Both consent-attachments and compliance-documents storage buckets
are private (owner-only RLS). The auditor never has an
`auth.uid()`, so direct storage reads are denied. The Edge
Function mints a short-lived signed URL (15 min, matching the
consent-attachment convention) for each requested attachment.
The signed URL itself is then a leak surface for 15 min — same
risk profile as the parent flow that's already in production. The
audit log records every signed URL minted.

---

## 4. Scope of the audit — what gets exposed

`[DECISION — Seth]` — Three options, NOT mutually exclusive (could
combine).

### 4.1 Whole-roster scope

The session names: this provider, all active children, full
caregiver list, full document store.

**Pro:** matches the realistic audit (the auditor walks in and
audits everything).
**Con:** if an archived child is excluded, the auditor cannot
verify historical compliance for a child who left mid-period. If
archived children are included, the data set is larger than
needed.

### 4.2 Specific-children scope

The session names: this provider, plus a subset of children chosen
by the provider.

**Pro:** principle of least privilege. The auditor sees what they
need to see.
**Con:** harder UX (provider picks 4 of 8 children). Provider might
mis-select. The auditor might need more later — re-issue cycle.

### 4.3 Audit-window scope

The session names: this provider, plus a date range. Only data
intersecting the date range is exposed.

**Pro:** matches "audit window" framing. Old data (>4 years past
retention) is excluded.
**Con:** the engine doesn't currently filter by date in its
projections — every consumer reads "current state." A
window-scoped read is a new query shape, more implementation
work in the Edge Function. Audit windows are also fuzzy in
practice (an auditor may be auditing CY 2025 but a question about
"how long has this kid been enrolled" needs historical reach).

**Recommended starter combination:** **whole-roster + audit-window
filter** for the historical reach, with **specific-children**
exposed as an advanced toggle in the panel. **Engineering
recommends not building specific-children in V1** — the principle-
of-least-privilege argument is theoretical; in practice an audit
covers a home, not a subset, and the UX complexity of multi-select
on session creation is real friction.

`[DECISION — Seth]` — confirm whole-roster + window as the V1
default; defer specific-children.

### 4.4 What the data model supports today

- **Provider-scoped queries are universal** — every audit-relevant
  table has either `provider_id` (the recent additions) or
  `user_id` (older naming). Filtering by provider is trivial.
- **Child-scoped queries are universal** — most rows have
  `child_id` or a chain to it (the consent-attachment resolver
  proves this works).
- **Date-window queries are partial** — `acknowledgments` has
  `acknowledged_at`; `medication_administration_events` has
  `administered_at`; `staff_training_records` has `completed_on`;
  `attendance` has dated rows; the engine output is a snapshot
  (no time-travel). For V1, "date window" applies to dated event
  rows only; the compliance state itself remains "as of now."
  Flagged for the [DECISION — Seth] below as a V2 enhancement.

---

## 5. Audit-trail-of-the-audit

The product promise (per the backlog): "provider sees a log of
what the auditor viewed."

**New table:** `auditor_session_access_log` (proposed in § 6).

**Shape:**
- One row per read endpoint call. (Not one row per response field
  — that's too fine. One row per `read.acknowledgments(child)`,
  `read.medication_history(child, window)`, `read.attachment(id)`.)
- Records: `session_id`, `read_resource_type`,
  `read_resource_id` (or a JSON descriptor for non-id-shaped reads
  like a list), `read_at`, IP, user-agent.
- Records DENIED attempts as well as successes — separately, so
  the provider sees "the auditor tried to look at child C3 (not
  in scope) at 14:32" as a signal.
- Optional: a `signed_url_minted` boolean to mark when an
  attachment URL was issued (separate from the metadata read).

**Provider-facing view of the log:**
- BusinessInfoPage "Auditor access" panel shows the current session
  (if any) and a history of past sessions, each linking to the
  per-session log.
- Per-session view: chronological list of reads, each labeled
  human-readably ("Viewed Aiden T.'s medication log", "Viewed
  intake packet for Bea S.", "Downloaded radon report PDF").
- Denied reads shown in a different color/section so the provider
  notices.

**Retention:** match the 4-year audit retention convention; never
hard-delete. `archived_at` column for the V2 "archive past
sessions" surface.

**`[DECISION — Seth]`** — should the log also record the
**provider-side** actions ("Provider created session X for
auditor Jane Smith, expiring 2026-06-16 18:00, scope: 5 of 5
children") for a complete chain-of-custody? Engineering
recommends yes — the same `auditor_session_access_log` table can
host `read_resource_type='session_event'` rows for create / revoke
/ extend events.

---

## 6. Proposed new schema

`[DECISION — Seth]` — confirm Option A from §2 before this lands.
The shapes below assume A; under B the `auditor_sessions` would
also reference a generated `auth.users.id`, and the RLS policies
would grow scope branches on every audit-relevant table.

### 6.1 `auditor_sessions`

```
auditor_sessions (
  id                          uuid primary key default gen_random_uuid(),
  provider_id                 uuid not null references public.profiles(id) on delete cascade,
  child_id                    uuid[] not null,             -- empty array = whole roster
  scope_includes_provider_level boolean not null default true,
                                                            -- compliance_documents, training, caregivers
  scope_audit_window_start    date,                         -- inclusive; null = no window
  scope_audit_window_end      date,                         -- inclusive; null = no window
  starts_at                   timestamptz not null default now(),
  expires_at                  timestamptz not null,         -- typically now() + 24h
  revoked_at                  timestamptz,                  -- provider revokes mid-session
  revoked_by_user_id          uuid references auth.users(id) on delete set null,
  auditor_label               text,                         -- "Jane Smith, MiLEAP Region 3"
  auditor_acknowledged_at     timestamptz,                  -- first-read "who are you" form submit
  auditor_acknowledged_label  text,                         -- what the auditor typed
  signing_key_version         smallint not null default 1,  -- HMAC rotation seam
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
)
```

**RLS (under Option A):**
- SELECT: `auth.uid() = provider_id`.
- INSERT: `auth.uid() = provider_id`.
- UPDATE: `auth.uid() = provider_id` (for revocation, label edits,
  extending expiry).
- DELETE: never. Past sessions are audit-retained.

**Indexes:** `(provider_id, created_at desc)`, `(expires_at)`
for the cleanup-look query.

**Constraints:**
- `expires_at > starts_at`.
- A row-level CHECK that `revoked_at IS NULL OR revoked_at >= starts_at`.

### 6.2 `auditor_session_access_log`

```
auditor_session_access_log (
  id                          uuid primary key default gen_random_uuid(),
  session_id                  uuid not null references public.auditor_sessions(id) on delete restrict,
  event_kind                  text not null,                -- 'read' | 'denied' | 'session_created' | 'session_revoked' | 'session_extended' | 'signed_url_minted'
  read_resource_type          text,                         -- nullable for session_event rows
  read_resource_id            uuid,                         -- nullable
  read_resource_descriptor    jsonb,                        -- for list reads / window reads
  denial_reason               text,                         -- 'out_of_scope' | 'expired' | 'revoked' | 'invalid_token' | 'unknown_resource'
  ip_address                  inet,
  user_agent                  text,
  occurred_at                 timestamptz not null default now()
)
```

**RLS:**
- INSERT: NEVER from a client. The Edge Function is the only
  writer; service-role inserts. Policy is: no policy at all
  (deny by default; service-role bypasses).
- SELECT: `auth.uid() IN (SELECT provider_id FROM auditor_sessions
                          WHERE id = session_id)`. Provider reads
  their own audit log.
- UPDATE: never.
- DELETE: never (audit-retained).

**Index:** `(session_id, occurred_at desc)` so the provider's
per-session log view is one query.

### 6.3 No new columns on existing tables

The portal pattern keeps all auditor-related state in the two new
tables. No `auditor_visible` flags on `acknowledgments` /
`consent_attachments` / etc. The Edge Function is the boundary,
not table-level flagging.

### 6.4 Storage

No new buckets. The auditor reads existing storage objects via the
Edge Function minting signed URLs from the existing private
buckets (`consent-attachments`, `compliance-documents`,
`funding-documents`). Same TTL (15 min) as the consent-attachment
function.

### 6.5 HMAC signing key

Add to env: `AUDITOR_TOKEN_SIGNING_KEY` (a per-environment secret).
Rotation seam: `auditor_sessions.signing_key_version` records the
version the token was minted under. Future rotation issues a new
key, and old tokens fail HMAC verify cleanly (no special-case
needed — they just stop working, which is the right behavior for
"a session signed with a rotated-out key").

---

## 7. The verification gate — non-negotiable before merge

Same caliber as Phase Y1's 8-step gate (the parent boundary). The
8 tests below run on the preview environment with real seed rows
and Seth observing in devtools / network panel:

1. Create session A for provider P, children [C1, C2], expires
   in 1 hour. Auditor opens the URL. Confirms reads succeed for
   C1's intake bundle and C2's medication log. **One log row each.**
2. Same token → request C3 (not in session). 404. **Log row:
   denied, reason `out_of_scope`.**
3. Same token → request a child id belonging to provider Q
   (different tenant). 404. **Log row: denied,
   reason `out_of_scope`.**
4. Wait until session expires. Same token → any read. 404. **Log
   row: denied, reason `expired`.**
5. Provider revokes session mid-audit. Auditor's next read. 404.
   **Log row: denied, reason `revoked`.**
6. Tampered token (one byte flip). 404 BEFORE session_id lookup.
   **Log row: denied, reason `invalid_token`.**
7. Re-issue: new session for [C1] only. Auditor reads C1 succeed.
   Auditor reads C2 → 404 (no longer in scope).
8. Cross-actor: parent Pa's JWT cannot use an auditor token; a
   second provider's JWT cannot use this provider's auditor
   token. Both → 404.

Every test produces the expected `auditor_session_access_log`
row (or rows for #4 / #5 / #6 with appropriate denial_reason).

The verification gate is the merge gate. The portal does NOT ship
until all 8 tests pass with log evidence.

---

## 8. Decisions Seth needs to make (consolidated)

Each one is `[DECISION — Seth]`; build PR cites this section.

| # | Decision | Engineering recommendation | Reasoning |
|---|---|---|---|
| 1 | **Auth model** — A (signed link), B (auth.users + magic link), or C (passcode)? | **A.** | Single-file boundary; verifiable; reuses Phase Y1 pattern. B grows RLS surface forever. C is A with worse brute-force exposure. |
| 2 | **PR #11 dependency** — must the audit packet generator ship first? | **No.** | The portal reads the same source tables; the packet is a different output format. Either can ship first; if both ship, they share a state-loader. |
| 3 | **Scope model V1** — whole-roster, specific-children, or audit-window? | **Whole-roster + audit-window (V1); defer specific-children.** | The realistic audit covers the home, not a subset. Specific-children adds UX cost without a real privacy gain in the licensed-home audit pattern. |
| 4 | **Provider-level data** — should `scope_includes_provider_level` be opt-in or default-on? | **Default-on for licensed homes, default-off for LEPs (LEPs aren't subject to the property-rules sweep).** | Match the existing module-activation principle. |
| 5 | **PII redaction in DTOs** — default-redact or default-expose? | **Default-expose for compliance-relevant fields, default-redact for non-compliance PII (parent SSN, full prescriber contact).** | Auditors need the compliance fields; non-compliance PII is collected for other reasons and not part of the licensing audit. |
| 6 | **Default expiry / hard cap** | **24h default, 72h hard cap.** | Long enough for a multi-day audit; short enough that a forgotten session doesn't sit forever. Provider can extend an unexpired session up to the cap. |
| 7 | **Audit-trail completeness** — log provider-side actions (create / revoke / extend) as session-event rows in the same table? | **Yes.** | Complete chain-of-custody; one query reads the entire history. |
| 8 | **Provider notification of denied reads** — surface a banner if the auditor's session shows denied attempts? | **Yes, a small "1 read outside scope was blocked" indicator on the audit-log view.** | Cheap, valuable signal. |
| 9 | **Missing data presentation** — when the audit asks about a feature that hasn't shipped (drill logs pre-PR #19, staff-file gaps pre-PR #18), what does the auditor see? | **Show a labeled "not yet captured in MILittleCare — verify in MiRegistry / paper records" note.** | Honest framing; doesn't manufacture false negatives. |
| 10 | **First-open "who are you" form** — required, optional, or omitted? | **Optional.** | Improves the audit log's human readability without becoming an auth hurdle. The auditor can decline and still browse; the log records "no name supplied." |
| 11 | **Rate limiting on token endpoint** (Option A) — required? | **Yes, even though brute-force on a UUID + HMAC is impractical, a global rate limit (e.g., 60 reads per token per minute) protects against a runaway audit script and bounds the audit-log size.** | Matches our defense-in-depth posture in `015_security_hardening.sql`. |

---

## 9. Recommended build sequence

**Phase 1 — schema + Edge Function skeleton (no UI yet).** One
migration adding `auditor_sessions` + `auditor_session_access_log`
with the RLS policies above. One Edge Function file
(`api/auditor-read.js`) implementing token verify + session load
+ the scope-check / denial pattern. Service-role; no client
shipped yet. Unit tests for the resolver + the denial paths.

**Phase 2 — provider-side panel.** New BusinessInfoPage section
"Auditor access": create session (children pickers if § 8.3 says
specific-children; otherwise just the expiry + label + audit
window inputs), revoke, view history with per-session log
expansion. RLS-confirmed by Seth's dashboard evidence on the
session-list query.

**Phase 3 — auditor-side reading UI.** The actual
`/auditor/inspect?token=…` route. Tabbed surface:
- Child roster (with archived toggle if window includes archived).
- Per-child: intake packet (acks), consent attachments, medication
  log, attendance window.
- Provider-level: compliance documents (fingerprint, radon, heating,
  notebook), caregivers + training, business policies, hours.
- Compliance checklist (the engine output — Type 1 vs Type 2 visibly
  tagged per the `pr-compliance-engine-scope.md` §11 decision).

Calls the Edge Function for every read. No direct Supabase client
on this route at all — the auditor's browser never holds a Supabase
JWT.

**Phase 4 — verification gate.** The 8-test live gate above.
Seth runs as Vanessa-as-provider + a fresh "auditor" browser
window. Cross-tenant via a second test provider's seed data.

**Phase 5 — merge.** Only after Phase 4 evidence is in the runbook
(same screenshot convention as Phase Y1).

---

## 10. Dependencies & blocking analysis

- **Does NOT depend on PR #11** (the packet generator). The portal
  reads source tables directly; the packet would be a different
  artifact built later.
- **Soft-depends on the compliance engine Phase 1** (SHIPPED). The
  checklist tab on the auditor view consumes
  `getProviderComplianceState` and `getChildComplianceState`. The
  raw-data tabs (intake, medication, attendance) don't need the
  engine.
- **Soft-depends on PRs #17 / #18 / #19** if Seth wants those audit
  categories to be visible. Per decision § 8.9, the portal ships
  even with those gaps and labels them honestly.
- **Hard-depends on a new HMAC signing key in env**
  (`AUDITOR_TOKEN_SIGNING_KEY`). Trivial; goes in Vercel env vars
  before Phase 4.
- **Hard-depends on the Edge Function runtime being available on
  Vercel** — already in use for `consent-attachment-url`.

---

## 11. Out of scope for this design doc / explicit non-goals

- Multi-provider auditor sessions (one auditor, multiple providers,
  one URL). Not a real use case; a regional inspector visiting
  three homes gets three separate links.
- Auditor write-back (the auditor adding notes the provider sees).
  Hard non-goal — the portal is read-only by construction.
- Persisting auditor identity across sessions (an auditor "account"
  that knows it's seen this provider before). Out of scope; each
  session is independent.
- Integration with MiLEAP's own systems (uploading findings, etc.).
  Out of scope; future state-rule territory.
- Health-score / Type-1 inclusion toggles in the auditor view.
  The auditor view shows everything labeled with Type-1 vs Type-2
  per the engine's `data_authority` tag; provider opt-in toggles
  apply only to the provider's own dashboard.

---

## 12. What this doc commits to vs leaves open

**Commits to:**
- The actor / boundary framing (third actor class via Edge
  Function, not via `auth.users`).
- The schema shape of `auditor_sessions` +
  `auditor_session_access_log` (subject to Decision 1).
- The 8-step verification gate as the merge gate.
- The build sequence in § 9.

**Leaves open (Seth's calls in § 8):**
- Auth model A vs B vs C.
- PR #11 ordering.
- Scope model.
- Provider-level scope default.
- PII redaction default.
- Expiry windows.
- Audit-trail event-row inclusion.
- Denied-read banner.
- Missing-data presentation.
- First-open form.
- Rate limit on token endpoint.

---

*End of design document. No code, no migration, no SQL committed
in this PR. Build PR to follow once Seth signs off on § 8
decisions.*
