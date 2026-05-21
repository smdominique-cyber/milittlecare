# PR #12 Review — Parent Acknowledgment via Parent Portal + Email

**Branch:** `feature/parent-acknowledgment-pr-12`
**Migrations:** `supabase/migrations/020_parent_acknowledgment.sql`
**Build sequence:** parallel with PR #9; lands after PR #8.5c migration ideally, but order-independent in practice.

## Build session status

Step 1 of 9 (the schema migration) committed in this turn. Remaining 8 steps are queued.

| Step | State |
|---|---|
| 1. Migration: schema | ✓ this commit |
| 2. Pure helpers (`computeAttendanceHash`) | queued |
| 3. Server-side Resend integration + Vercel cron | queued — depends on `resend` dep approval |
| 4. Parent portal `/parent/acknowledge` | queued |
| 5. Provider parent-ack dashboard | queued |
| 6. PR #9 Rule 8 upgrade | queued — lands on `feature/i-billing-transfer-pr-9` after PR #12 schema is live |
| 7. PR #9 T&A PDF parent-initials | queued — depends on `jspdf` approval (already pending) |
| 8. Settings UI | queued |
| 9. End-to-end smoke test | queued |

## § 5 Parent portal surface inventory

Reported as the pre-build readout; consolidated here.

- **Auth model.** Parent identity = `auth.users` row + matching `parent_profiles` row (id = auth.users.id). `AuthCallbackPage.jsx:14-45` routes by table presence — `parent_profiles` row → `/parent`, `profiles` row → `/dashboard`, fallback to `/parent`.
- **Parent route tree.** `/parent` (dashboard, landing), `/parent/family`, `/parent/messages`, `/parent/messages/:childId`. New `/parent/acknowledge` route lands in step 4.
- **Parent→family linkage.** **Not `guardians.user_id`.** The existing pattern is `parent_family_links (parent_id, family_id, status)` — used by every parent-side API path (`accept-invitation.js`, `parent-fsa-statement.js`, `confirm-autopay-enrollment.js`, `create-setup-intent.js`, `disable-autopay.js`, `notify-state-change.js`, `send-message-notification.js`) and the families page.
- **`guardians.user_id` already exists with different meaning.** Holds the **licensee's** user id (per `FamiliesPage.jsx:959`). Adding a parent-link column there would overload semantics — see "Pattern adaptations" below.
- **Notification surface — minimal.** `ParentDashboardPage.jsx:411-435` has one dismissible "set your password" banner (LocalStorage-dismissed). No general inbox. The "X days awaiting your review" banner from § 10.1 lands on `ParentDashboardPage` using the same dismissible-banner pattern.

## RLS and pattern adaptations vs. the addendum

Four places where the migration deviates from the addendum's literal spec to match milittlecare's established patterns.

### A. No `guardians.user_id` parent-link column

The addendum's § 6.4 anticipates the column might not exist and proposes adding it. Reality: it exists, holds the licensee's id. Adding a parent-link column there would overload semantics. **Decision:** skip the column add entirely. Parent eligibility joins through the existing `parent_family_links` table.

### B. Parent-side RLS uses `parent_family_links`, not `guardians.user_id`

Every parent-facing RLS policy in `020` follows this shape:

```sql
child_id in (
  select c.id from public.children c
  where c.family_id in (
    select pfl.family_id from public.parent_family_links pfl
    where pfl.parent_id = auth.uid() and pfl.status = 'active'
  )
)
```

This matches the existing `api/accept-invitation.js` / `api/notify-state-change.js` joins.

### C. `acknowledged_by_guardian_id` is nullable for `parent_portal` acknowledgments

The addendum's § 6.1 CHECK required `acknowledged_by_guardian_id` NOT NULL for `parent_portal` acks. But a `parent_profiles` row isn't tied to a single `guardians` row — they're separate concepts (parents register via invite, guardians are provider-maintained contacts). The migration relaxes the CHECK: `acknowledged_by_user_id` is the authoritative parent identifier; `acknowledged_by_guardian_id` is populated by an app-layer email-match lookup when one exists, left NULL otherwise. The `provider_override` branch still requires it to be NULL and `acknowledged_by_user_id` to be the provider's id.

### D. Scheduling: Vercel cron + Vercel API route, not pg_cron + Edge Function

