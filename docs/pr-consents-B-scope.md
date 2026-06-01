# PR Scope — Consents Phase B: Time-Bound Recurring Consents

**Date:** 2026-06-01
**Status:** Scope — **FINAL, ready for build** (both Phase B consents
unified on annual expiry; no remaining blocks).
**Branch (suggested):** `feature/consents-b-recurring`
**Builds on:** Phase A (`photo_sharing_consent` + `field_trip_permission`
shipped 2026-05-30), the shared `pendingEnrollmentConsentsForChild`
verdict, the `PARENT_SIGNED_SATISFYING_CHANNELS` constant, the
`acknowledgments` polymorphic table from migration 024, and the parity
refactor that gave us a single resolver for the parent-banner +
provider-audit reads.

---

## Summary

Phase B adds the **expiry dimension** the engine doesn't have today.
Routine transportation and on-premises water activities are durable
in the same shape as a Phase A consent — one active row per
(provider, type, child) — but they go STALE on a schedule the engine
cannot currently express. Both Phase B types use the **same** cadence:
**`expires_at = acknowledged_at + 1 year`, rolling.** Renewal resets
the clock. One mechanism, one predicate, one renewal protocol covers
both. The schema change is one nullable `expires_at timestamptz`
column on `acknowledgments` plus an expiry-aware read predicate.
Every existing consent leaves the column NULL and is unaffected
(purely additive, zero backward-compat risk). Renewal reuses Phase
A's archive-then-insert protocol. The migration is one `ALTER TABLE
ADD COLUMN IF NOT EXISTS`; no constraints altered, no rows mutated,
no policies touched.

What this scope does NOT do: ship the per-occurrence (Phase C)
shape; redesign photo consent into a three-state model; ship the
expiring-soon reminder category (fast-follow on top of the audit-
state field this PR delivers); ship a parent-portal renewal RPC.

---

## DECISIONS — RESOLVED

Every choice this scope previously held open is now locked. Summary
table; each is folded into the design body that follows.

| # | Decision | Resolution |
|---|---|---|
| 1 | Column name | **`expires_at timestamptz`, nullable.** Matches the table's `_at` suffix convention. |
| 2 | Cadence anchor for routine transport | **`acknowledged_at + 1 year`, rolling.** Basis: R 400.1952(1)(a) "at least annually"; parallel center rule R 400.8149(1) confirms "annually for routine transportation." |
| 3 | Cadence anchor for on-premises water | **`acknowledged_at + 1 year`, rolling — same as transport.** Basis: R 400.1934(10)(b) "once per season." "Season" is undefined anywhere in the Michigan child-care rules; Michigan has effectively one on-premises water-activity season per year (warm months), so a **provider-adopted operating interpretation** maps "once per season" → once annually, renewed each spring ahead of the season. This is the single knob that changes if a licensing consultant later defines "season" otherwise. |
| 4 | "Routine" vs "nonroutine" boundary | **R 400.1901(1)(jj):** "regularly scheduled travel on the same day of the week, at the same time, to the same destination. Any deviation is nonroutine transportation." The "any deviation" clause is the Phase B / Phase C boundary — routine = annual blanket (Phase B); any deviation = per-trip (Phase C). |
| 5 | Renewal reminder timing | **Fast-follow, OUT of Phase B core.** Phase B core delivers the data model — consent correctly lapses at `expires_at`. Reminders ride on top via PR #15's opt-in system: transportation's reminder fires ahead of its own `expires_at`; water's reminder is timed to spring, ahead of the season, so the renewal is fresh going into the months it's used. |
| 6 | Resolver consolidation | **IN scope for this PR.** Fold `ParentEnrollmentConsentsPanel`'s inline `PhotoStatusRow` / `StatusRow` onto the shared resolver. Tight scope: consolidate reads + add the expiry-aware predicate; do not redesign the resolver interface beyond the new expired-state field (decision 10). Without this, the parent panel would show expired consents as on-file indefinitely — a correctness defect. |
| 7 | ACK_TYPES names | **`transportation_routine_annual`** and **`water_activities_on_premises_seasonal`**. Wordy on purpose — clean grep + clean distinction from Phase C siblings (`_nonroutine_per_trip`, `_off_premises_per_trip`). |
| 8 | Early renewal | **Archive prior row immediately + insert new** — same archive-then-insert protocol as Phase A re-acknowledgment. No coexistence period. |
| 9 | Renewal flow placement | **Provider modal action only for Phase B.** Parent-portal renewal RPC deferred — entangled with the parked provider-attestation consultant question. |
| 10 | Index strategy | **No new index initially.** The audit predicate references `now()`, which can't appear in a partial-index `WHERE`. Rely on existing `acknowledgments_provider_active` partial index + cheap post-index filter on `expires_at`. Revisit when query volume justifies. |
| 11 | Audit-state typedef | **New field `enrollment_consents_expired`** on `pendingEnrollmentConsentsForChild`'s return shape. Don't fold expired rows into the existing `_pending` arrays — preserves "pending = never captured" and gives PR #22's compliance score a separately-weightable signal. |
| 12 | "On file" satisfies via electronic capture | **Yes.** Basis: R 400.1901(1)(cc) defines "on file" as accessible at the home via hard copy OR electronically. Electronic capture via the acknowledgments engine satisfies the requirement for both Phase B consents. |

---

## The audit-read predicate (single canonical statement)

A Phase B consent is **currently satisfied** for `(child, type)` when:

> there is an **active** row (`archived_at IS NULL`) under a
> **satisfying channel** (`acknowledged_via IN
> PARENT_SIGNED_SATISFYING_CHANNELS`) for that `(child, type)`,
> **AND** (`expires_at IS NULL` **OR** `expires_at > now()`).

State transitions made explicit:

| Row state | `archived_at` | `expires_at` vs `now()` | Treatment |
|---|---|---|---|
| Newly captured, in window | NULL | `> now()` | Satisfied. |
| Phase A durable (no expiry) | NULL | NULL | Satisfied (NULL-safe predicate). |
| Expired but not yet renewed | NULL | `<= now()` | **NOT satisfied.** Audit reports as `enrollment_consents_expired`, NOT as `_pending`. The unique partial index still considers the row "active," which is why renewal MUST archive it before inserting the new row (see §9 renewal protocol). |
| Renewed (the prior row) | `now()` | (any) | Excluded from active reads. Audit-trail accessible via archived rows. |
| Renewed (the new row) | NULL | `> now()` | Satisfied. |

The predicate lives in the **caller's Supabase query**, not in the
pure verdict function. The verdict function stays deterministic
(no `now()` reference), so test fixtures don't need wall-clock
mocking; callers filter expired rows out before passing
`activeAcks` to the verdict.

---

## Why this is Phase B (and what's still deferred)

The consents roadmap splits seven needs across three PRs by **data
shape**, not by topic. Phase A shipped the shape the engine already
supported: sign-once, durable, optionally revocable. Phase B is the
shape one step away: still durable, still per-(type, child), but
**stale on a schedule** the engine doesn't currently express.

**Phase B (THIS PR) — time-bound recurring (annual):**
- Routine transportation baseline (R 400.1952(1)(a), "at least
  annually").
- On-premises water activities (R 400.1934(10)(b), "once per
  season" → interpreted as once annually; see decision 3).

Both use the same expiry mechanism: one nullable `expires_at`
column, set to `acknowledged_at + 1 year` on write, with an
expiry-aware read predicate.

**Phase C (still DEFERRED — separate PR) — per-occurrence:**
- Non-routine transportation (R 400.1901(1)(jj) "any deviation" from
  routine — applies trip-by-trip).
- Off-premises water (R 400.1934(10), "before each").
- Medication (R 400.1931(2), per-medication).
- Needs a per-occurrence dimension the
  `acknowledgments_active_unique` partial index actively blocks
  (silent-data-loss bug if attempted in the current shape — see
  Phase A scope, lines 31–38). §9-NonForeclosure below confirms
  Phase B's column addition does NOT foreclose any of Phase C's
  three candidate models.

**Provider's lived experience (unchanged):** Venessa handles all of
these manually on paper today. Phase B ADDS digital capture +
expiry tracking where paper currently rots in a binder. Nothing is
broken; paper keeps working while B and C are built right.

---

## The two consents in this PR

### 1. Routine transportation baseline — `transportation_routine_annual`

- **Rule:** R 400.1952(1)(a) — written permission "at least
  annually" for routine transportation. Parallel center rule
  R 400.8149(1) confirms "annually for routine transportation,"
  cross-citing the same cadence.
- **Boundary with Phase C:** R 400.1901(1)(jj) — "routine
  transportation" is *regularly scheduled travel on the same day of
  the week, at the same time, to the same destination. Any
  deviation is nonroutine transportation.* The annual blanket
  consent (Phase B) covers the routine pattern; **any deviation**
  triggers per-trip consent (Phase C).
- **Shape:** sign-once, valid for one rolling year from
  `acknowledged_at`. Parent-signed (only `parent_portal` /
  `in_person_paper` satisfy; `provider_override` alone does not —
  same channel rule as every other licensing-required consent).
- **Classification:** LICENSING-REQUIRED (MiLEAP can ask for it).
  Same tier as `field_trip_permission`.
- **Renewal:** one active row per child; renewal archives the prior
  row and inserts a fresh one with a new `expires_at`.
- **Electronic capture is compliant:** R 400.1901(1)(cc) defines
  "on file" as available at the home via hard copy OR electronic
  means; the acknowledgments table satisfies the regulatory "on
  file" requirement.

### 2. On-premises water activities seasonal — `water_activities_on_premises_seasonal`

- **Rule:** R 400.1934(10)(b) — written permission "once per season"
  for on-premises water activities.
- **"Season" is undefined.** No section of the Michigan child-care
  rules defines "season" — there is no definitions section entry,
  no enumerated calendar, no guidance document in the repo. This is
  a regulatory gap.
- **Provider-adopted operating interpretation (decision 3):**
  Michigan has effectively one on-premises water-activity season
  per year (the warm months). Therefore "once per season" maps to
  **once annually**, with renewal timed each spring ahead of the
  season so the consent is fresh going into the months it's used.
  This is the **single knob that changes** if a licensing
  consultant later defines "season" differently — the column shape
  and read predicate are unchanged either way; only the renewal
  cadence and the spring-timed reminder shift.
- **Shape:** identical to transportation routine annual — one rolling
  year from `acknowledged_at`, parent-signed channel rule, one
  active row per child, renewal archives + inserts.
- **Classification:** LICENSING-REQUIRED.

### Why unify on one annual mechanism

Both consents have the same row-shape, the same renewal protocol,
the same read predicate, the same audit-state semantics. The two
ACK_TYPES strings distinguish them in the catalog; everything else
is one mechanism. This also means a single renewal reminder rule
("fire N days before `expires_at`") works for both — only the
*timing* differs (transport: ahead of its own expiry; water: timed
to spring), and that timing is the reminder system's concern, not
the data model's.

---

## Classification note for the compliance score (PR #22)

Both Phase B types are licensing-required — same tier as
`field_trip_permission`. They sit under the
`enrollment_consents_pending` audit-state bucket for the
"never captured" state and the new `enrollment_consents_expired`
field for the "captured but lapsed" state.

**Scoring guidance for #22** (proposed, not locked here):
- An expired licensing-required consent is **as severe as
  never-captured** for compliance risk (the provider is currently
  out of compliance either way).
- The UI should render the two states distinctly — "expired on
  YYYY-MM-DD — renew now" vs "not on file yet" — because the
  remediation copy differs.
- #22 owns the final weighting decision; Phase B owns the
  separately-queryable signal.

---

## §6. The expiry mechanism — locked decision + rejected alternatives

### Locked

Add a single nullable column:

```
expires_at  timestamptz  NULL
```

- **Name:** `expires_at` (decision 1). Matches the table's `_at`
  suffix convention.
- **Nullable:** every existing row and every Phase A type leaves
  it NULL. NULL means "no expiry — durable until manually re-acked
  or revoked," which is the current behavior for all 12 existing
  ACK_TYPES.
- **Type:** `timestamptz`, same as every other temporal column on
  the table. Moment-of-day semantics matter ("expired at the end
  of YYYY-MM-DD" vs "expired at midnight of the next day"); a
  `date` column would be ambiguous.
- **No default.** Inserting a row without specifying `expires_at`
  produces NULL — the existing-behavior path.
- **No CHECK constraint.** The cadence (how `expires_at` is computed
  on write) lives in the application, not the DB — same pattern as
  the free-text `type` column. A future tightening (e.g., "this type
  MUST have a non-null `expires_at`") is a follow-up.
- **Write rule for Phase B types:** the application sets
  `expires_at = acknowledged_at + interval '1 year'` for both
  `transportation_routine_annual` and
  `water_activities_on_premises_seasonal`. No anchor branching;
  one rule.

### Why this beats the three alternatives the findings doc raised

The findings doc (§5c) listed four candidate mechanisms. Each is
rejected with the specific failure mode that disqualifies it.

#### Rejected: **read-time computation from `acknowledged_at + N`**

> "Computed from `acknowledged_at + N` at read time?"

The cadence interval (`N`) would live in code — a map from `type` →
`days_valid`. Three failure modes:

1. **Rule changes ripple through deploys.** If MiLEAP changes the
   transport cadence from annual to biennial, every existing row's
   effective expiry shifts retroactively. A consent the provider
   signed under "good for one year" suddenly becomes "good for two."
   The DB has no record of the interval that applied at sign-time.
2. **No way to grant a non-default validity.** Conditional licensure
   sometimes grants a shorter consent window (a parent who recently
   moved gets a 6-month transport consent pending address
   verification). With computed expiry, there's no row-level place
   to record "this specific consent expires earlier."
3. **Audit-trail loss.** "Was this consent valid on 2026-08-15?"
   requires reconstructing what the cadence code said on that date.
   Git history exists but is not query-able. With `expires_at` on
   the row, the answer is one SELECT.

#### Rejected: **type-string rotation** (`transportation_annual_2026`)

> "Encoded in the `type` string itself."

The ACK_TYPES catalog would grow linearly with calendar years. Four
failure modes:

1. **`PARENT_SIGNED_TYPES` and `ENROLLMENT_CONSENT_TYPES` would
   need per-year enumeration or prefix/regex matching.** Every
   January, someone has to remember to add the new strings to four
   different constants. Prefix matching makes the constants opaque.
2. **"Renewed early" or "renewed late" cases break.** A parent who
   renews on 2026-11-15 for the 2027 year writes which type?
   `_2026` (which conflicts with the active row) or `_2027` (whose
   `acknowledged_at` is in 2026)?
3. **Calendar-year boundary doesn't match the rolling anchor
   semantics decisions 2 + 3 lock.** Decisions 2 + 3 anchor on
   `acknowledged_at + 1 year`, not on calendar boundaries; a
   type-string rotation would force calendar-year semantics that
   conflict with the locked design.
4. **The compliance score (#22) has to scan every per-year string
   to know if the type family applies.** Brittle and grep-hostile.

#### Rejected: **separate `consent_validity` table**

> "A separate `consent_validity` table?"

A new table referenced by FK from `acknowledgments`. Three failure
modes:

1. **Every read needs a JOIN.** The current
   `acknowledgments_provider_active` partial index works for
   non-expiring reads; for expiring types every audit query becomes
   `acknowledgments JOIN consent_validity`. The hot-path audit
   helper would degrade.
2. **Soft-delete semantics get harder.** Does archiving the consent
   ack also archive its validity row? If yes, you maintain two
   `archived_at` columns and a synchronization rule. If no, orphan
   validity rows accumulate.
3. **The partial unique index breaks.** Today
   `acknowledgments_active_unique` enforces "one active row per
   (provider, type, subject_type, subject_id)." With validity in a
   separate table, "active" means "ack-archived-at IS NULL AND
   joined-validity-not-expired" — a predicate the partial index
   cannot express. The constraint either weakens or moves to
   application code (a regression on integrity).

### Why one column on the existing table beats all three

- Zero JOIN cost on the hot path.
- The rule's interval at sign-time is preserved verbatim on the row
  (no "what did the code say on date X").
- The constraint surface (`acknowledgments_active_unique` partial
  unique) does not need to change. Renewal still goes through the
  archive-then-insert protocol Phase A established.
- One additive schema change, no constraint alterations, no row
  mutations.

---

## §7. Cadence — locked + the source-of-truth note

### The locked cadence (decision 2 + 3)

Both Phase B types use:

```
expires_at = acknowledged_at + interval '1 year'
```

- **Rolling**, not calendar-anchored. A consent signed on
  2026-06-15 expires 2027-06-15.
- **Renewal resets the clock.** A renewal on 2027-05-20 (early)
  produces a new row with `expires_at = 2028-05-20`.
- **No grace period encoded in the data model.** If the rule text
  later turns out to specify a buffer, the audit-state UI can
  surface it (e.g., "expires in 7 days") without changing the
  column.
- **No anchor branching.** Both types use the same formula. The
  application's write path for either type does the same
  computation.

### Why this lock is safe

- **R 400.1952(1)(a)** says "at least annually" — a one-year rolling
  validity satisfies "at least annually" definitionally. (A
  calendar-year anchor would *also* satisfy it; rolling is the more
  conservative reading because every consent gets the full
  promised year regardless of when in the calendar it was signed.)
- **R 400.8149(1)** (parallel center rule, "annually for routine
  transportation") confirms the cadence verb without specifying an
  anchor — rolling is consistent.
- **R 400.1934(10)(b)** says "once per season" — "season" is
  undefined in the rules. The provider-adopted interpretation
  ("once annually, renewed each spring ahead of the season") is
  the operating decision; it's consistent with one rolling year
  from `acknowledged_at` as long as the renewal is initiated
  before the next water season opens. The renewal-reminder timing
  (decision 5) handles the "spring" framing on top of the data
  model.

### What can still change without a migration

If a licensing consultant later defines "season" differently (e.g.,
calendar-quarter, or astronomical, or Michigan-specific) the
**data model is unaffected**. Only two things change:
- The renewal-reminder timing (a configuration in PR #15's reminder
  system, not the data model).
- The application copy / help text on the modal ("water consent
  must be renewed by [season-start date]").

The `expires_at` column, the read predicate, the renewal protocol,
and the audit-state field stay the same.

### What would change with a migration (named so we'd know)

- A per-type non-NULL CHECK on `expires_at` (currently rejected;
  see §6).
- A separate per-season anchor column (e.g.,
  `acknowledgments.season_year integer`) if the consultant
  decided "season" must be a structured field rather than a copy
  detail. Out of Phase B; would be a follow-up if needed.

### Source-of-truth note for future maintainers

The rule text for R 400.1952(1)(a), R 400.8149(1),
R 400.1934(10)(b), R 400.1901(1)(jj), and R 400.1901(1)(cc) is the
basis for this PR's cadence decisions. The verbatim text was
confirmed by Seth's read of the rule PDF; the repo carries
paraphrased citations in `docs/milittlecare-roadmap-2026-05-29.md`,
not verbatim text. Future maintainers revisiting cadence should
re-read the rules; "season" remains undefined and is the most
likely source of future change.

---

## §8. Backward compatibility + read-surface enumeration

### Backward-compat invariant

**Every consent shipped before Phase B is unaffected by Phase B.**

Concretely:
- Every existing row in `acknowledgments` leaves `expires_at = NULL`.
- The Phase A consents (`field_trip_permission`,
  `photo_sharing_consent`, `photo_sharing_consent_revoked`) leave
  `expires_at = NULL`. They remain durable-until-manually-re-acked
  or revoked, same as today.
- Every existing INSERT path does not write `expires_at`. Default
  NULL. No code change required for paths that don't care about
  expiry.
- The audit-read predicate is **NULL-safe**: `expires_at IS NULL OR
  expires_at > now()` evaluates to TRUE for every existing row. A
  read that doesn't apply the predicate (i.e., old code paths that
  only filter on `archived_at IS NULL`) still works correctly,
  because no existing row has a non-NULL `expires_at` to filter.

### Read surfaces — enumeration

Today's earlier read-only gather identified the consent-read
surfaces. For Phase B, every surface that reads acknowledgments for
a licensing-required-consent purpose needs the expiry-aware
predicate. For surfaces that don't read time-bound types, the
predicate is a no-op (safe to apply anyway).

Decision 6 (resolver consolidation) is IN scope for this PR. The
table reflects that.

| # | Surface | File | Today's read | Phase B change |
|---|---|---|---|---|
| 1 | Provider audit helper | `src/lib/childFiles.js` `getChildFilesAuditState` | `archived_at IS NULL` | Add `(expires_at IS NULL OR expires_at > now())` to the caller's Supabase query. |
| 2 | Provider banner verdict (shared, pure) | `src/lib/childFiles.js` `pendingEnrollmentConsentsForChild` | Pure — caller filters | Verdict function unchanged. Caller updates the Supabase query. New return field `enrollment_consents_expired` per decision 11. |
| 3 | Messaging photo-consent reminder | `src/pages/MessageThreadPage.jsx` `loadPhotoConsentReminderState` | `archived_at IS NULL` | Add the predicate for defense-in-depth (photo consent has no expiry; predicate is a no-op for those rows but consistent across all reads). |
| 4 | Parent dashboard banner | `src/components/parent/EnrollmentConsentsPendingBanner.jsx` | Calls shared resolver | Caller updates the Supabase query (parallel to surface #2). |
| 5 | Parent Consents tab | `src/pages/ParentEnrollmentConsentsPanel.jsx` `PhotoStatusRow` + `StatusRow` (inline) | `archived_at IS NULL` + inline `pickActive` | **Consolidate onto the shared resolver** (decision 6). Drop the inline `pickActive`. Render expired distinctly from on-file and from never-captured. |
| 6 | Provider enrollment-consents modal | `src/components/families/EnrollmentConsentsModal.jsx` | Reads existing acks to populate the modal | Add the predicate. Show "expired, needs renewal" distinctly from "on file." Renewal action archives + inserts (see §9). |

### Resolver consolidation — what the change actually is

Surface #5 today implements three states inline via
`pickActive(acks, type)` + `pickActive(acks, REVOCATION_PAIRS[type])`
with no channel rule. The consolidation:

1. Replace `pickActive` calls with a single call to the shared
   resolver, passing the child's active acks (already filtered by
   the new expiry predicate at fetch time).
2. The resolver's return shape grows by one field
   (`enrollment_consents_expired`) — same set of strings as the
   existing `enrollment_consents_pending`, but capturing the
   "lapsed" state. `any_pending` stays true when either is non-empty
   (compliance gap either way).
3. The panel renders four states per row (instead of three):
   on-file, revoked-or-recorded-as-no (photo only), **expired**, or
   not-on-file. The first three already have render paths; expired
   is new and reuses the not-on-file's "needs action" treatment with
   different copy ("expired on YYYY-MM-DD — needs renewal").

**Scope discipline:** consolidate the reads + add the expiry-aware
predicate + add the new resolver field. Do not redesign the
resolver interface beyond these additions. The Phase A
`pendingEnrollmentConsentsForChild` signature and call sites stay
otherwise unchanged.

---

## §9. Renewal semantics + the two-row protocol

### The two-row protocol from Phase A, recapped

For **revocable** consents (only `photo_sharing_consent` today), the
established mechanic is: insert a paired `_revoked` row, not archive
the affirmative. Both rows coexist; the verdict function reads the
`_revoked` row to detect "preference recorded as no."

That's a *different* mechanic than renewal. Phase B introduces the
renewal counterpart.

### The Phase B renewal protocol (decision 8)

For **time-bound** consents (`transportation_routine_annual`,
`water_activities_on_premises_seasonal`), renewal = **archive prior
+ insert new**. Same shape as the existing intake re-acknowledgment
flow (`intake_confirm_for_parent` archives prior rows by
`(provider, child, type)` before inserting).

**Early renewal also archives the prior row immediately** — no
coexistence period. If a provider renews on 2027-05-20 a consent
with `expires_at = 2027-06-15`, the prior row is archived at
2027-05-20 and the new row's `expires_at = 2028-05-20`. The 26
not-yet-expired days on the prior row are forfeit; the parent
re-signed and the clock resets.

### Exact row transitions

| Event | Row A (the prior consent) | Row B (the new consent) | Constraint check |
|---|---|---|---|
| Initial consent | inserted; `archived_at = NULL`, `expires_at = acknowledged_at + 1y` | — | `acknowledgments_active_unique` satisfied (1 active row). |
| Expires (wall-clock crosses `expires_at`) | unchanged; `archived_at` still NULL | — | Unique index still considers Row A "active" (its WHERE has no `expires_at` reference). Audit read excludes it via the expiry predicate; the row reports as `enrollment_consents_expired`. |
| Renewal (whether early, at-expiry, or after) | `archived_at = now()`, `expires_at` unchanged | inserted; `archived_at = NULL`, `expires_at = now() + 1y` | Archive of A precedes insert of B in the same transaction; unique index satisfied between the two steps. |

### The expired-but-not-archived state — why it matters

This is the state the read predicate handles but the unique index
does not. Restating explicitly:

- Row A's `archived_at` IS NULL.
- Row A's `expires_at <= now()`.
- The unique partial index `acknowledgments_active_unique`
  considers Row A "active" (its WHERE clause is
  `archived_at IS NULL AND subject_id IS NOT NULL`, no reference to
  `expires_at`).
- A new INSERT of Row B with the same `(provider, type,
  subject_type, subject_id)` VIOLATES the unique constraint until
  Row A is archived.

**Implication:** the renewal flow MUST archive Row A before
inserting Row B, in the same transaction. The provider modal
(decision 9 — modal only for Phase B) implements this in JS
against the existing RLS policies (provider has UPDATE +
INSERT under their own `provider_id`).

### Audit-state typedef change (decision 11)

Today `pendingEnrollmentConsentsForChild` returns:
```
{
  enrollment_consents_pending:           string[],
  provider_protective_consents_pending:  string[],
  any_pending:                           boolean,
}
```

Phase B's return shape grows by one field:
```
{
  enrollment_consents_pending:           string[],   // never captured
  enrollment_consents_expired:           string[],   // captured but past expires_at
  provider_protective_consents_pending:  string[],
  any_pending:                           boolean,    // pending OR expired
}
```

- `any_pending` includes the expired state — both are a compliance
  gap.
- `enrollment_consents_expired` is empty for Phase A types (no
  `expires_at` set, predicate never fires).
- PR #22's compliance score consumes both fields and weights
  them per its own contract (likely equal severity for
  licensing-required types; the distinction is for UI render and
  remediation copy).

---

## §10. Migration sketch (planning level, NOT SQL)

A planning sketch only. The migration itself gets written in the
build PR.

### File

`supabase/migrations/026_acknowledgments_expires_at.sql` (next
sequential number after 025).

### Contents at a high level

1. **Header comment** matching the style of migration 024:
   - Authoritative scope: this doc.
   - Dependency: applies after migration 025
     (`intake_confirm_for_parent_rpc`).
   - Design decisions: locked cadence (`acknowledged_at + 1 year`,
     rolling, both types); expiry mechanism rationale;
     backward-compat invariant.
   - Expected verification queries (info schema + audit-state
     smoke test).

2. **The ALTER:**
   ```
   ALTER TABLE public.acknowledgments
     ADD COLUMN IF NOT EXISTS expires_at timestamptz;
   ```
   That's the entire schema change. No CHECK, no default, no
   constraint alteration.

3. **No data backfill.** Existing rows leave `expires_at` NULL.

4. **No policy changes.** RLS already gates on `provider_id` /
   `parent_family_links`; `expires_at` is just another column under
   the existing policies' SELECT shape.

5. **No constraint changes.** The partial unique index
   `acknowledgments_active_unique` keeps its WHERE clause exactly
   as migration 024 defined it. Renewal handles expiry through
   archive-then-insert, not through a relaxed unique.

6. **No new index** (decision 10). Rely on the existing
   `acknowledgments_provider_active` partial index (which filters
   on `archived_at IS NULL`) to narrow rows; the post-index
   timestamp filter for `expires_at > now()` is cheap on the
   already-narrow set. A helper partial index would have to be
   `WHERE archived_at IS NULL AND expires_at IS NOT NULL` (the
   `now()` reference cannot appear in a partial index); it's
   deferred until query volume justifies and revisited in a
   future migration.

7. **Forward-only + additive.** No DROP, no ALTER COLUMN TYPE, no
   NOT NULL change. The down migration (commented at the file
   bottom per the migration 024 pattern) is simply
   `ALTER TABLE public.acknowledgments DROP COLUMN IF EXISTS
   expires_at;` — non-destructive to existing rows on every other
   column.

8. **Runbook entry** per `CLAUDE.md`'s same-PR documentation
   discipline: what it does, dependency on 025, verification SQL,
   rollback steps.

---

## §9-NonForeclosure. Phase C is not foreclosed by this column

The findings doc (§5d) enumerated three candidate shapes for
Phase C's per-occurrence dimension:

> (a) a new `trips` table the consent rows reference, (b) trip
> metadata in the `payload` / `snapshot_hash`, with `subject_id`
> still = `child_id`, or (c) a different table entirely outside
> `acknowledgments`.

Confirming each is still open after Phase B:

- **Option (a) — new `trips` table referenced by
  `subject_type='trip'` / `subject_id=<trip_id>`:** Phase B's
  `expires_at` column is per-row, type-agnostic. A per-trip consent
  with `subject_type='trip'` could either leave `expires_at = NULL`
  (one-and-done at trip time) or set it to the trip's end-of-day
  (consent valid through the trip's date). Orthogonal.
- **Option (b) — trip metadata in payload with
  `subject_id=child_id`:** the `expires_at` column doesn't touch
  payload semantics. The unique-index conflict Phase C must
  resolve (multiple active rows per (type, child)) is unchanged
  by Phase B — Phase B introduces no new uniqueness; the existing
  partial unique stays as-is. Phase C still needs its own
  solution for the uniqueness conflict, which is the same
  solution it needed before Phase B.
- **Option (c) — a different table outside `acknowledgments`:**
  Phase B touches only `acknowledgments`. A new sibling table for
  Phase C doesn't conflict with a column added here.

**The point of doing B first** is that its migration is small,
purely additive, and orthogonal to every Phase C question. Phase B
ships expiry capability into the engine; Phase C inherits it
unchanged (and unblocked) when it picks its per-occurrence shape.

---

## §11. UX — where renewals happen

### Provider side

- The existing `EnrollmentConsentsModal` (Phase A) is the host.
  Add the two new types to its capture flow.
- For each Phase B type, the modal shows:
  - **On file**: shows the captured channel and the renewal date
    (`expires_at`, formatted).
  - **Expired**: shows the original capture date AND the expiry
    date; the action button reads "Renew" (instead of "Capture")
    and the modal collects a fresh signature/channel.
  - **Not on file**: same as Phase A — "Capture" action.
- Renewal action implements archive-then-insert atomically in the
  modal (decision 8): archive prior row's `archived_at`, then
  insert the new row with `expires_at = now() + 1 year`.

### Parent side

- The existing `ParentEnrollmentConsentsPanel` reads-only surfaces
  the parent's current state. Phase B adds the two new type rows
  with expiry-aware status display via the consolidated shared
  resolver (decision 6).
- **No parent-portal renewal path in Phase B** (decision 9).
  Renewal is provider-initiated; the parent re-signs through
  in-person-paper or, when re-enabled, parent-portal capture via
  the provider's modal-driven flow. A parent-portal renewal RPC
  mirrors `intake_confirm_for_parent`'s shape but is deferred
  until the licensing-consultant provider-attestation question
  lands.

### Renewal reminder (fast-follow, OUT of Phase B core — decision 5)

Phase B core delivers the expiry data model — consent correctly
lapses at `expires_at` and the audit-state surface reports it. The
proactive notification rides on top via PR #15's opt-in reminder
system as a fast-follow:

- **Transportation:** reminder fires N days ahead of the row's
  own `expires_at`. N is a per-provider setting on PR #15's
  reminder catalog (default to be decided; 30 days is a sensible
  default subject to provider feedback).
- **Water:** the spring reminder is **calendar-anchored**, not
  expiry-derived. It fires each spring (e.g., a fixed March/April
  window) **regardless of the row's rolling `expires_at`**, because
  the rolling expiry and the "renew ahead of season" intent do not
  coincide — a consent signed mid-season has its `expires_at` the
  following mid-season, and an expiry-derived reminder would fire
  mid-season, not before it. This decoupling is the fast-follow's
  design problem, NOT Phase B core. Phase B core only guarantees the
  consent lapses at `expires_at`; *when* the provider is nudged to
  renew is the reminder system's concern, and for water it is
  deliberately calendar-based rather than expiry-derived.
- Both categories ship default OFF per PR #15's opt-in convention.

The renewal reminder is **explicitly NOT** what makes the consent
lapse — `expires_at` does that, in the data model, the moment the
clock crosses it. The reminder is a courtesy nudge.

---

## §12. Tests

- **New ACK_TYPES present + distinct string values**
  (`transportation_routine_annual`,
  `water_activities_on_premises_seasonal`).
- Both added to `PARENT_SIGNED_TYPES` and `ENROLLMENT_CONSENT_TYPES`.
- **Expiry-aware verdict tests:**
  - Active row, `expires_at = NULL` → satisfied (Phase A unchanged).
  - Active row, `expires_at > now()` → satisfied.
  - Active row, `expires_at <= now()` → **expired** (new
    `enrollment_consents_expired` field), NOT satisfied, NOT in
    `_pending`.
  - Archived row, any `expires_at` → not in active reads (existing
    soft-delete behavior).
- **Cadence write tests:** inserting either Phase B type sets
  `expires_at = acknowledged_at + interval '1 year'`. Same formula,
  no type branching.
- **Renewal protocol tests:** insert → expire → archive prior +
  insert new → exactly one active row, the new one with a new
  `expires_at`; the archived prior remains queryable.
- **Early renewal test:** renewal initiated before
  `expires_at` archives the prior row immediately; no coexistence.
- **Backward-compat test:** every Phase A type with `expires_at =
  NULL` reads identically before and after Phase B; existing tests
  continue to pass without modification.
- **`pendingEnrollmentConsentsForChild`** stays deterministic (no
  `now()` reference); caller-side fixtures supply pre-filtered
  `activeAcks` arrays for the verdict tests, and integration tests
  cover the full Supabase-query → verdict path.
- **Parent-panel consolidation tests:** assert
  `ParentEnrollmentConsentsPanel` calls the shared resolver,
  asserts no `pickActive` inline reads remain, asserts expired
  status renders distinctly from on-file and from never-captured.
- **"On file" compliance copy** check: where the panel/modal
  surfaces compliance state, the help copy correctly states that
  electronic capture satisfies R 400.1901(1)(cc) (a content check
  to keep the regulatory framing correct).
- **Build clean, vitest green, lint passes (`--max-warnings 0`).**

---

## §13. Out of scope (explicitly deferred)

Named so they're not silently absorbed into Phase B.

- **Phase C: per-occurrence consents.** Non-routine transportation
  (R 400.1901(1)(jj) "any deviation"), off-premises water,
  medication. Needs the per-occurrence dimension decision
  (`subject_type='trip'` + new table, vs. payload metadata, vs.
  separate table). See findings doc §5b–5d and Phase A scope
  lines 31–38.
- **Three-state photo consent** (🟢 green / 🟡 yellow / 🔴 red).
  Captured in the messaging photo-consent reminder PR's PART 2 as
  a future model revision. Independent of Phase B's expiry
  mechanism.
- **Licensing-consultant policy questions** (parked):
  - Does provider-attestation satisfy parent-signed for
    **renewal** (a subtly different question than for initial
    capture)?
  - Backfill policy for existing rows that *would* have had an
    expiry under the new model but predate Phase B
    (recommendation: leave them NULL and surface as "expiry
    unknown — please re-record" in the audit-state UI; consultant
    confirms).
  - Whether "season" gets a formal definition that changes the
    water-cadence interpretation (decision 3's single knob).
- **Compliance score (#22) scoring weights** for the new
  `enrollment_consents_expired` state. Phase B adds the field;
  the score weighting is #22's contract.
- **Parent-portal renewal RPC.** Deferred (decision 9).
- **`consent_expiring_soon` reminder category** (decision 5).
  Fast-follow on top of Phase B core.
- **Expiry on Phase A types.** No retroactive expiry on
  `field_trip_permission` or `photo_sharing_consent`. If a future
  rule-text read on R 400.1952(2) reinterprets field-trip
  permission as renewable, that's a separate decision.

---

## Halt for review — show

When CC picks this up for the build PR:

1. The two new types + where wired (added to `PARENT_SIGNED_TYPES`
   and `ENROLLMENT_CONSENT_TYPES`, NOT to the intake bundle).
2. The migration file (one ALTER, header comment matching 024's
   style, runbook entry).
3. The audit-read predicate change in every surface enumerated in
   §8, including the parent-panel consolidation outcome.
4. The renewal flow in `EnrollmentConsentsModal` — exact
   archive-then-insert transitions.
5. The new audit-state field (`enrollment_consents_expired`) on
   `pendingEnrollmentConsentsForChild`'s return shape.
6. Test coverage matching §12.
7. Confirmation no Phase C-related decisions were silently
   foreclosed (the §9-NonForeclosure checks all still hold).

Do NOT deploy or merge until verification screenshots are in hand
per `CLAUDE.md`'s verification-gap rule.

---

**End of Phase B scope document — FINAL.** All decisions locked.
Ready to hand to CC for the build PR; the migration is the next
artifact, written from §10's planning sketch.
