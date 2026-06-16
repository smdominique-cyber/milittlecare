# Auditor Read-Only Portal — Auth Re-Scope Design Document

**Status:** SCOPING. **No code, no migration, no SQL in this PR.**
**Date:** 2026-06-15.
**Branch:** `docs/auditor-portal-auth-rescope`.
**Supersedes (for the auth layer only):** `docs/auditor-portal-design.md`
§ 2 Option A. The schema design in § 6 of that doc is amended (not
replaced) by this one.
**Affects:** the unmerged branch `feature/auditor-portal-phase1` —
parts of which carry forward, parts of which are discarded. § 5 below
is the explicit kept-vs-thrown inventory.

---

## 0. Why this doc exists

Phase 1 shipped on `feature/auditor-portal-phase1` an HMAC-signed-link
auth model (the design doc's Option A: token in URL = the auth;
no Supabase login for the auditor). That implementation is on a
branch, not merged, and the migration is not applied.

Seth re-chose, based on how his professional health-record system
handles auditor access: the auditor gets a **real temp Supabase auth
account tied to their state email + a provider-generated temp
password**. That is the design doc's Option B, with one important
specification: **temp password, not magic link.** Field-friendlier
(no email-on-the-phone requirement) and matches the regulator's
existing mental model.

This doc lays out the temp-account model in full so the rebuild PR
can cite it. It is the security-critical layer; like the parent
boundary before it (Phase Y1), the design has to be settled before
the code lands.

The binding invariant — restated at the top because every section
below feeds it:

> **An auditor temp account is a SEALED READ-ONLY BOX around ONE
> provider's records. Nothing else in the entire app is reachable
> through that account — not other providers' data, not any write
> surface, not admin, not provider/parent dashboards, not the storage
> buckets directly. The account is a real `auth.users` row, but it
> can do ONLY what one purpose-built Edge Function permits.**

---

## 1. The core security question — how the seal is built

### 1.1 The "seal" is a layered defense, not one mechanism

In the HMAC-link model, the seal was straightforward: the auditor
had no Supabase JWT at all, so RLS denied everything by default;
the Edge Function (running service-role) was the *only* path to
data. Auditor-side leak risk was confined to one URL.

In the temp-account model, the auditor IS authenticated. Every
authenticated request carries a real JWT with the auditor's
`auth.uid()`. That JWT, if naively granted, could reach any
RLS-policy that says `auth.uid() = something`. The seal has to be
built deliberately so the JWT can do **exactly one thing**:
reach `/api/auditor-read` and get one provider's bundle.

**Defense layers (each independently sufficient — all must hold):**

| Layer | What it protects | Where it lives |
|---|---|---|
| 1. App-role claim on the JWT | RLS on every table can reject `auth.uid()` whose `app_metadata.role = 'auditor'` from ANY table the auditor isn't supposed to read. Default-deny for auditors across the whole schema, then opt them into nothing at the table level (Edge Function reads as service-role). | `auth.users.raw_app_meta_data->>'role' = 'auditor'` set at account-creation time via Supabase admin API. RLS USING clauses reference `auth.jwt()->'app_metadata'->>'role'`. |
| 2. Universal RLS deny-for-auditor on every domain table | Every audit-relevant table grows ONE policy branch: `using (NOT public.is_auditor_jwt())`. That's a single helper function, not a per-table session join. Auditor JWTs cannot SELECT from these tables directly via PostgREST; even an attempt to `supabase.from('children').select()` from the auditor's browser returns zero rows. | New SECURITY DEFINER helper `public.is_auditor_jwt()` reads `auth.jwt()` and returns boolean. Every domain table gets ONE additional restrictive policy. Enumerated below. |
| 3. Edge Function is the ONLY data path | `api/auditor-read` runs as service-role, looks up the auditor's `auditor_sessions` row by `auditor_user_id = auth.uid()`, scopes every bundle read to the session's `provider_id`. Even if Layer 1 + 2 had a gap, the Edge Function still does the scope check in code. | `api/auditor-read.js` (rewritten from Phase 1). |
| 4. Active-session existence | If `auditor_sessions` has no active row for `auth.uid()`, the Edge Function denies. Revocation + expiry are checked here. | `auditor_sessions` table; session lookup at the top of the read handler. |
| 5. Storage RLS | Both private buckets (`consent-attachments`, `compliance-documents`, `funding-documents`) already require the storage path's first folder segment to match `auth.uid()` (provider-only). The auditor's `auth.uid()` doesn't match any provider's, so direct storage access is denied. The Edge Function mints short-lived signed URLs via service-role for explicit reads. | Storage policies already in place from prior PRs; no change. |

Layers 1 + 2 are the **app-side blast-radius cap**: even if the
auditor were to find an unprotected REST surface, the JWT itself
denies. Layer 3 is the **only positive grant**: the Edge Function
opens exactly the bundle door. Layers 4 + 5 are belts on the
positive-grant pathway.

### 1.2 Why a role-claim + universal deny instead of per-table allow