The addendum recommends a Supabase Edge Function triggered by `pg_cron`. The existing milittlecare pattern is Vercel cron + Vercel API serverless function — see `vercel.json` (`/api/cron-charge-autopay`, `/api/cron-generate-autopay-invoices`) and `api/cron-*.js`. No Edge Function in the codebase today; `pg_cron` not used in any committed migration. **Decision:** match the existing pattern. Step 3 creates `api/cron-send-acknowledgment-digest.js` and adds a `vercel.json` schedule entry. The `resend` npm package gets called server-side from there; `RESEND_API_KEY` lives in Vercel env (mirroring `STRIPE_SECRET_KEY` etc.).

## § 8 Resend setup — required human steps

Documenting per addendum § 14 ("Resend setup steps completed"). All five are dashboard / human-side tasks; the build cannot do them.

1. **Create Resend account** and get an API key.
2. **Verify sending domain.** Suggest `milittlecare.com`. Requires SPF, DKIM, and DMARC DNS records at the domain registrar.
3. **Add `RESEND_API_KEY` to Vercel env** (Production + Preview). Optional: also add to Supabase Secrets if any read happens server-side outside Vercel — not needed for the chosen architecture.
4. **Choose and confirm a `From` address.** Default proposal: `hours@milittlecare.com`. Friendly name `MI Little Care`. Flag for human approval before first send.
5. **Test send to a known address.** The cron job is structured to be a no-op when `RESEND_API_KEY` is absent (mirroring `api/create-checkout-session.js:16`), so the code can land before the API key is configured and the cron will simply log "Resend not configured" until step 3 is done.

## § 11 Edge cases — handled in the migration

The migration's structure covers several § 11 cases up front:

- **Parent has no email on file.** `parent_profiles.email` is nullable in the existing schema (per prior session); the cron job will skip parents without an email and surface "Parent for {child} has no email" via the provider dashboard query.
- **Multiple guardians per family.** The unique index `attendance_acknowledgments_unique_active` on `(child_id, date, segment_index) WHERE archived_at IS NULL` enforces "one acknowledgment per day wins."
- **Guardian removed mid-period.** `acknowledged_by_guardian_id` is `ON DELETE SET NULL`; the acknowledgment row survives audit retention. `attendance_id` similarly `ON DELETE SET NULL` on `acknowledgment_flags`.
- **Provider deletes a child mid-acknowledgment-cycle.** `child_id` is `ON DELETE CASCADE` on both new tables. Audit history follows the child; if the provider deletes the child the audit also clears (matches existing `children` deletion behavior in `FamiliesPage.jsx:799`).
- **Provider edits attendance after acknowledgment.** Captured by `attendance_snapshot_hash` (computed in step 2's pure helper); not a DB enforcement, runs in PR #9 Rule 8 (step 6).

Remaining § 11 cases (DST transitions, Resend failure retry, daily-no-attendance suppression, parent-flags-everything pathology) land in step 3's cron logic and step 4's UI.

## PR #9 ↔ PR #12 coupling

- **Rule 8 upgrade (§ 9.1)** — lands as a follow-up commit on `feature/i-billing-transfer-pr-9` AFTER PR #12 schema migrates to production. Until then, PR #9's current Rule 8 (single provider-level warning) is correct — the data to consume doesn't exist yet.
- **T&A PDF parent-initials (§ 9.2)** — already parked on PR #9 pending `jspdf` dep approval. When that approval lands and PDF templates are built, the parent-initials column reads from `attendance_acknowledgments`.

## Dependency requests

- **`resend` npm package** — needed for step 3. Per `CLAUDE.md` § Build Discipline, requires explicit approval before `npm install`. Flagging at the step 3 boundary.

## Pending review-doc sections (populated as the build progresses)

- Hash function chosen and rationale (step 2)
- From-address used for Resend sends (step 3 after approval)
- T&A PDF visual marker decisions — what "OVR" looks like (step 7)
- Whether daily-cadence was tested end-to-end or only weekly (step 9)
- Smoke test results — § 12 step 9 walkthrough

## Migration ordering recap

Migrations on `main` go through `015`. PR #8.5a/b/c/9 commit migrations `016`/`017`/`018`/`019` on their respective branches. PR #12's migration is **`020`**. All are additive and order-independent with each other (each touches distinct objects); apply-order at the dashboard is the runbook's call.
