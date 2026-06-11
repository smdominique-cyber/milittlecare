# PR Scope — Consents Phase C: Per-Occurrence Consents

**Date:** 2026-06-01
**Status:** Scope — **FINAL, ready for build** (both per-occurrence
consents unified on the index-relaxation + jsonb-metadata pattern; no
remaining blocks).
**Branch (suggested):** `feature/consents-c-per-occurrence`
**Builds on:** Phase A (`field_trip_permission`,
`photo_sharing_consent`/`_revoked` shipped 2026-05-30), Phase B
(`transportation_routine_annual` +
`water_activities_on_premises_seasonal`, expiry column added in
migration 026 — pending application). Phase C is the third and final
piece of the consents roadmap; medication (PR #20) is **separately
scoped** with its own tables and is NOT part of Phase C — see §13.

---

## Summary

Phase C ships the two **per-occurrence** licensing-required consents
the engine couldn't hold before: non-routine transportation (one
consent per trip) and off-premises water activities (one consent per
outing). The blocker the prior phases deferred is the
`acknowledgments_active_unique` partial unique index, which today
enforces *one active row per (provider, type, subject_type,
subject_id)*. Per-occurrence consents need MULTIPLE active rows per
(type, child) — one per trip/outing — and the existing constraint
silently overwrites previous rows. Phase C resolves this surgically:
**replace the index with one whose WHERE clause exempts the two
per-occurrence types**, preserving the one-active-row guarantee for
every durable consent. Per-occurrence rows additionally carry a
**nullable `occurrence_metadata jsonb`** column (trip date,
destination, water-body details) — NULL for every durable type,
purely additive like Phase B's `expires_at`. The verdict function
**excludes** per-occurrence types from the enrollment_consents_pending
/ _expired rollup so a child with no scheduled trips does not show as
permanently non-compliant. No `expires_at` on per-occurrence types —
they're durable rows tied to a specific event, not time-bound.