The design doc § 2 Option B raised "RLS policies on every table
grow another branch" as a con — and described that branch as a
*positive grant*: "OR auth.uid() is an active auditor session for
provider_id." That's the wrong direction.

This re-scope inverts it:
- **Positive grants stay table-specific to the EXISTING actors**
  (providers via `auth.uid() = user_id`, parents via
  `parent_family_links`). No new positive grant is added.
- **One additional restrictive (RESTRICTIVE) policy per table
  rejects any caller whose JWT has `role = 'auditor'`.** This
  doesn't expand the surface — it caps it. The auditor JWT is
  default-deny everywhere, and the data path is opened by the Edge
  Function reading as service-role.

The seal therefore doesn't require touching N table policies to
verify "did this grant the auditor exactly the right rows?" — it
only requires touching N table policies to verify "did this DENY
the auditor everywhere." A deny-only branch is much easier to
audit than a grant branch.

PostgreSQL's RLS RESTRICTIVE policies are AND-combined with all
other policies. So:
- Existing PERMISSIVE policy: `using (auth.uid() = user_id)` —
  provider sees their rows.
- New RESTRICTIVE policy: `as restrictive using (NOT
  public.is_auditor_jwt())` — auditors are categorically denied.

An auditor's JWT fails the RESTRICTIVE check; the row is denied
regardless of the permissive policy. A provider's JWT passes the
RESTRICTIVE check (their role isn't 'auditor'); the permissive
policy proceeds normally.

### 1.3 Tables that grow the RESTRICTIVE auditor-deny

Every table containing provider data the auditor should reach
ONLY through the bundle endpoint, AND every adjacent table that
shouldn't leak. Enumerated:

**Provider/audit-relevant (15 tables):**
- `profiles`
- `children`
- `families`
- `guardians`
- `emergency_contacts`
- `caregivers`
- `caregiver_regulatory_roles`
- `staff_training_records`
- `acknowledgments`
- `consent_attachments`
- `medication_authorizations`
- `medication_administration_events`
- `compliance_documents`
- `funding_sources`
- `funding_documents`
- `intake_packets`
- `business_policies`
- `business_hours`
- `closures`
- `attendance`

**Money / sensitive non-audit (these MUST also deny auditor, to
keep the seal tight even though they aren't in the bundle):**
- `invoices` / `invoice_items`
- `receipts`
- `payment_methods` (the autopay enrollment surface, if a row-table)
- `parent_profiles`
- `parent_family_links`
- `messages` / `threads` (provider-parent chat)
- `family_invitations` / `staff_invitations`
- `reminder_instances` / `reminder_preferences`
- `notification_log`
- `compliance_applicability_overrides`

**Phase-1 auditor-portal tables:**
- `auditor_sessions` — auditor reads NOT permitted here either; the
  session lookup happens via service-role in the Edge Function. The
  EXISTING provider-scoped SELECT policy stays; the RESTRICTIVE
  branch denies auditor JWTs from listing other sessions or their
  own.
- `auditor_session_access_log` — same: provider sees their own log
  via existing SELECT; auditor JWT is RESTRICTIVE-denied.

**Total:** ~28 tables get a one-line RESTRICTIVE policy. **The
policy body is identical on every table** — it's `as restrictive
using (NOT public.is_auditor_jwt())`. One helper function, one
policy SQL fragment templated across the schema. Verifiable by
`select tablename, policyname from pg_policies where policyname
= 'auditor jwt denied' order by tablename;` returning all 28 rows.

`[DECISION — Seth]` — confirm the deny-list is complete. Worth a
once-over before the build PR. The principle: **anything that
contains any data, period, gets the deny branch.** The cost is
one line per table; the safety is "the seal doesn't depend on
remembering to add the branch."

### 1.4 The `is_auditor_jwt()` helper — the seal's single point of truth

```
create or replace function public.is_auditor_jwt()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select (auth.jwt()->'app_metadata'->>'role') = 'auditor';
$$;
```

Three load-bearing properties:
1. **`STABLE`** — Postgres can cache the result within a query;
   the JWT doesn't change mid-query.
2. **`SECURITY DEFINER`** — runs as the function owner, so RLS
   policy evaluation doesn't recurse into the policy's own
   `is_auditor_jwt()` check.
3. **`search_path` set to `public, pg_catalog`** — matches the
   015 hardening convention (auditor doc § 15) so the function's
   own behaviour is stable across schemas the caller controls.

Canonical revoke/grant trailer per CLAUDE.md Engineering Discipline
rule 4:
```
revoke all     on function public.is_auditor_jwt() from public;
revoke execute on function public.is_auditor_jwt() from anon;
grant  execute on function public.is_auditor_jwt() to authenticated;
```

If a future maintainer changes the role string ('auditor' →
something else) the change is ONE line in this function. If a future
RESTRICTIVE policy needs the same gate, it just calls this helper.

### 1.5 Storage buckets — the existing provider-scope policies hold

The three private buckets (`consent-attachments`,
`compliance-documents`, `funding-documents`) all use a
first-folder-segment-equals-auth.uid() policy: a file at
`/<providerUuid>/<…>/<…>.pdf` is readable only by the auth user
whose id matches that first segment. An auditor's `auth.uid()` is
their OWN uuid (the temp account's), NOT any provider's uuid, so
auditor direct storage reads are denied by the existing policies
without modification.

The Edge Function mints 15-min signed URLs via service-role for the
auditor's bundle (same pattern as `consent-attachment-url.js`).

### 1.6 The blast radius of a leaked auditor credential

A malicious party who obtains a working `(email, password)` pair
during the session window can:
- Sign in as the auditor.
- Receive a real Supabase JWT for the auditor account.
- Call `/api/auditor-read` with that JWT.
- Receive ONE provider's read-only bundle (the one the session
  scopes to).
- Receive 15-min signed URLs for that provider's attachments.

They CANNOT:
- Reach any other provider's data.
- Call any write endpoint (the read endpoint is read-only by
  construction; the mint endpoint requires a provider JWT not an
  auditor JWT).
- SELECT from any domain table directly via PostgREST (RESTRICTIVE
  deny by `is_auditor_jwt()`).
- Reach storage objects directly (storage RLS).
- Reach any non-auditor route in the SPA — the Phase 3 SPA reads
  the role claim and refuses to render provider/parent surfaces
  for an auditor JWT.
- Mint additional audit access for other providers (the mint
  endpoint requires a provider JWT, and even if they had one, it
  would create a NEW auditor account on a DIFFERENT email; this
  account's compromise doesn't propagate).
- Persist access past the session window — when `expires_at`
  passes the read endpoint denies, AND a lifecycle job (§ 4)
  immediately disables the password.

The blast radius is bounded by: **one provider's records,
read-only, for the remainder of the session window.** That is the
required ceiling.

---

## 2. Account creation — the provider's mint flow

### 2.1 What the provider does

From a future BusinessInfoPage "Auditor access" panel (Phase 2):

1. Provider types the auditor's state email
   (`auditor@miLEAP.gov` or similar).
2. Provider optionally types a label ("Jane Smith, MiLEAP Region 3")
   and any notes.
3. Provider optionally picks an expiry (default 24h, capped 72h —
   same as Phase 1).
4. Provider clicks **Create audit access**.
5. The page shows a ONE-TIME REVEAL of:
   - the state email
   - the generated temp password
   - the portal URL (`https://milittlecare.com/auditor/inspect?session=<id>`)
   - the expiry

   The provider copies these and hands them to the auditor
   out-of-band (paper, in-person, secure messaging — provider's
   choice). The reveal is one-time: refreshing the page or
   re-opening the session shows the email + URL but NOT the
   password (the password is only known at mint time; it's never
   stored cleartext server-side).

### 2.2 What the Edge Function does (`api/auditor-mint.js` — rewritten)

Replaces the HMAC-token mint from Phase 1. Same file path; the body
changes.

```
POST /api/auditor-mint
  Headers: Authorization: Bearer <provider JWT>
  Body: { email, expires_at?, auditor_label?, notes? }

1. Verify provider JWT (same verifyAuth pattern Phase 1 used).
2. Validate request body:
   - email: required, RFC-5322-light shape, lowercased.
   - expires_at: same 24h-default-72h-cap logic as Phase 1.
   - label / notes: same trim + length caps as Phase 1.
3. Email-uniqueness gate (the load-bearing safety):
   a. Look up auth.users by email via admin API
      (GET /auth/v1/admin/users?email=<email>).
   b. If a user exists AND their app_metadata.role != 'auditor' →
      400, "This email is already in use by a non-audit user.
      Please use a different state email for this auditor."
      (NEVER hijack a parent/provider account.)
   c. If a user exists AND their app_metadata.role = 'auditor' →
      proceed with the existing account (reuse the identity;
      rotate the password — see § 2.3).
   d. If no user exists → create one via admin API with
      app_metadata.role = 'auditor' (see § 2.3).
4. Insert auditor_sessions row:
   - provider_id   = provider.id   (validated JWT, NEVER body)
   - auditor_user_id = the (new or existing) auth.users.id
   - email_at_creation = email
   - expires_at, label, notes
5. Append 'session_created' to auditor_session_access_log.
6. Return { email, temp_password, session_id, expires_at,
            portal_url }. The portal_url is constructed by the
   PROVIDER UI from the session_id (not by this function — keeps
   the function public-host-agnostic).

The temp_password is in the response ONCE. It is NEVER stored
cleartext, NEVER logged in plaintext. Supabase auth stores its
bcrypt hash; the cleartext exists only in the HTTP response back
to the provider's authenticated browser.
```

### 2.3 Password generation — strong, system-side

Generation rule:
- 20 characters
- Charset: 26+26+10+8 = 70 (lowercase + uppercase + digits + a
  small punctuation subset that's keyboard-friendly and
  shell-safe: `!@#$%^&*`). At 70-char alphabet × 20 chars, that's
  ~123 bits of entropy — way above the bcrypt input ceiling and
  way above brute-force feasibility.
- Generated via `crypto.getRandomValues()` in the Edge Function
  (Web Crypto API, available in Vercel Edge runtime + Node 18+).
- Set on the auth.users row via admin API
  (`PUT /auth/v1/admin/users/<id>` body `{ password }`).

Password rotation on re-invite (the multi-provider case): if the
auditor's auth.users row already exists, the mint endpoint
generates a NEW password and calls the admin update. The old
password is invalidated (Supabase replaces the bcrypt hash). The
auditor uses the LATEST password to access any of their active
sessions.

**Tradeoff acknowledged:** if Provider A invites the auditor on
Monday and Provider B invites them on Wednesday, the Monday
password stops working on Wednesday. The auditor uses Wednesday's
password to access EITHER session (because each session is its
own scoped box, and the auditor's `auth.uid()` is the same in
either case; the session_id in the URL picks the scope). This is
the right behaviour — the password is the auditor's credential,
not the audit's.

`[DECISION — Seth]` — confirm 20-char length + the punctuation
subset. Could go up to 24 chars at the cost of a worse
copy/paste experience. Current recommendation: 20 chars,
keyboard-friendly.

### 2.4 The "audit identity" property — `profiles.is_audit_account`

The mint endpoint, when it creates a brand-new auth.users for an
auditor, also creates a `profiles` row for them — because
`handle_new_user()` fires on `auth.users` insert and inserts the
profiles row automatically (migration 001).

A new boolean `profiles.is_audit_account boolean not null default
false` flags these. The `handle_new_user` trigger reads
`raw_app_meta_data->>'role'` and sets `is_audit_account = true`
when the role is `'auditor'`.

This makes "is this profile an auditor identity?" answerable
without a JWT — useful for:
- The mint endpoint's email-uniqueness gate (step 3b/3c).
- A future admin UI listing all temp accounts.
- A cleanup job that wants to find orphan auditor profiles.

It's separate from the JWT's `app_metadata.role` — that's the
runtime check; this is the persistent flag.

### 2.5 Patterns mirrored

The mint endpoint reuses the verified shape of:
- **`api/consent-attachment-url.js`** — verifyAuth via Bearer JWT
  on `/auth/v1/user`. Same shape for provider auth.
- **`api/send-invitation.js`** — admin-API user lookup/create via
  `/auth/v1/admin/users`. Same shape for the auditor account
  creation.
- **`api/auditor-mint.js` (Phase 1, to be rewritten)** — the
  validation discipline (expires_at cap, label/notes
  length-bound), the 'session_created' access-log append, the
  provider-id-from-JWT-never-body invariant. Body changes; the
  surrounding boundary discipline carries.

---

## 3. Scoping — auditor → provider link

### 3.1 Where the link lives

The `auditor_sessions` row carries the link, identical to Phase 1's
schema plus three columns:

| Column | Carried from Phase 1 | New / changed |
|---|---|---|
| `id` | yes | — |
| `provider_id` | yes | — |
| `starts_at` | yes | — |
| `expires_at` | yes | — |
| `revoked_at`, `revoked_by_user_id` | yes | — |
| `auditor_label` | yes | — |
| `auditor_acknowledged_at`, `auditor_acknowledged_label` | yes | — |
| `notes` | yes | — |
| `created_at`, `updated_at` | yes | — |
| **`signing_key_version`** | yes | **DROPPED** — no HMAC anymore |
| **`auditor_user_id` uuid REFERENCES auth.users(id) ON DELETE SET NULL** | — | **NEW** — the temp account |
| **`email_at_creation` text NOT NULL** | — | **NEW** — what the provider typed (for audit) |

### 3.2 RLS resolves "this auditor account → this provider" via the Edge Function

There is no row-level RLS path that returns provider data to an
auditor JWT — the `is_auditor_jwt()` RESTRICTIVE policies foreclose
it. The Edge Function (`api/auditor-read.js`, rewritten from Phase
1) is the only data path. It:

1. Verifies the auditor JWT via `/auth/v1/user`. Get `auth.uid()`.
2. Loads the `auditor_sessions` row by `session_id`
   (passed in the request body — same pattern as Phase 1's bundle
   request).
3. Verifies the row's `auditor_user_id = auth.uid()`. This is the
   *binding* between the auditor's identity and the audit scope.
   Mismatch → 404. (Mismatch covers the case where one auditor
   tries to use another auditor's session URL.)
4. Checks `revoked_at IS NULL` and `expires_at > now()`. Either
   deny → 404 + denied log.
5. Resolves `provider_id` from the row. ONLY now does the function
   read any provider data, all scoped to that provider_id.

The Edge Function still runs as service-role, so it bypasses RLS
on the domain tables. The `is_auditor_jwt()` deny is defense-in-
depth for the case where some future caller hits PostgREST
directly with an auditor JWT.

### 3.3 The multi-provider concurrency case

One auditor (one auth.users) can have multiple active
`auditor_sessions` rows, each scoped to a different provider, all
active simultaneously. The URL's `session_id` parameter selects
which scope this request reads from. The same JWT is used for all
of them.

Property: **each (auditor_user_id, session_id) pair is unique;
session_id NEVER becomes ambiguous.** The Phase 3 SPA, after
login, reads `?session=<id>` from the URL and includes it in every
read request. If no session_id is provided, the function returns
404 (no implicit "pick the first active session" — explicit
selection only, so leaked URLs without explicit session ids can't
even probe).

`[DECISION — Seth]` — what's the UX if an auditor lands at
`/auditor/inspect` with no session in the URL but multiple active
sessions on their account? Engineering recommends: **show a
picker.** "You have audit access to the following providers; pick
one to enter." This is Phase 3 UI work, not Phase 1.

---

## 4. Expiry + revocation — hard-deny mechanism

### 4.1 The deny doesn't depend on just the Edge Function

Three layers stop a stale auditor:

| Layer | Mechanism | Latency to deny |
|---|---|---|
| 1. Edge Function check | At every read: `session.revoked_at IS NULL AND session.expires_at > now()`. | Next request |
| 2. Password disable (lifecycle job) | When `expires_at <= now()` for ALL of this auditor's sessions, OR the last active session was revoked, a background task calls admin API to set the auth.users password to a fresh random value the auditor doesn't know. The account exists for audit retention but can't log in. | ≤ 1 minute (cron interval) |
| 3. Cookie / JWT expiry | Supabase access tokens expire ~60 min and refresh against the password. Once password is rotated (layer 2), the refresh fails; the JWT effectively becomes a 60-min residual session that the Edge Function ALSO denies because of layer 1. | Up to 60 min residual; Edge Function backstop denies immediately. |

The Edge Function check is the **primary** mechanism. The
password-disable is **belt** (so an attacker who somehow obtained
the JWT mid-session can't refresh past the window). The JWT
short-TTL is **suspender** (Supabase's own session lifecycle).

### 4.2 Revocation flow

Provider opens the audit-access panel (Phase 2). Clicks **Revoke**.
The SPA calls a small Edge Function or a SECURITY DEFINER RPC
(`api/auditor-revoke.js` or `auditor_revoke_session(p_session_id)`):
1. Verify provider JWT.
2. Update `auditor_sessions SET revoked_at = now(), revoked_by_user_id
   = provider.id WHERE id = $1 AND provider_id = provider.id` —
   the provider-id-clause is the RLS-equivalent check in code
   (RLS would also enforce it).
3. If this was the auditor's last active session (no other
   non-revoked / non-expired rows reference the same
   `auditor_user_id`), call admin API to rotate the password to
   a random value. Otherwise leave the password alone (the
   auditor has other live sessions).
4. Append `session_revoked` to access log.

Next auditor read attempt → Edge Function loads the session, sees
`revoked_at IS NOT NULL`, returns 404 + denied log row with reason
`revoked`. **No UI surface "hides" the data — the data path
returns 404 at the server.**

### 4.3 Auto-expire — same shape as revocation but no SQL UPDATE

On the read path, when `expires_at <= now()` we don't need to
mutate the row to deny — the Edge Function's check is comparative.
The lifecycle job (a Vercel Cron or pg_cron, design pending) runs
every minute and:
1. Finds auth.users where ALL associated auditor_sessions are
   expired or revoked AND the auth.users still has a known
   password.
2. Calls admin API to rotate the password (one bcrypt round).
3. Optionally writes a `session_extended`-class row… actually no,
   this is an account-level state change; we don't have an
   `account_expired` event kind. The expiry is implicit in the
   row's `expires_at`; logging it would be redundant for the
   provider's view.

`[DECISION — Seth]` — where does this lifecycle job run? Options:
- **Vercel Cron job** (we already use Vercel for the Edge
  Functions; consistent infra).
- **Supabase pg_cron** (closer to the data; one less moving part
  for password admin since both happen in service-role-land).
- **No background job; on-read self-heal** (when the Edge
  Function denies an expired session, it ALSO rotates the
  password as a side effect). Avoids cron but the password
  rotation only happens if the auditor re-attempts. Trades cron
  complexity for "password might stay live for a while after
  expiry." Acceptable because the Edge Function denies regardless.

Recommendation: **Vercel Cron, hourly.** Simple. Password
rotation is belt-not-primary; an hour of slack is fine.

### 4.4 Confirming the deny is hard, not just UI-hidden

The seal must NOT be defeated by an attacker reading the SPA's
JavaScript and constructing requests directly. So:

| Surface | What an attacker with a residual JWT could try | What happens |
|---|---|---|
| `/api/auditor-read` POST | Send any session_id with valid JWT after revocation | Layer 4.1 check: 404 |
| Direct PostgREST `GET /rest/v1/<any_domain_table>` | Try `from('children').select()` with auditor JWT | RESTRICTIVE policy `NOT is_auditor_jwt()` → empty result |
| Direct storage GET on a signed URL minted earlier | Use a still-valid signed URL | Honored until 15-min TTL; **inherent limit** — not new exposure |
| `supabase.auth.signInWithPassword` to refresh | Re-login with the cached password | Password rotated by lifecycle job → 401 |
| Lateral `supabase.auth.updateUser({ data })` | Try to escalate to another role | `app_metadata` is admin-only; updateUser only touches `user_metadata`. No escalation path. |

The only nonzero residual is the 15-min signed-URL TTL on
already-minted URLs. That's the same property the parent flow has
and is acceptable; the next read can't mint new URLs.

---

## 5. Reuse vs replace — what carries from Phase 1

### 5.1 Carries forward (reuse)

| Phase 1 artifact | Reuse? | Notes |
|---|---|---|
| `supabase/migrations/042_auditor_portal.sql` | **YES, AMENDED** | Tables stay; columns adjust per § 3.1. CHECK constraints (72h cap, revoked_at after starts_at) stay. Access-log table is unchanged. RLS policies stay; RESTRICTIVE `is_auditor_jwt()` deny is added. Re-issue as migration **042 amended OR new 043 supplement** — Seth's preference. |
| `supabase/migrations/042_auditor_portal.sql` access-log schema | **YES, UNCHANGED** | `auditor_session_access_log` carries forward as-is. |
| `auditor_session_access_log` event-kind whitelist | **YES, UNCHANGED** | Existing values still apply (`read`, `denied`, `session_created`, `session_revoked`, `session_extended`, `signed_url_minted`). |
| Edge Function boundary discipline (validation, JWT verify, anti-enumeration 404, service-role REST helper) | **YES** | Pattern carries verbatim into the rewritten `api/auditor-read.js` and `api/auditor-mint.js`. |
| The 16-table bundle composition in `loadBundleForProvider` | **YES, UNCHANGED** | Same `SELECT … WHERE provider_id = <resolved>` shape on every table. Just sourced from a different validation pre-step. |
| Rate-limit pattern (count recent access-log rows) | **YES, UNCHANGED** | Same 60/min cap per session. |
| `api/auditor-read.test.js` overall structure | **PARTIALLY** | Test structure (mocked fetch, asserted no-cross-tenant fetches) carries; auth setup changes from "sign HMAC" to "construct a JWT for the auditor user." |

### 5.2 Discarded (throw away)

| Phase 1 artifact | Discard? | Why |
|---|---|---|
| `src/lib/auditorTokens.js` (HMAC sign/verify) | **YES** | No more HMAC token — Supabase JWT IS the auth. The 218 lines of crypto helpers + 37 unit tests are dead code under the new model. **Delete the file in the rebuild PR.** |
| `src/lib/auditorTokens.test.js` | **YES** | Tests for the discarded module. Delete. |
| `signing_key_version` column on `auditor_sessions` | **YES** | No HMAC key, no version. Drop the column in the amended migration. |
| `AUDITOR_TOKEN_SIGNING_KEY_V1` env var | **YES** | No longer used. Remove from Vercel env (manual; Seth). |
| The HMAC-token mint logic in `api/auditor-mint.js` (sign + return token field) | **YES** | Replaced by the password-generation + admin-API call to set the password. The mint endpoint's outer shell (JWT verify, validation, INSERT into auditor_sessions, session_created log) carries forward. |
| The HMAC-verify step at the top of `api/auditor-read.js` | **YES** | Replaced by Supabase JWT verify (consent-attachment-url pattern) + session lookup by `auditor_user_id = auth.uid()`. |

### 5.3 Net effect on the rebuild PR

The rebuild PR (call it Phase 1.5 or "Phase 1 — auth re-scope")
is a focused diff against the Phase 1 branch:
- **Delete:** `src/lib/auditorTokens.js`,
  `src/lib/auditorTokens.test.js` (-450 lines, -37 tests).
- **Substantially rewrite:** `api/auditor-mint.js` (admin-API
  user create + password generation + return), `api/auditor-read.js`
  (JWT verify path replaces HMAC verify path).
- **Update tests** accordingly. Re-run the cross-provider isolation
  test under the new auth model.
- **Amend migration 042** or add **043** to:
  - Drop `signing_key_version`.
  - Add `auditor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL`.
  - Add `email_at_creation text NOT NULL`.
  - Add `unique (auditor_user_id, expires_at)` partial-or-not
    index — the unique-active rule (`[DECISION — Seth]`: enforce
    "one active session per auditor per provider" or allow many?).
  - Add the `is_auditor_jwt()` helper function with the canonical
    revoke/grant trailer.
  - Add the RESTRICTIVE auditor-deny policy on each of the ~28
    enumerated tables.
  - Add the `profiles.is_audit_account` boolean + the
    `handle_new_user` trigger update.
- **Add:** `api/auditor-revoke.js` (or a SECURITY DEFINER RPC).
- **Add:** the lifecycle cleanup job (Vercel Cron config).

Rough size estimate: **~600 net new lines, ~450 deletions, 28 tables
touched in the migration, two new Edge surfaces.** Most of the
work is in the migration (the table-deny enumeration) and the
mint endpoint (admin API wiring).

---

## 6. The honest tradeoff vs the HMAC model

### 6.1 What's HARDER to secure with the temp account

A real authenticated account is a larger attack surface than an
opaque token:

- **Account persistence:** the auth.users row exists past the
  audit window (audit-retained). An attacker who compromises the
  password during the window has a higher-value foothold than
  someone who steals an HMAC URL. Mitigated by: layered password
  rotation (§ 4), 15-min signed-URL TTL on storage, and the
  RESTRICTIVE deny on every table (so even with the JWT, the
  attacker can only reach `/api/auditor-read`).
- **Auth lateral movement:** Supabase's `auth.updateUser`,
  `auth.signOut`, `auth.refreshSession` are all reachable by ANY
  authenticated JWT. The auditor JWT can call them. They don't
  let the attacker escalate (none of them touch app_metadata or
  cross-tenant data), but they're surface that the HMAC model
  didn't have. Verified safe by reading the Supabase API; if a
  new auth API ever exposes role-mutation, we'd be at risk.
- **Email-collision attack:** if Provider A creates an auditor
  account for `xyz@miLEAP.gov` and then a malicious user signs up
  AS `xyz@miLEAP.gov` through the normal flow, Supabase's
  email-unique guarantee prevents direct collision — but the
  ORDER matters. Mitigated by the email-uniqueness gate (§ 2.2
  step 3) which refuses to convert a non-audit account into an
  audit account.
- **Storage-URL caching:** signed URLs minted for the auditor's
  bundle live in browser history and developer tools. The 15-min
  TTL bounds this; the HMAC model had the same property for
  attachments it served.
- **Visible state-email in logs:** every read row logs the
  auditor's email-derived auth.uid(). If state emails are
  semi-public, that's not a leak; if they're semi-private, a
  successful breach of the access log reveals "this auditor
  visited these providers." This is a fact about auditor identity
  being non-anonymous in this model. Acceptable per Seth's choice
  (and matches the professional health-records model where
  auditor identity is captured by design).

### 6.2 What's EASIER

- **Identity-by-design.** The state email is captured at the
  auth layer. Every log row attributes to a real person.
- **No new crypto.** The HMAC layer is deleted. We rely on
  Supabase's password hashing + JWT signing, which is
  well-trodden.
- **Familiar UX.** Auditor signs in like every other user. No
  new "paste this token" mental model.
- **Revocation hits a known store.** Provider says revoke;
  password rotates; account is dead. No "did the token leak?"
  uncertainty.
- **Audit chain-of-custody is cleaner.** Every read traces to a
  named identity, not "whoever held this URL."

### 6.3 Net assessment

Seth chose familiarity + identity capture over surface-area
minimization. The right design choice given the regulator user.
The mitigations above are tractable — the `is_auditor_jwt()`
deny on every table is the load-bearing piece and it's a one-line
policy per table. The amended seal is auditable: one helper
function, one templated policy fragment, one Edge Function.

---

## 7. Decisions Seth needs to make (consolidated)

| # | Decision | Engineering recommendation | Reasoning |
|---|---|---|---|
| 1 | Migration shape — amend 042 or add 043? | **042 amended.** The Phase 1 PR is on a branch and unmerged; the migration was not applied. Amending the same file keeps the history simpler. | One file, one mental model. If 042 had been applied, 043 would be required. |
| 2 | Lifecycle cleanup job — Vercel Cron / pg_cron / on-read self-heal? | **Vercel Cron, hourly.** | Existing infra; simplest. |
| 3 | Password length / charset | **20 chars, alnum + `!@#$%^&*`** | 123 bits entropy, keyboard-friendly. |
| 4 | "Unique active session per (auditor, provider)" — enforce or allow many? | **Enforce.** | Provider re-inviting the same auditor should extend / replace the previous active session, not pile multiple active sessions on the same auditor-provider pair. Implementation: `unique (auditor_user_id, provider_id) where revoked_at is null and expires_at > now()` partial index. |
| 5 | Multi-active-session picker UX on `/auditor/inspect` with no session in URL | **Show picker.** | A leaked URL with no session_id can't probe; the picker requires the user to be authenticated AND to have at least one active session. |
| 6 | Storage / log of the temp password | **Never store; one-time reveal only.** | The provider sees it on mint; it's gone after. If the auditor loses it, the provider re-invites (which rotates to a new password). |
| 7 | Deny-list scope (§ 1.3 ~28 tables) — proceed with ALL tables, or limit to audit-relevant + sensitive? | **All non-Supabase-internal tables in `public` schema.** | The seal must not depend on future maintainers remembering to add the branch. One templated SQL fragment per table, one verification query confirms `pg_policies` has the branch on every table. |
| 8 | Edge Function bundle endpoint — should it accept session_id in body, header, or URL? | **Body (`{ session_id }`).** | Same shape as Phase 1's `{ token }`; the Phase 3 SPA wraps it. Body is the most explicit and least likely to leak to server logs. |
| 9 | Phase 3 SPA route — keep `/auditor/inspect?session=<id>` or change? | **Keep.** | The provider hands the auditor a URL; embedding session in the URL is natural. The query parameter (not path) keeps it changeable without route changes. |
| 10 | Verification gate — same 8-step? | **Yes, expanded.** | Add tests for: temp account email-uniqueness gate; password rotation on re-invite; revocation locks password; cross-session auditor (using session A's URL with session B's JWT) → 404; auditor JWT against domain table directly → 0 rows (RESTRICTIVE deny). |

---

## 8. Revised build sequence

(Replaces design doc § 9 phases 1-2; phases 3-5 carry.)

### Phase 1 — auth re-scope (this rebuild, single PR)

Replaces the Phase 1 already on branch `feature/auditor-portal-
phase1`. Branched off `main` (NOT off Phase 1 — clean slate is
simpler than rebasing a substantial rewrite).

**Schema (042 amended):**
- Tables: `auditor_sessions`, `auditor_session_access_log` (as in
  Phase 1).
- Drop `signing_key_version`.
- Add `auditor_user_id`, `email_at_creation`.
- Add partial unique index (decision 7.4).
- Add `is_auditor_jwt()` helper.
- Add RESTRICTIVE `NOT is_auditor_jwt()` policy on ~28 tables.
- Add `profiles.is_audit_account` + trigger update.

**Edge Functions:**
- Rewrite `api/auditor-mint.js` to admin-API + password gen.
- Rewrite `api/auditor-read.js` to JWT verify + session lookup by
  `auditor_user_id = auth.uid()`.
- Add `api/auditor-revoke.js` (or SECURITY DEFINER RPC; decision
  7.x).
- Delete `src/lib/auditorTokens.js` and its test.

**Tests:**
- Cross-provider isolation (still the headline) under the new
  auth.
- Email-uniqueness gate denials.
- Password rotation on re-invite.
- Revocation hard-deny.
- Expiry hard-deny.
- Cross-session JWT mismatch.
- RESTRICTIVE policy denies direct PostgREST reads. (Mocked DB
  here; live gate covers it on real RLS.)

**Vercel Cron config:** password-rotation lifecycle (decision 7.2).

**Halt + Seth runs:** the 042-amended migration, the 8-step live
gate (deferred to Phase 4 historically, brought partly forward
because the rewrite touches the boundary).

### Phase 2 — provider-side panel

Unchanged from design doc § 9 Phase 2. New BusinessInfoPage section.
Calls `/api/auditor-mint`. Displays the one-time password reveal.
Lists active + past sessions with per-session log expansion.

### Phase 3 — auditor-facing reading UI

New `/auditor/inspect?session=<id>` route. Sign-in page (email +
password). After login, calls `/api/auditor-read` with `{ session_id
}`. Renders the bundle into tabbed reading surface (children,
caregivers, acks, etc.).

The SPA also strictly refuses to render any non-auditor surface —
it reads the JWT's `app_metadata.role` and shows nothing else.

### Phase 4 — verification gate

Same 8-step gate from design doc § 7, expanded per decision 7.10.
Seth runs in real browser sessions as a provider + a temp auditor +
a cross-provider attacker.

### Phase 5 — merge

Only after Phase 4 evidence is in the runbook.

---

## 9. Out of scope

- Auditor self-service password reset. (Provider re-invites = new
  password.)
- Auditor signing in to MILittleCare as a parent at some other
  daycare with the same email. (Email-uniqueness gate prevents
  hijack — they have to use a different email.)
- Cross-provider auditor analytics ("how many providers has this
  auditor inspected?"). Future enhancement.
- 2FA for the auditor account. Considered; rejected because (a) the
  HMAC model didn't have it either, (b) the session window is
  short, (c) Seth's professional health-records reference doesn't
  use 2FA for this role.

---

## 10. What this doc commits to vs leaves open

**Commits to:**
- Hybrid model (B2): temp Supabase account is the auth; Edge
  Function is still the boundary.
- The RESTRICTIVE-policy-on-every-table seal via
  `is_auditor_jwt()`.
- The amended schema (drop `signing_key_version`, add
  `auditor_user_id` + `email_at_creation`, add
  `profiles.is_audit_account`).
- Password discipline: 20 chars, system-generated, one-time
  reveal, rotated on re-invite, rotated again on full-revoke.
- The blast-radius cap (§ 1.6).
- Three layers of revoke/expire enforcement (§ 4).

**Leaves open ([DECISION — Seth]):**
- Migration shape (decision 7.1).
- Lifecycle cron mechanism (decision 7.2).
- Password length specifics (decision 7.3).
- Unique-active enforcement (decision 7.4).
- Multi-session picker UX (decision 7.5).
- Revoke-endpoint shape (Edge Function vs SECURITY DEFINER RPC).
- Final deny-list scope (decision 7.7).
- Whether the 8-step gate runs against preview before merge or
  against prod after (decision 7.10).

---

*End of design document. No code, no migration, no SQL committed
in this PR. Build PR follows once Seth signs off on § 7 decisions.*