What this scope does NOT do: medication (PR #20's own data model with
its own tables, deferred); the three-state photo consent (separate
follow-up); a per-trip *audit* (e.g. "trip happened but no consent
recorded") which requires a trips/events table out of scope here.

---

## DECISIONS — RESOLVED

Every choice this scope deliberately makes. Each is folded into the
design body below.

| # | Decision | Resolution |
|---|---|---|
| 1 | Central schema change — per-occurrence uniqueness | **Replace `acknowledgments_active_unique` with a new partial unique index whose WHERE clause exempts the two per-occurrence types.** Mechanism: `WHERE archived_at IS NULL AND subject_id IS NOT NULL AND type NOT IN ('transportation_nonroutine_per_trip','water_activities_off_premises_per_trip')`. Durable Phase A/B types keep their one-active-row guarantee; only the two per-occurrence types can have multiple active rows. Surgical — see §6 for the exact swap mechanism (atomic DROP + CREATE in a single transaction; no uniqueness-gap window). |
| 2 | Occurrence metadata | **Add a nullable `occurrence_metadata jsonb` column to `acknowledgments`.** NULL for every existing row and every durable type; carries per-occurrence detail (trip/outing date, destination/water-body) for the two new types. Purely additive — backward-compatible exactly like Phase B's `expires_at`. The app validates the shape per-type; the DB stores free jsonb. See §6.2 for the suggested shape per type. |
| 3 | Cadence — per-occurrence consents are DURABLE | **No `expires_at` on per-occurrence types.** "Before each trip" means one consent captured per occurrence, never renewed; a new trip is a NEW ROW with its own `occurrence_metadata`. `expires_at` stays NULL for these types. They are explicitly NOT time-bound (that's Phase B). |
| 4 | Channel rule | **Same parent-signed rule as every Phase A/B consent.** Only `parent_portal` / `in_person_paper` satisfy; `provider_override` alone does not. The two per-occurrence types are added to `ENROLLMENT_CONSENT_TYPES` (mirrors Phase A/B precedent — NOT `PARENT_SIGNED_TYPES`; that was the conflict corrected during Phase B build, see Phase B halt report). |
| 5 | Audit-state — per-occurrence types are NOT pending/satisfied | **Per-occurrence types are EXCLUDED from the `enrollment_consents_pending` and `enrollment_consents_expired` rollups.** Mechanism: a new `PER_OCCURRENCE_TYPES` const enumerates them; `pendingEnrollmentConsentsForChild` and the audit-state breakdown helpers filter them out of every loop that iterates `ENROLLMENT_CONSENT_TYPES`. A child with NO scheduled trips this year does NOT show as "pending non-routine transport" forever — there is no single "is this on file" verdict for an event consent. See §9 for the exact filter sites. |
| 6 | Recording UX | **Per-occurrence capture happens at trip-planning time, provider-initiated.** The data-model is the locked part; UX placement is open — the Provider EnrollmentConsentsModal can grow a "Record trip consent" affordance, OR a dedicated per-trip surface can host it. Recommend: extend `EnrollmentConsentsModal` for Phase C build with a per-occurrence section that captures the metadata; revisit the dedicated surface if/when a trips table lands. See §11. |
| 7 | ACK_TYPES names | `transportation_nonroutine_per_trip` and `water_activities_off_premises_per_trip`. Same wordy-on-purpose pattern as Phase B; clean grep + clean distinction from the routine/seasonal siblings. |
| 8 | Renewal | **No renewal concept.** Each occurrence row is captured once and never re-acked; the archive-then-insert protocol is for durable re-acks (Phase A re-record + Phase B renewal), not for events. If the trip is cancelled or the consent needs correcting, archive the row and capture a fresh one — same as any audit-trail correction. |
| 9 | Phase C non-foreclosure (forward) | **Does not foreclose a future trips/events entity.** If Phase D (or similar) later introduces a `trips` table to track whether a trip actually happened, the per-occurrence consents already carry the trip date + destination in `occurrence_metadata`; a future entity can either reference the consent row by ID or back-fill its own records from `occurrence_metadata`. The jsonb shape is forward-compatible. |
| 10 | Index strategy | **One partial unique index replacing the existing one.** No new read-side indexes initially; the existing `acknowledgments_subject_active` and `acknowledgments_provider_active` partial indexes still narrow per-occurrence reads. A future per-occurrence query optimization (e.g., GIN index on `occurrence_metadata`) can be added when query volume justifies. |
| 11 | Audit-state typedef change | **Verdict return shape UNCHANGED from Phase B.** Per-occurrence types don't add new fields to `pendingEnrollmentConsentsForChild`'s return; they're excluded from every existing field. The audit-state helper exposes per-occurrence types only as a per-type breakdown (`per_occurrence_consents_recorded` — count of active rows, NOT a compliance signal) for future PR #22 consumption; this is informational, not a gap-tracking metric. |
| 12 | "On file" satisfies via electronic capture | **Same as Phase A/B**, cited from R 400.1901(1)(cc): "on file" means accessible at the home via hard copy OR electronically. Per-occurrence consents in `acknowledgments` satisfy the regulatory "on file" requirement. |

---

## The audit-read predicate (single canonical statement)

A **durable** consent (Phase A `field_trip_permission`,
`photo_sharing_consent`/`_revoked`, Phase B
`transportation_routine_annual`,
`water_activities_on_premises_seasonal`) is **currently satisfied**
for `(child, type)` when:

> there is an **active** row (`archived_at IS NULL`) under a
> **satisfying channel** (`acknowledged_via IN
> PARENT_SIGNED_SATISFYING_CHANNELS`) for that `(child, type)`,
> **AND** (`expires_at IS NULL` **OR** `expires_at > now()`).

A **per-occurrence** consent
(`transportation_nonroutine_per_trip`,
`water_activities_off_premises_per_trip`) has **no single satisfied
verdict** — the meaningful read is a LIST of recorded occurrences for
`(child, type)`, each carrying `acknowledged_at`,
`acknowledged_via`, and `occurrence_metadata`. The pending/satisfied
predicate above does NOT apply; per-occurrence types are excluded
from it entirely (decision 5).

### State transitions for per-occurrence types (one row per trip/outing)

| Event | Row state | Treatment |
|---|---|---|
| Provider records consent for a new trip | New row inserted; `archived_at = NULL`, `expires_at = NULL`, `occurrence_metadata` set | Counted in the per-type recorded list. **Not** in pending/expired rollup. The unique-index relaxation permits this even if prior trip rows exist for the same child. |
| Trip cancelled / consent recorded in error | Provider archives the row (`archived_at = now()`) | Drops out of active reads. Audit trail preserved. |
| Subsequent trip for the same child | New row inserted, same as initial | Multiple active rows coexist legitimately. |
| Consent corrected (wrong destination, wrong date) | Archive prior row + insert fresh row | Same archive-then-insert correction shape; no special protocol. |

---

## Why this is Phase C (and what's still deferred)

The consents roadmap split seven needs by **data shape**. Phase A
shipped the engine's native shape (sign-once, durable, optionally
revocable). Phase B added the expiry dimension. Phase C tackles the
shape the existing constraint actively blocked.

**Phase C (THIS PR) — per-occurrence (one row per trip/outing):**
- Non-routine transportation (R 400.1952(1)(b), "before each trip").
- Off-premises water activities (R 400.1934(10)(a), "before each").

These need ONE replaced partial unique index + ONE new nullable
column (`occurrence_metadata jsonb`). The verdict gets a skip filter
for per-occurrence types; the audit-state breakdown gets a new
informational field listing recorded occurrence counts (NOT a
compliance signal).

**Still deferred (named so they're not confused with Phase C):**
- **Medication (PR #20).** R 400.1931 carries the per-medication
  permission + per-dose log + topical-OTC exemption + role-gated
  administering staff. PR #20 designs its own tables
  (`medication_authorizations` + `medication_administration_events`)
  and a DB trigger for role gating. **Medication sidesteps the
  index-relaxation problem** because doses go into their own table
  with their own `id`, not `acknowledgments` with overlapping
  `subject_id`. Phase C does NOT carry medication — that PR is
  separately scoped in `docs/pr-20-medication-log-scope.md`.
- **Three-state photo consent** (🟢 green / 🟡 yellow / 🔴 red).
  Captured in the messaging photo-consent reminder PR's PART 2 as a
  future model revision. Independent of Phase C's index work.
- **Consultant policy questions** parked from Phase B (does
  provider-attestation satisfy parent-signed for renewal; how to
  treat the undefined "season" in water rules) carry forward
  unchanged. None of them block Phase C.

---

## The two consents in this PR

### 1. Non-routine transportation — `transportation_nonroutine_per_trip`

- **Rule (verbatim):** R 400.1952(1):
  > "A licensee shall obtain and keep on file written permission from
  > a child's parent before a child is transported in a vehicle.
  > Written permission must be obtained for both of the following:
  > (a) Routine transportation, at least annually.
  > (b) Nonroutine transportation, before each trip."
- **The (a)/(b) split is the Phase B/C boundary.** Phase B already
  ships (1)(a) as `transportation_routine_annual` with rolling annual
  expiry. Phase C ships (1)(b) — per-trip, no expiry, one row per
  trip.
- **Routine/nonroutine boundary (verbatim):** R 400.1901(1)(jj):
  > "'Routine transportation' means regularly scheduled travel on the
  > same day of the week, at the same time, to the same destination.
  > Any deviation is nonroutine transportation."
- **Shape:** one row per trip, parent-signed, durable (no expires_at).
  The `occurrence_metadata` carries trip date, destination, optional
  purpose / vehicle / estimated return.
- **Classification:** LICENSING-REQUIRED. Cataloged in
  `ENROLLMENT_CONSENT_TYPES` (decision 4) AND in the new
  `PER_OCCURRENCE_TYPES` set (decision 5) so the verdict skips it.
- **Channel:** parent-signed — only `parent_portal` /
  `in_person_paper` satisfy. `provider_override` is captured for the
  audit trail but doesn't satisfy the rule.

### 2. Off-premises water activities — `water_activities_off_premises_per_trip`

- **Rule (verbatim):** R 400.1934(10):
  > "A licensee shall obtain and keep on file written permission from
  > a child's parent for the child's participation in either of the
  > following:
  > (a) Before each outdoor water activity at a swimming pool, lake,
  > or other body of water off the child care home premises.
  > (b) Once per season for water activities occurring on the child
  > care home premises."
- **The (a)/(b) split is the Phase B/C boundary** for water, parallel
  to transportation. Phase B already ships (10)(b) as
  `water_activities_on_premises_seasonal` with annual rolling expiry
  (per scope-doc decision 3). Phase C ships (10)(a) — per-outing,
  no expiry, one row per outing.
- **Scope (verbatim) — "water activities" definition:**
  R 400.1901(1)(yy):
  > "'Water activities' mean activities in residential pools, lakes,
  > ponds, or other bodies of water. Water activities do not include
  > water play activities such as water table play, slip and slide
  > activities, wading pools, or playing in sprinklers."
- The definition narrows the rule: water-table play / slip-and-slide
  / wading pools / sprinkler play DO NOT require this consent. The
  modal's help copy must spell this out so providers don't
  over-collect.
- **Shape:** one row per off-premises water outing, parent-signed,
  durable. `occurrence_metadata` carries outing date, water-body
  type (pool / lake / pond / other), location, optional supervisor
  / address / estimated return.
- **Classification & channel:** same as non-routine transportation —
  licensing-required, parent-signed, in `ENROLLMENT_CONSENT_TYPES`
  AND in `PER_OCCURRENCE_TYPES`.

### Why unify on one per-occurrence mechanism

Both types have the same row shape (durable, no expires_at, jsonb
metadata), the same audit semantic (excluded from pending/satisfied),
the same channel rule, the same renewal-absent protocol. The two
ACK_TYPES strings distinguish them in the catalog; the
`occurrence_metadata` payload differs in shape (trip vs outing
specifics) but the column is jsonb — one mechanism, one predicate
modification, one index swap covers both.

---

## Classification note for the compliance score (PR #22)

Both Phase C types are licensing-required — same tier as Phase B
types and `field_trip_permission`. But the compliance-score semantic
is different: per-occurrence consents are **event records**, not
**enrollment state**.

**Proposal for #22** (not locked here; flagged for #22's contract):
- A child with NO recorded per-occurrence consents is NOT a
  compliance gap — they may simply have no trips planned.
- A useful #22 signal would be "consents recorded in the last N days
  / month" — a recency proxy that shows the provider is using the
  capture path. But the gap is "the child took a trip with no
  recorded consent" — which requires a trips/events entity Phase C
  does NOT introduce. Without that entity, #22 cannot mechanically
  audit per-occurrence compliance; the per-occurrence consent is a
  capture surface, not an audit surface.
- The audit-state helper exposes per-type recorded-count
  (informational) so #22 has the raw number when it's ready to weigh
  it. Phase C does not pretend to score these.

---

## §6. The two schema changes — index swap + jsonb column

### §6.1 Index relaxation (decision 1 — the central change)

The current partial unique index on `acknowledgments` is the
constraint Phase A/B both navigated by keeping `(type, child)`
unique:

```sql
-- From migration 024:
create unique index if not exists acknowledgments_active_unique
  on public.acknowledgments (provider_id, type, subject_type, subject_id)
  where archived_at is null and subject_id is not null;
```

Phase C replaces this with a new partial unique index whose WHERE
clause **exempts the two per-occurrence types**:

```sql
-- After migration 027:
create unique index acknowledgments_active_unique
  on public.acknowledgments (provider_id, type, subject_type, subject_id)
  where archived_at is null
    and subject_id is not null
    and type not in (
      'transportation_nonroutine_per_trip',
      'water_activities_off_premises_per_trip'
    );
```

**Effect:**
- Every durable type (`field_trip_permission`,
  `photo_sharing_consent`, `photo_sharing_consent_revoked`,
  `transportation_routine_annual`,
  `water_activities_on_premises_seasonal`, every intake type) STILL
  has one-active-row uniqueness. The renewal / re-ack /
  revocation-pair protocols Phase A and Phase B established
  continue to work unchanged.
- The two per-occurrence types are **exempt** — multiple active rows
  per `(provider, type='transportation_nonroutine_per_trip',
  subject_type='child', subject_id=childA)` are now ALLOWED.

**The provider-level partial unique
(`acknowledgments_active_unique_no_subject`) is UNTOUCHED.** That
index covers `subject_id IS NULL` (provider-level acks); per-occurrence
consents always have `subject_id = child uuid`, so they never
interact with it.

### §6.2 `occurrence_metadata jsonb` column (decision 2)

Add a single nullable column:

```sql
alter table public.acknowledgments
  add column if not exists occurrence_metadata jsonb;
```

- **Nullable.** Every existing row and every durable type leaves it
  NULL.
- **`jsonb`** (not `text` or fixed columns) because transportation
  and water carry different occurrence fields; a fixed `event_date`
  + `description` pair is lossy and a multi-nullable-column shape
  proliferates fields with weak semantic ties to the row.
- **No CHECK constraint.** The app validates the shape per-type; the
  DB accepts free jsonb (same convention as `type` being free-text).
- **Default NULL.** Inserts of durable types don't write it.

**Suggested per-type shape** (app-side validation; not enforced at the
DB):

**`transportation_nonroutine_per_trip`:**

```json
{
  "trip_date":            "YYYY-MM-DD",            // required
  "destination":          "free text",              // required
  "purpose":              "free text",              // optional
  "vehicle_description":  "free text",              // optional
  "estimated_return":     "YYYY-MM-DDTHH:MM:SSZ"    // optional
}
```

**`water_activities_off_premises_per_trip`:**

```json
{
  "outing_date":          "YYYY-MM-DD",                                       // required
  "water_body_type":      "pool" | "lake" | "pond" | "river" | "beach" | "other",  // required
  "location":             "free text venue name",                             // required
  "address":              "free text",                                        // optional
  "supervising_adult":    "free text",                                        // optional
  "estimated_return":     "YYYY-MM-DDTHH:MM:SSZ"                              // optional
}
```

The Phase C modal section validates the required fields before
insert; the DB-side jsonb stores whatever the app writes (forward-
compatible if later fields are added to the schema validation).

### Why these two changes (and not the alternatives from findings §5d)

The findings doc enumerated three candidate models for per-
occurrence; Phase C picks **(b) — payload-on-row with
`subject_id=child_id` and (effectively, via the jsonb column)
metadata** plus the index-relaxation that makes (b) actually viable.

The rejected alternatives:

#### Rejected: **(a) New `trips` table referenced by
`subject_type='trip'` / `subject_id=<trip_id>`**

Would require creating a new table with its own RLS, its own
indexes, its own write paths, and a join on every per-occurrence
consent read. Three failure modes:

1. **Two-table audit complexity.** Every per-occurrence consent read
   becomes `acknowledgments JOIN trips`. The hot-path audit query
   degrades.
2. **Pre-mature entity invention.** "Trips" is a reasonable future
   entity (it might also track attendance, vehicle records,
   destinations as reference data), but Phase C doesn't need the
   entity — it needs the consent capture. Inventing the entity now
   constrains its later design.
3. **Forecloses jsonb flexibility.** A trips table commits the
   schema for trip metadata; jsonb on the consent row keeps the
   shape forward-compatible until the trips entity is actually
   designed by a future PR.

#### Rejected: **(c) Different table entirely outside
`acknowledgments`**

Would split per-occurrence consents from the rest of the consent
catalog. Three failure modes:

1. **Two consent reads for "all consents on this child."** The
   parent-facing Consents tab and the provider modal would need to
   query two tables.
2. **Channel rule duplicated.** `acknowledgments` carries the
   parent-signed channel CHECK; a separate per-occurrence table
   either duplicates it (drift risk) or skips it (semantic gap).
3. **Audit trail surfaces in two places.** Archive / soft-delete
   convention works once on `acknowledgments`; a separate table
   needs its own `archived_at` discipline.

### Why one column + index relaxation beats both

- ZERO new tables, no JOIN, no duplicated RLS / channel constraints.
- The existing engine's audit-trail, soft-delete, RLS, and partial-
  index machinery applies unchanged.
- Forward-compatible — if a trips entity ever lands (Phase D / a
  future PR), it can either reference `acknowledgments.id` or
  backfill from `occurrence_metadata`. The jsonb column doesn't
  preclude that.

---

## §7. Cadence — locked + the "no expiry" note

### Locked (decision 3)

Per-occurrence consents have **no expiry**. `expires_at` stays NULL
for these types. Every captured row is a finished event-record; a
new trip is a NEW ROW with its own `occurrence_metadata`.

The Phase B audit predicate `(expires_at IS NULL OR expires_at >
now())` still applies to per-occurrence rows — and is always TRUE
(NULL expires_at) — which means an active per-occurrence row is
ALWAYS in `activeAcks` for partition purposes. That's fine; the
verdict's exclusion (decision 5) is what keeps these out of the
pending/satisfied rollup, not the predicate.

### Why this lock is safe

- **R 400.1952(1)(b)** says "before each trip" — there is no
  "expiration"; the consent's scope is the specific trip. After the
  trip, the row is the historical record of that consent.
- **R 400.1934(10)(a)** says "before each outdoor water activity" —
  same. Each outing is a discrete event with its own consent.
- The 4-year audit retention rule (CLAUDE.md) applies to the row's
  preservation, not its semantic validity. A 2-year-old non-routine
  transport consent for a long-past trip is historical data, not
  expired-and-needs-renewal data.

### What "expired-like" semantic would look like and why we reject it

A future maintainer might be tempted to set `expires_at` to the trip
date + a buffer, so "old" trip consents drop out of the active read.
**Don't.** Two reasons:

1. **The unique-index exemption requires non-archived rows to
   coexist.** Setting `expires_at` doesn't archive; it just expires.
   The row is still `archived_at IS NULL`, still counts toward "active"
   queries.
2. **Historical event-records have value indefinitely.** Auditors may
   want "show me all non-routine transport consents this child gave
   over the past year" — that read needs the rows preserved as
   active until retention rules archive them.

If the volume of preserved per-occurrence rows ever becomes a
performance issue, the right answer is an archive sweep (set
`archived_at` for rows whose `occurrence_metadata.trip_date` is more
than N years past), not a fake `expires_at`.

---

## §8. Backward compatibility + read-surface enumeration

### Backward-compat invariant

**Every consent shipped before Phase C is unaffected by Phase C.**

Concretely:
- Every existing row leaves `occurrence_metadata = NULL`. The
  existing INSERT paths don't write this column. Default NULL.
- The replaced `acknowledgments_active_unique` index continues to
  enforce one-active-row uniqueness for EVERY durable type. A
  duplicate active row of any Phase A or Phase B type still
  violates the constraint.
- The audit predicate `archived_at IS NULL AND (expires_at IS NULL OR
  expires_at > now())` is unchanged. Per-occurrence rows pass it
  because `expires_at` is NULL; durable rows pass it under their
  existing rules.
- The verdict function's signature is unchanged from Phase B —
  `pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })`
  still works for every existing caller. The new internal filter
  (`PER_OCCURRENCE_TYPES` skip) is invisible from outside.
- The audit-state helper's return shape grows by ONE informational
  field (`per_occurrence_consents_recorded` per-type counts). Every
  existing field on the return is preserved.

### Read surfaces — enumeration

| # | Surface | File | Today's read | Phase C change |
|---|---|---|---|---|
| 1 | Provider audit helper | `src/lib/childFiles.js` `getChildFilesAuditState` | Fetches `subject_id, type, acknowledged_via, expires_at` | Add `occurrence_metadata` to the projection. Partition still by expiry (Phase B); the verdict's `PER_OCCURRENCE_TYPES` filter applies inside the verdict. Add the informational `per_occurrence_consents_recorded` rollup. |
| 2 | Provider banner verdict (shared, pure) | `src/lib/childFiles.js` `pendingEnrollmentConsentsForChild` | Pure — caller passes activeAcks + expiredAcks | Verdict adds a single internal filter step: skip types in `PER_OCCURRENCE_TYPES` for both `_pending` and `_expired` loops. Return shape UNCHANGED. |
| 3 | Messaging photo-consent reminder | `src/pages/MessageThreadPage.jsx` `loadPhotoConsentReminderState` | Selects archived_at + expires_at; partitions; calls photo verdict | NO CHANGE. Photo consent isn't a per-occurrence type. |
| 4 | Parent dashboard banner | `src/components/parent/EnrollmentConsentsPendingBanner.jsx` | Calls shared resolver | NO CHANGE — the resolver's filter handles the exclusion. |
| 5 | Parent Consents tab | `src/pages/ParentEnrollmentConsentsPanel.jsx` | Iterates `ENROLLMENT_CONSENT_TYPES` to render rows; calls shared resolver | **Filter out per-occurrence types from the per-type row rendering** (they don't have an "on file / expired / not on file" state to render). Optionally, the panel can grow a separate per-occurrence section listing recorded trip / outing consents per child — but a parent's view of these is informational ("here's what's been recorded"), not a compliance status. Recommended: add a collapsed "Recorded trip and outing consents" subsection per child for transparency. |
| 6 | Provider enrollment-consents modal | `src/components/families/EnrollmentConsentsModal.jsx` | Reads acks per child + renders one row per type | **Filter durable rendering to exclude per-occurrence types** (they don't fit the "on file / expired / unrecorded" tri-state). Add a Phase C section: per-occurrence consent recording — provider clicks "Record trip consent," fills in `occurrence_metadata` + channel, submits. List the most recent N recorded occurrences per type as audit context. See §11. |

### Why the verdict exclusion is the locked semantic

Decision 5 is the subtle one — getting it wrong replicates the
worst-case Phase A bug pattern (a child appearing permanently
non-compliant for a consent that's only needed when an event
happens). Worked through:

**If per-occurrence types are IN the verdict's pending loop:**
- A child with no trips ever scheduled shows up as "pending
  non-routine transport" indefinitely.
- The audit-state field `pending_enrollment_consents_count`
  permanently includes this child.
- PR #22's compliance score over-counts.
- The parent dashboard banner fires perpetually for every parent
  whose provider never plans a trip.

**If per-occurrence types are EXCLUDED from the verdict:**
- A child with no recorded trips contributes 0 to
  `enrollment_consents_pending` (correct — no compliance gap).
- A child with two recorded trip consents contributes 0 to
  `enrollment_consents_pending` (correct — both trips are
  documented).
- The per-occurrence rollup field `per_occurrence_consents_recorded`
  exposes the raw count for PR #22 to weigh (likely as a recency
  signal, not a gap signal — see §"Classification note").

**The exclusion is the only mechanism that gets the semantic right
without inventing a trips entity.** A future PR that DOES introduce
a trips table can compare per-occurrence consents against trips
records and surface "trip happened, consent missing" as its own
audit — but Phase C correctly stops at "we captured the consent;
that's the durable record." The compliance gap is only computable
when there's a trip-record source of truth to compare against,
which is out of scope here.

---

## §9. Per-occurrence semantics — the verdict exclusion in detail

### The new constants

Adds one constant to `src/lib/childFiles.js`:

```js
/**
 * Per-occurrence licensing-required consents (Consents Phase C,
 * 2026-06-01). These are event records, NOT enrollment-state — each
 * row captures consent for a specific trip/outing, durable forever
 * (no expires_at). Multiple active rows per (provider, type, child)
 * are EXPECTED and permitted by the relaxed acknowledgments_active_unique
 * partial index (migration 027).
 *
 * The verdict function `pendingEnrollmentConsentsForChild` excludes
 * these types from the pending/expired rollup — a child with no
 * scheduled trips is NOT non-compliant on non-routine transport.
 * They are captured in `ENROLLMENT_CONSENT_TYPES` for catalog
 * completeness (they ARE licensing-required) but the verdict's
 * loops filter them out via this set.
 */
export const PER_OCCURRENCE_TYPES = Object.freeze([
  'transportation_nonroutine_per_trip',
  'water_activities_off_premises_per_trip',
])
```

`ENROLLMENT_CONSENT_TYPES` is extended to include them (per decision
4); the verdict's loops apply the filter via the new set.

### The verdict-function diff (sketch)

```js
export function pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks } = {}) {
  // ... (unchanged: build satisfyingTypes and expiredSatisfyingTypes sets) ...

  const enrollment_consents_pending = []
  const enrollment_consents_expired = []
  const perOccurrenceSet = new Set(PER_OCCURRENCE_TYPES)
  for (const t of ENROLLMENT_CONSENT_TYPES) {
    if (perOccurrenceSet.has(t)) continue   // ← Phase C exclusion
    if (satisfyingTypes.has(t)) continue
    if (expiredSatisfyingTypes.has(t)) {
      enrollment_consents_expired.push(t)
    } else {
      enrollment_consents_pending.push(t)
    }
  }

  // ... (provider-protective loop unchanged) ...
}
```

### The audit-helper diff (sketch)

The breakdown helpers also filter:

```js
function emptyEnrollmentConsentsBreakdown() {
  const out = {}
  const perOccurrenceSet = new Set(PER_OCCURRENCE_TYPES)
  for (const t of ENROLLMENT_CONSENT_TYPES) {
    if (perOccurrenceSet.has(t)) continue
    out[t] = 0
  }
  return out
}
```

So the existing `pending_enrollment_consents` / `_expired` breakdown
objects have keys for ONLY the durable enrollment types
(`field_trip_permission`, `transportation_routine_annual`,
`water_activities_on_premises_seasonal`) — never the per-occurrence
ones.

The new informational field:

```js
// In the audit-state return:
per_occurrence_consents_recorded: emptyPerOccurrenceBreakdown(),
// where the breakdown is { type → distinct-children-count }
// or { type → total-active-rows-count }; pick whichever fits #22.
```

This rollup is the informational counterpart: "how many trip /
outing consents have been recorded across the licensee's children."
NOT a compliance signal — see §"Classification note for the
compliance score."

### How callers learn whether to render a per-occurrence type

For the modal and parent panel rendering, the application iterates
`PER_OCCURRENCE_TYPES` separately from `ENROLLMENT_CONSENT_TYPES`
filtered against the exclusion. This keeps the durable consent
rendering identical to today (just the three durable types) and
adds a separate per-occurrence section that's clearly distinct from
the "on file / expired / not on file" state machine.

---

## §10. Migration sketch (planning level, NOT SQL)

A planning sketch only. The migration itself gets written in the
build PR. Phase C's migration is MORE delicate than Phase B's
because it drops + recreates an index — the swap must avoid a window
where uniqueness isn't enforced.

### File

`supabase/migrations/027_acknowledgments_per_occurrence.sql` (next
sequential after 026; if other PRs land first, renumber).

### Contents at a high level

1. **Header comment** matching the style of migration 024 / 026:
   - Authoritative scope: this doc.
   - Dependency: applies AFTER migration 026
     (`acknowledgments_expires_at`).
   - Design decisions: index exemption mechanism, jsonb column
     additive, backward-compat invariant, Phase C non-foreclosure
     of a future trips entity.
   - Expected verification queries (info schema, index definition,
     row mutation count).

2. **The schema changes — both inside a single transaction:**

   ```
   BEGIN;

   -- (a) Drop the existing partial unique index and create the new
   --     one with the per-occurrence type exemption. The DROP and
   --     CREATE are atomic within the transaction; readers see either
   --     the OLD index or the NEW index, never neither.
   DROP INDEX IF EXISTS public.acknowledgments_active_unique;
   CREATE UNIQUE INDEX acknowledgments_active_unique
     ON public.acknowledgments (provider_id, type, subject_type, subject_id)
     WHERE archived_at IS NULL
       AND subject_id IS NOT NULL
       AND type NOT IN (
         'transportation_nonroutine_per_trip',
         'water_activities_off_premises_per_trip'
       );

   -- (b) Add the jsonb metadata column. Additive; nullable; no
   --     default; no CHECK.
   ALTER TABLE public.acknowledgments
     ADD COLUMN IF NOT EXISTS occurrence_metadata jsonb;

   COMMIT;
   ```

   **Why a transaction, not `CREATE INDEX CONCURRENTLY`:** the
   acknowledgments table is small (per-provider, hundreds of rows),
   so the brief lock during index rebuild is negligible. Using a
   transaction keeps the DROP/CREATE swap atomic; other readers see
   either the OLD or NEW index, never neither, never both. `CREATE
   INDEX CONCURRENTLY` would be required for a multi-million-row
   table — not the case here.

3. **No data backfill.** Existing rows leave `occurrence_metadata`
   NULL.

4. **No policy changes.** RLS is type-agnostic; per-occurrence rows
   under `subject_type='child'` use the same policies as Phase A/B
   consents.

5. **The CHECK constraints on `acknowledgments_channel_shape`** are
   UNTOUCHED — per-occurrence consents use the same three channels
   (parent_portal / in_person_paper / provider_override) with the
   same shape constraints.

6. **Forward-only.** The down migration (commented at the file
   bottom per the migration 024 pattern) reverses the swap:

   ```
   -- BEGIN;
   -- ALTER TABLE public.acknowledgments
   --   DROP COLUMN IF EXISTS occurrence_metadata;
   -- DROP INDEX IF EXISTS public.acknowledgments_active_unique;
   -- CREATE UNIQUE INDEX acknowledgments_active_unique
   --   ON public.acknowledgments (provider_id, type, subject_type, subject_id)
   --   WHERE archived_at IS NULL AND subject_id IS NOT NULL;
   -- COMMIT;
   ```

   Note: if Phase C per-occurrence rows have been captured by
   rollback time, the down migration leaves their rows in place
   (just drops the metadata column). Those rows will be visible as
   "active rows with NULL occurrence_metadata" — non-fatal but
   audit-trail-imperfect. The migration's docstring calls this out.

7. **Runbook entry** per `CLAUDE.md`'s same-PR doc discipline.

8. **Verification queries** to paste into the Supabase SQL editor:

   ```sql
   -- (a) occurrence_metadata column exists.
   select column_name, data_type, is_nullable
   from information_schema.columns
   where table_schema='public'
     and table_name='acknowledgments'
     and column_name='occurrence_metadata';
   -- expect: 1 row — occurrence_metadata | jsonb | YES

   -- (b) Index has the new exclusion clause.
   select indexname, indexdef
   from pg_indexes
   where schemaname='public' and tablename='acknowledgments'
     and indexname='acknowledgments_active_unique';
   -- expect: WHERE clause includes "type NOT IN ('transportation_nonroutine_per_trip','water_activities_off_premises_per_trip')"

   -- (c) Durable-type uniqueness still enforced (negative test —
   --     this insert should fail if you try it).
   --     Don't actually run; this is documentation.
   --
   --     insert into public.acknowledgments (...) values (
   --       <provider>, 'field_trip_permission', 'child', <child>, ...
   --     );  -- if a row already exists, this should violate the unique.
   ```

---

## §9-NonForeclosure. What Phase C does NOT close

### Future per-occurrence audit (trips/events entity)

A Phase D / future PR introducing a `trips` table (or general
`events` table) is **not foreclosed**:

- Per-occurrence consents already carry trip date + destination in
  `occurrence_metadata`. A future trips entity can either:
  - Reference the consent row by its UUID (FK on the trip row), OR
  - Back-fill its records from `occurrence_metadata`, OR
  - Live independently and cross-reference by date + child.
- The jsonb shape is forward-compatible — new fields can be added
  to the app's validation without a DB migration.

### Three-state photo consent

Phase C touches only the index + jsonb column. The photo-consent
binary model is untouched by this PR; the three-state design captured
in the messaging-reminder PR's PART 2 remains a separate future
revision.

### Medication

PR #20's medication model deliberately uses **its own tables**
(`medication_authorizations` + `medication_administration_events`),
which side-steps the unique-index problem because per-dose events
have their own `id` not overlapping with any `acknowledgments`
constraint. Phase C does NOT carry medication. The
medication_permission ACK in `acknowledgments` (one per
authorization, durable) is a sibling Phase A/B-style consent; the
per-dose log is in its own table. PR #20 covers all of this.

### "Trip happened, consent missing" audit

This is the genuine per-occurrence compliance gap — but it cannot
be computed without a source-of-truth record that the trip
HAPPENED. Phase C does not introduce that record. A future PR (with
a trips table OR an attendance-augmented record) would enable this
audit; Phase C correctly stops at "we recorded the consent."

---

## §11. UX — where per-occurrence consents are recorded

### Provider side (decision 6)

Recommend: **extend `EnrollmentConsentsModal`** with a per-occurrence
section. The modal already opens per-child from
`FamiliesPage.jsx`'s Children tab. The Phase C addition:

- A new section below the durable consents: "Record a trip or outing
  consent."
- Two buttons: "Record non-routine transport consent" and "Record
  off-premises water consent."
- Each opens a sub-form capturing the `occurrence_metadata` (trip
  date, destination, etc.) plus the parent's channel
  (parent_portal / in_person_paper / provider_override, same rules
  as the durable consents).
- Submit inserts a new `acknowledgments` row with `type` set, the
  metadata, and the channel.
- Below the buttons: a list of the most recent N (default 5)
  recorded per-occurrence consents per type, each showing
  `occurrence_metadata.trip_date` / `outing_date` + `destination` /
  `location` + the channel + the recording date. Provides audit
  context — "what consents have I already collected for this child?"

**Alternative UX (flagged as a future refinement):** a dedicated
trip-creation surface (e.g., a "Trips" tab on the family modal)
that captures the trip details AND the parent's consent in one
flow. Better if/when a trips entity lands; over-investment for
Phase C alone. Recommend the modal extension for the build PR.

### Parent side

The Parent Consents tab (`ParentEnrollmentConsentsPanel`) renders
durable consents only — per-occurrence types are filtered out of
the per-type row rendering. Optionally, the panel can grow a
collapsed "Recorded trip and outing consents" subsection per child
listing the most recent N consents (read-only, informational). Same
shape data as the provider's "recent recorded" list but from the
parent's view.

**No parent-portal self-confirm path** in Phase C. Per-occurrence
consents are always provider-initiated (the provider knows about
the trip and asks the parent at the time). If parents need a portal
flow later, it would mirror the deferred parent-portal renewal
from Phase B (still parked on the consultant question).

### Reminder integration (PR #15)

Reminders for per-occurrence consents are **out of Phase C**. There
is no useful "you have a non-routine transport consent due" reminder
because the event isn't predicted by the system — the provider
plans the trip externally. If a future trips table lands, the
"trip in N days, consent not yet recorded" reminder becomes
expressible at that point.

---

## §12. Tests

- **New ACK_TYPES present + distinct string values**
  (`transportation_nonroutine_per_trip`,
  `water_activities_off_premises_per_trip`).
- **Both added to `ENROLLMENT_CONSENT_TYPES` AND to
  `PER_OCCURRENCE_TYPES`.**
- **Verdict exclusion tests:**
  - A child with NO rows of either per-occurrence type → verdict
    reports NEITHER as pending NOR expired. The
    `enrollment_consents_pending` / `_expired` arrays do not contain
    the per-occurrence types regardless of input.
  - A child with N active per-occurrence rows of the same type →
    verdict still does NOT count them. No "any_pending = true" from
    per-occurrence row presence.
  - Phase A/B types behavior is identical pre- and post-Phase-C
    (the filter doesn't affect them).
- **Empty-breakdown shape tests:**
  - `pending_enrollment_consents` keys = `field_trip_permission`,
    `transportation_routine_annual`,
    `water_activities_on_premises_seasonal` ONLY. Per-occurrence
    types are NOT keys in this breakdown.
  - `per_occurrence_consents_recorded` (new informational field) is
    present with the two per-occurrence type keys initialized to 0.
- **Index relaxation tests** (require live DB or migration mock):
  - Two active rows of `transportation_nonroutine_per_trip` for the
    same child → no constraint violation.
  - Two active rows of `field_trip_permission` for the same child →
    UNIQUE violation (durable type uniqueness preserved).
- **`occurrence_metadata` jsonb roundtrip tests:**
  - Insert with a jsonb body for a per-occurrence type → row stores
    the body.
  - Phase A/B type inserts leave the column NULL.
- **Backward-compat tests:**
  - Every Phase A test passes unchanged.
  - Every Phase B test passes unchanged.
  - Audit-state return shape includes the new
    `per_occurrence_consents_recorded` field but every existing
    field is preserved with its existing values.
- **Build clean, vitest green, lint passes (`--max-warnings 0`).**

---

## §13. Out of scope (explicitly deferred)

Named so they're not silently absorbed into Phase C.

- **Medication (PR #20).** R 400.1931's per-medication permission +
  per-dose log + topical-OTC exemption + role-gated administration.
  PR #20 designs its own tables (`medication_authorizations` +
  `medication_administration_events`) and a DB trigger. Sidesteps
  the index-relaxation problem entirely. See
  `docs/pr-20-medication-log-scope.md`.
- **Three-state photo consent** (🟢 green / 🟡 yellow / 🔴 red).
  Captured in the messaging photo-consent reminder PR's PART 2.
  Independent of Phase C's per-occurrence work.
- **Licensing-consultant policy questions** (still parked from
  Phase B):
  - Does provider-attestation satisfy parent-signed for **renewal**
    (Phase B's parked question)?
  - Whether "season" gets a formal definition that changes Phase B's
    water-cadence interpretation (Phase B decision 3's single knob).
- **Trips / events entity.** A future PR may introduce one for
  cross-cutting purposes (attendance, vehicle records,
  cross-referenceable destinations). Phase C is forward-compatible
  with that future entity but does not introduce it. See
  §9-NonForeclosure.
- **Per-occurrence reminders.** Reminders before scheduled trips
  cannot be expressed without knowing the trip is scheduled in the
  first place. Deferred to the trips entity's PR.
- **Per-occurrence audit (trip occurred without recorded consent).**
  Requires a trip-record source of truth. Same deferral.
- **`PARENT_SIGNED_TYPES` membership.** Per Phase B's resolved
  conflict, per-occurrence types are NOT added to
  `PARENT_SIGNED_TYPES` — that constant is bound to the R 400.1907
  intake bundle. Channel-aware satisfaction is handled by
  `PARENT_SIGNED_SATISFYING_CHANNELS` directly inside the verdict,
  same as `field_trip_permission`.

---

## Halt for review — show

When CC picks this up for the build PR:

1. The two new types + where wired (added to
   `ENROLLMENT_CONSENT_TYPES` AND `PER_OCCURRENCE_TYPES`, NOT to
   `PARENT_SIGNED_TYPES`).
2. The migration file (atomic DROP + CREATE INDEX in a single
   transaction; ADD COLUMN occurrence_metadata jsonb; header
   comment matching 024 style; runbook entry).
3. The verdict-function exclusion (filter via `PER_OCCURRENCE_TYPES`
   set; same exclusion in `emptyEnrollmentConsentsBreakdown`).
4. The audit-state's new informational field
   (`per_occurrence_consents_recorded`) — explicitly NOT a
   compliance signal.
5. The modal's per-occurrence recording section (record + recent N
   list) and the parent panel's filtering.
6. Test coverage matching §12, including the index-relaxation
   tests against a live DB or mock.
7. Confirmation no Phase A or Phase B test broke; backward-compat
   invariant holds.

Do NOT deploy or merge until verification screenshots are in hand
per `CLAUDE.md`'s verification-gap rule. The index swap is the most
delicate migration of the three phases — verify the new index's
definition AND verify the durable-type uniqueness still rejects
duplicates.

---

**End of Phase C scope document — FINAL.** All decisions locked.
Ready to hand to CC for the build PR after Phase B's migration 026
is applied and verified. The migration is the next artifact, written
from §10's planning sketch.
