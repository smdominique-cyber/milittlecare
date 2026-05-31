# Findings — Operational & Protective Consents Scope Prep

**Date assembled:** 2026-05-30
**Status:** Investigation-only. No code written, no scope decisions made,
no recommendations. Raw material for a future scoping pass with fresh
eyes.
**Repo state at investigation:** main @ `9e994d2` (post-merge of
PR #16's licensing-rules-offered + notebook-availability rename).

---

## 1. Existing Acknowledgments Engine — What's Already There

### 1.1 The catalog (`src/lib/acknowledgments.js`)

`ACK_TYPES` is the single source of truth for known acknowledgment
type strings. Currently enumerated (in declaration order):

```
CHILD_IN_CARE_STATEMENT          'child_in_care_statement'      envelope
LEAD_DISCLOSURE                  'lead_disclosure'              R 400.1907(1)(b)(vi)
FIREARMS_DISCLOSURE              'firearms_disclosure'          R 400.1907(1)(b)(v)
FOOD_PROVIDER_AGREEMENT          'food_provider_agreement'      R 400.1907(1)(b)(ii)
LICENSING_NOTEBOOK_AVAILABILITY  'licensing_notebook_offered'   R 400.1907(1)(b)(vii)  ← DB string preserved post-rename
LICENSING_RULES_OFFERED          'licensing_rules_offered'      R 400.1907(1)(b)(iii)
INFANT_SAFE_SLEEP                'infant_safe_sleep'            R 400.1930 (<18mo gate)
HEALTH_CONDITION                 'health_condition'             R 400.1907(1)(b)(i)
DISCIPLINE_POLICY_RECEIPT        'discipline_policy_receipt'    R 400.1907(1)(b)(iv) + PR #17
STAFF_DISCIPLINE_POLICY_RECEIPT  'staff_discipline_policy_receipt'   PR #17 future
MEDICATION_PERMISSION_OTC_BLANKET 'medication_permission_otc_blanket' PR #20 future
MEDICATION_PERMISSION            'medication_permission'             PR #20 future
```

`CHILD_IN_CARE_STATEMENT` is the **envelope row**. Its `snapshot_hash`
is `computeEnvelopeHash(sub-row-hashes)` — deterministic composition
of whatever sub-rows applied. The DB does not enforce envelope-vs-sub
structure; the application constructs the bundle and writes all rows
in a transaction (via the parent confirm path, the
`intake_confirm_for_parent` RPC).

The DB stores `type` as **free-text** per migration 024's design (no
CHECK enum). The application catalog above is the authoritative
validator. Adding a new string value requires no schema change.

### 1.2 The channel model

`acknowledgments.acknowledged_via` is `text NOT NULL` with a CHECK
constraint enumerating three values:

```
'parent_portal'     CHECK shape: acknowledged_by_user_id IS NOT NULL,
                                 provider_override_reason IS NULL
'provider_override' CHECK shape: provider_override_reason IS NOT NULL,
                                 length(trim(...)) > 0
'in_person_paper'   CHECK shape: acknowledged_by_label IS NOT NULL,
                                 length(trim(...)) > 0
```

(Migration 024, `acknowledgments_channel_shape` CHECK.)

`parent_portal` is the only channel that records the parent's actual
auth uid; the other two are provider attestations of an offline event.

### 1.3 `PARENT_SIGNED_TYPES` and the channel-aware audit
(`src/lib/childFiles.js`)

Two exported constants drive the channel-aware satisfaction rule:

```js
export const PARENT_SIGNED_TYPES = Object.freeze([
  'firearms_disclosure',           // (b)(v)
  'food_provider_agreement',       // (b)(ii)
  'licensing_notebook_offered',    // (b)(vii)
  'licensing_rules_offered',       // (b)(iii)
  'health_condition',              // (b)(i)
  'discipline_policy_receipt',     // (b)(iv)
])

export const PARENT_SIGNED_SATISFYING_CHANNELS = Object.freeze([
  'parent_portal',
  'in_person_paper',
])
```

Plus an unenumerated category implicit in the helper:
**inform-only** types (currently only `lead_disclosure`) — satisfied
by **any** active ack regardless of channel.

`getChildFilesAuditState` computes pending counts per child by:

1. Loading every active `(subject_id, type, acknowledged_via)` row.
2. Building two indexes per child:
   - `anyChannelByChild` — any active row, any channel
   - `parentSignedByChild` — only active rows whose channel is in
     `PARENT_SIGNED_SATISFYING_CHANNELS`
3. For each child, iterating `requiredSubTypesForChild({child, profile})`:
   - inform-only types (lead) check against `anyChannelByChild`
   - parent-signed types check against `parentSignedByChild`
4. Emitting:
   - `pending_lead_disclosures_count` (inform-only)
   - `pending_parent_signatures_count` (rollup of slots across all 6 parent-signed)
   - `pending_parent_signatures` (per-type breakdown object)
   - `children_with_pending_parent_signatures_count` (distinct children)

### 1.4 `requiredSubTypesForChild` — bundle composition

Pure function in `acknowledgments.js`. Takes `{ child, profile, today }`
and returns the array of required sub-types for THAT child. The
returned list is gating + always-required pushes:

```js
if (profile.home_built_before_1978 === true) req.push(LEAD_DISCLOSURE)
if (profile.firearms_on_premises === true || === false)
                                          req.push(FIREARMS_DISCLOSURE)
req.push(FOOD_PROVIDER_AGREEMENT)         // always
req.push(LICENSING_NOTEBOOK_AVAILABILITY) // always
req.push(LICENSING_RULES_OFFERED)         // always
req.push(HEALTH_CONDITION)                // always
req.push(DISCIPLINE_POLICY_RECEIPT)       // always
if (child.date_of_birth)
  if (ageInMonths < 18) req.push(INFANT_SAFE_SLEEP)
return req
```

The function is the **single intersection point** between bundle
composition and audit-state counting. Both the modal (writes the
bundle) and `getChildFilesAuditState` (counts what's required) read
from it.

### 1.5 The `intake_confirm_for_parent` RPC (migration 025)

SECURITY DEFINER, single transaction. Inputs: `p_child_id uuid, p_rows jsonb`.
Steps:

1. Authorization (raises on failure, does not silently no-op):
   `children.id = p_child_id AND parent_family_links.parent_id = auth.uid()
    AND pfl.status = 'active'`. Captures `children.user_id` as the
   server-authoritative `provider_id`.

2. Collect distinct `type` values from `p_rows` (jsonb array).

3. Archive **every** active row for `(provider_id, subject_type='child',
   subject_id=p_child_id, type IN <those types>)` — channel-agnostic.
   Defensive against double-trigger leftovers.

4. INSERT new rows with **server-overridden** security fields:
   - `provider_id`               ← server-looked-up
   - `subject_type`              ← `'child'`
   - `subject_id`                ← `p_child_id`
   - `acknowledged_by_user_id`   ← `auth.uid()`
   - `acknowledged_via`          ← `'parent_portal'`
   - `acknowledged_at`           ← `now()`
   - `provider_override_reason`, `acknowledged_by_label` ← `NULL`
   - Parent JS contributes: `type`, `snapshot_hash`, `snapshot_version` only.

5. Resolve any `reminder_instances` with
   `subject_type='child' AND subject_id=p_child_id AND
    category='intake_acknowledgment_pending' AND resolved_at IS NULL
    AND archived_at IS NULL` in the same transaction.

### 1.6 The polymorphic schema (migration 024)

`acknowledgments` table columns (relevant subset):

```
id                       uuid PK
provider_id              uuid NOT NULL FK auth.users
type                     text NOT NULL    (free-text; app catalog validates)
subject_type             text             ('child' | 'caregiver' | 'family' |
                                            'medication_authorization' | NULL)
subject_id               uuid             (FK varies by subject_type;
                                            NULL for provider-level)
acknowledged_by_user_id  uuid             (auth.uid() for parent_portal)
acknowledged_by_label    text             (parent's name on paper)
acknowledged_via         text NOT NULL    CHECK enum (3 values)
acknowledged_at          timestamptz
provider_override_reason text
snapshot_hash            text             (drift detection)
snapshot_version         text             (copy version stamp)
archived_at              timestamptz      (soft-delete; never hard-delete)
created_at, updated_at   timestamptz
```

Partial unique indexes:
- `acknowledgments_active_unique`: `(provider_id, type, subject_type, subject_id)
  WHERE archived_at IS NULL AND subject_id IS NOT NULL`
- `acknowledgments_active_unique_no_subject`: `(provider_id, type)
  WHERE archived_at IS NULL AND subject_id IS NULL`

RLS:
- Provider SELECT/INSERT/UPDATE on rows where `provider_id = auth.uid()`
- Parent SELECT on rows whose `subject_id` is a child the parent is
  linked to via `parent_family_links (status='active')`
- Parent INSERT only allowed via the SECURITY DEFINER
  `intake_confirm_for_parent` RPC (parent has no direct INSERT policy
  — parent's UPDATE is also absent, which is what made the original
  archive-then-insert flow fail; the RPC bypasses that gap).

### 1.7 Intake-specific vs general

What the engine assumes generically (would generalize to new consent types):
- `(type, subject_type, subject_id)` polymorphism — any subject shape supported
- Channel model — three channels, channel-aware satisfaction rule
- Snapshot hash + version — drift detection works on any type
- Soft-delete via `archived_at` — works on any row
- Provider RLS — `provider_id = auth.uid()` works on any row

What is **intake-specific** (currently coupled to the child-in-care
statement bundle):
- `CHILD_IN_CARE_STATEMENT` envelope — the envelope construct is a
  bundle artifact. A standalone consent (single type per acknowledgment)
  wouldn't use an envelope.
- `requiredSubTypesForChild` — pushes the intake bundle's seven sub-types;
  a new consent type pushed here would be **bundled into the intake
  confirm flow** (parent confirms it as part of the same bundle).
- `intake_confirm_for_parent` RPC — explicitly named for intake; its
  archive scope is `(provider_id, child, type IN <types>)`. The
  channel forcing (`'parent_portal'`) and the
  `intake_acknowledgment_pending` reminder resolve are intake-specific.
  A different consent flow would either reuse this RPC (if it fits the
  same "parent confirms a set of types for a child" shape) or need a
  parallel RPC with its own auth + side effects.
- `getChildFilesAuditState`'s domain — `'child_files'`. A different
  consent category (e.g., per-trip transportation) wouldn't sit under
  this domain; PR #22 would need a new domain helper, OR this helper
  would grow new fields.
- `ChildIntakeModal` — the modal renders one card per child with a
  static set of "intake disclosures." A consent captured at trip-time
  (transportation, water activities, field trip) doesn't fit this UI.
- `ParentIntakeAcknowledgePage` — same shape constraint: it surfaces
  "intake acknowledgments needed for this child," not "consent for
  this specific trip."
- `reminder_instances.category = 'intake_acknowledgment_pending'` —
  the trigger and resolve paths key on this string. New consent
  categories would need their own reminder categories in
  `src/lib/reminderCategories.js`.

---

## 2. Rule Citations — VERBATIM REGULATORY TEXT

### IMPORTANT: I do not have access to verbatim rule text

The user's directive referenced "the R_400_1901__to_400_1963 doc."
That document is **not present in this repository**. I searched:
- `find` across the repo for files matching `*R_400*`, `*1901*`,
  `*1963*`, `*regulation*`, `*rules*1907*` — no matches.
- `docs/`, `docs/reference/`, `public/` — the only regulatory PDFs
  present are the Tri-Share / I-Billing operational docs and the
  Scholarship Handbook for License Exempt Provider. No copy of the
  child-care home licensing rules text.
- All `.md` files for verbatim rule quotes — the only verbatim
  regulatory text in the repo is in
  `docs/reference/staff_training_tracking_spec.md`, which quotes
  exactly two passages: R 400.1923(2)(l) and R 400.1931(1) — neither
  of which covers the four rules requested here.

What follows is a **map of what the repo says about each rule**
(paraphrased in roadmap docs, not verbatim regulatory text). **The
user must obtain the verbatim text from the rules PDF directly to
make the data-model decisions.** This findings doc surfaces only
what's in the repo.

### 2.1 R 400.1952(1) — Transportation

**Verbatim text:** NOT IN REPO. Must source from rules PDF.

**What the repo says (paraphrased, not regulatory):**

Source: `docs/milittlecare-roadmap-2026-05-29.md:136` and
`docs/prompts/milittlecare-roadmap-2026-05-29.md:85`:

> | Transportation | R 400.1952(1) | Annually (routine) + before each non-routine trip |

Source: `docs/regulatory-rule-mapping.md:76`:

> Rule 51 (transportation) — out of scope unless customers need transport tracking

(Note: `docs/regulatory-rule-mapping.md` calls it "Rule 51" while the
roadmap calls it R 400.1952. Numbering needs verification against the
actual rules PDF.)

Source: `docs/reference/staff_training_tracking_spec.md:35` — quotes
**R 400.1923(2)(l)** (training requirement), NOT 1952:

> "(l) Precautions in transporting children if the child care home provides transportation with children at any time."

### 2.2 R 400.1952(2) — Non-vehicle field trips

**Verbatim text:** NOT IN REPO. Must source from rules PDF.

**What the repo says (paraphrased, not regulatory):**

Source: `docs/milittlecare-roadmap-2026-05-29.md:137`:

> | Non-vehicle field trips | R 400.1952(2) | Once at initial enrollment |

### 2.3 R 400.1934(10) — Water activities

**Verbatim text:** NOT IN REPO. Must source from rules PDF.

**What the repo says (paraphrased, not regulatory):**

Source: `docs/milittlecare-roadmap-2026-05-29.md:138`:

> | Water activities | R 400.1934(10) | Per off-premises trip + once per season on-premises |

Source: `docs/regulatory-rule-mapping.md:45`:

> | Rule 34 | R 400.1934 | Water hazards, water activities | (Water safety) |

### 2.4 R 400.1931(2) — Medication

**Verbatim text:** NOT IN REPO for subsection (2). Only adjacent
subsection (1) is quoted.

**What the repo says about (2) (paraphrased, not regulatory):**

Source: `docs/milittlecare-roadmap-2026-05-29.md:139`:

> | Medication | R 400.1931(2) | Per-medication, prior written permission (has its own label/recordkeeping rules) |

Source: `docs/pr-20-medication-log-scope.md:13-15`:

> **Rule citation:** **R 400.1931 (Rule 31) — Medication administration.**
> - Written parent permission per medication (one-time per
>   medication/dose change at the parent-permission scope; PR #20
>   adds blanket-OTC variant via separate ack type).

**Verbatim text for subsection (1) (adjacent, for reference)** —
quoted in `docs/reference/staff_training_tracking_spec.md:52`:

> "Medication, prescription or nonprescription, must be given to a child in care by a licensee or a child care staff member only. A child care assistant or supervised volunteer shall not give medication to a child in care."

(This is **(1)** — administrator restriction. Subsection **(2)** —
parent permission — is the one needed for this scope and is NOT
quoted anywhere in the repo.)

---

## 3. Photo Consent

**Confirmation:** The Michigan child-care home licensing rules are
**silent** on photo sharing. No provision governs provider→parent
digital photo sharing. There is nothing to quote.

Source: `docs/milittlecare-roadmap-2026-05-29.md:143-148`:

> Generic photo-sharing consent. Licensing rules are SILENT on photo
> sharing (verified against both 2019 and 2026 rule sets — no provision
> governs provider→parent digital photo sharing). So no licensing
> requirement is being missed. But consent should still be captured for
> liability/parent-trust reasons — this is the app doing its job on
> something the code leaves to the provider.

**Existing photo-sharing feature location in code:**

Photo sharing currently lives in the messaging surface:
- `src/lib/messages.js`
- `src/pages/MessagesPage.jsx` (provider side)
- `src/pages/MessageThreadPage.jsx`
- `src/pages/ParentMessagesPage.jsx`
- `src/pages/ParentMessageThreadPage.jsx`

The `message_attachments` table is referenced from `src/lib/messages.js`
(per `docs/tech_debt.md`'s migration-folder-sync section). Attachments
are scoped to the message thread, which is scoped to a child. The
attachment flow today does not check any photo-sharing consent state —
attachments send regardless.

---

## 4. Wiring Surface — Checklist for a New Consent Type

For reference, the eight locations PR #16's types currently touch.
A new consent type that fits the existing engine's shape (i.e., would
be **bundled into the intake confirm flow** and **counted by
`getChildFilesAuditState`**) would need to touch all of these. A
consent type with different shape (e.g., per-trip, expires, separate
modal) would need additional surfaces not enumerated here.

| # | File | Change |
|---|---|---|
| 1 | `src/lib/acknowledgments.js` `ACK_TYPES` | Add new JS constant + DB string value + inline subitem comment |
| 2 | `src/lib/acknowledgments.js` `CHILD_IN_CARE_SUB_TYPES` | Add to the list if the type is part of the intake bundle |
| 3 | `src/lib/acknowledgments.js` `requiredSubTypesForChild` | `req.push(NEW_TYPE)` — gated or unconditional; determines when the new type is in the bundle for a given child |
| 4 | `src/lib/acknowledgments.js` payload-conventions comment | Document the per-type payload shape |
| 5 | `src/lib/childFiles.js` `PARENT_SIGNED_TYPES` | Add the DB string value if it's parent-signed; channel-aware audit picks it up automatically |
| 6 | `src/lib/childFiles.js` `ChildFilesPendingParentSignatures` typedef | Add the new key with subitem-tagged comment |
| 7 | `src/components/families/ChildIntakeModal.jsx` `SUB_TYPE_LABEL` + `SUB_TYPE_HELP` + `COPY_VERSIONS` + `subTypePayload` switch | Add the new type's UI strings + payload shape |
| 8 | `src/pages/ParentIntakeAcknowledgePage.jsx` `SUB_TYPE_LABEL` | Add the new type's parent-facing label |

**Test surfaces that need updates** (per the PR #16 precedent):
- `src/lib/acknowledgments.test.js` — always-required assertions, string-value invariants
- `src/lib/childFiles.test.js` — `emptyBreakdown()`, phase A/B/mixed bundle fixtures, channel-aware loop, rollup/children-affected counts
- `src/pages/ParentIntakeAcknowledgePage.mount.test.jsx` — bundle width assertion in the post-send-to-portal fixture

**What is NOT enumerated above** (because PR #16's types don't need them):
- Per-trip / recurring data model (no precedent)
- Expiry / refresh cadence (no precedent — every PR #16 type is sign-once)
- Trip metadata (date, destination, vehicle, water-body, etc.)
- Consent revocation flow (the existing soft-delete via `archived_at` exists, but no user-facing revoke surface)
- Reminder category for "consent expiring" or "consent needed for next trip"

---

## 5. Open Questions for the Human

These surfaced from the investigation. They are listed; **not answered**.

### 5a. Cadence modeling

The four licensing-required consents (per the repo's roadmap
paraphrase — verbatim rule text not available) imply at least four
distinct cadence shapes:

- **Transportation (R 400.1952(1)):** "Annually (routine) + before each non-routine trip"
  - Two distinct sub-cadences in one rule. Is this one consent type
    with two sub-modes, or two separate types
    (`transportation_routine_annual` + `transportation_nonroutine_per_trip`)?
  - "Annually" — calendar year boundary or rolling-365-day? Tied to
    enrollment anniversary, child's intake_completed_at, or the
    provider's own intake-year reset?

- **Non-vehicle field trips (R 400.1952(2)):** "Once at initial enrollment"
  - This is sign-once durable until child leaves. Fits the existing
    PR #16 shape. But: does "initial enrollment" mean
    `children.intake_completed_at` is set, or is there a separate
    enrollment event?

- **Water activities (R 400.1934(10)):** "Per off-premises trip + once per season on-premises"
  - Two sub-cadences again. "Per trip" implies trip metadata (date,
    location). "Once per season" requires a season-boundary model —
    what defines "season"? Calendar quarter, summer (May–Sept),
    swimming season per Michigan climate, or the provider's
    declaration?

- **Medication (R 400.1931(2)):** "Per-medication, prior written permission"
  - Already partially addressed by PR #20's scoped types
    (`MEDICATION_PERMISSION_OTC_BLANKET`, `MEDICATION_PERMISSION`) in
    the ACK_TYPES catalog — those exist as future consumers but the
    PR has not shipped. Open question: does the new consents PR
    coordinate with the PR #20 scope, supersede it, or stay
    disjoint?

### 5b. Per-child vs per-family vs per-trip subject scoping

The polymorphic `(subject_type, subject_id)` supports several shapes
but the current code only exercises a subset:

- **Per-child** (`subject_type='child'`): every existing PR #16 type
- **Per-caregiver** (`subject_type='caregiver'`): future PR #17 staff
  acks (not shipped)
- **Per-family** (`subject_type='family'`): no current consumer
- **Per-medication-authorization**
  (`subject_type='medication_authorization'`): future PR #20 (not shipped)
- **Provider-level** (`subject_type=null`): no current consumer; the
  unique partial index `acknowledgments_active_unique_no_subject`
  exists to support it

Open: a per-trip transportation consent could use
`subject_type='trip'` (new value, free-text accepted by the DB) with
`subject_id` pointing at a new `trips` table — or it could be
recorded against the child it applies to with metadata in the
payload. No precedent either way.

### 5c. Recurrence and expiry

`acknowledgments` has `archived_at` (soft-delete, retention) but no
`expires_at` or `valid_through` column. Every current type is
"durable until re-acknowledged manually" — the audit only checks
"is there an active row." For consents with a true expiry (annual
transportation, per-season water), where does the expiry live?

- On the row (new column)?
- Computed from `acknowledged_at + N` at read time?
- A separate `consent_validity` table?
- Encoded in the `type` string itself (e.g., a yearly type that
  rotates: `transportation_annual_2026`, then `_2027`)?

No code precedent.

### 5d. Structural difference: per-trip vs sign-once

A "sign once at enrollment" consent (like field trips per
R 400.1952(2)) writes one row that stays active. The intake confirm
flow handles it.

A "per-trip" consent (transportation non-routine, water off-premises)
writes one row PER TRIP, against PER TRIP subject metadata. The
existing flow has no concept of a "trip" record; the modal has no
trip-creation step; the parent-confirm RPC archives by `(type, child)`
which is wrong for per-trip semantics (a new trip's row shouldn't
archive the previous trip's row — both should remain active and
distinct).

Open: does a per-trip consent need (a) a new `trips` table the
consent rows reference, (b) trip metadata in the `payload` /
`snapshot_hash`, with subject_id still = child_id, or (c) a different
table entirely outside `acknowledgments`?

### 5e. Modal / UX surface

The current intake modal is a one-time-per-child static surface. A
per-trip consent needs a trip-creation surface that:
- Captures trip metadata before the consent fires
- Triggers per-parent consent collection (likely via the existing
  `intake_acknowledgment_pending`-style reminder, but a new category)
- Surfaces "consent pending" state to the provider before the trip
- Gates trip recording / attendance / billing if consent is missing

None of that exists today.

### 5f. Compliance score consumption (PR #22)

`getChildFilesAuditState` returns a fixed shape. A new consent
category — especially one with a different subject_type or a
non-`child_files` domain — would either:
- Be added to this helper (growing the shape — last expansion was
  controversial and a "Shape rationale" note was added)
- Live in a new domain helper (`getOperationalConsentsAuditState` or
  similar)

The roadmap doc (`milittlecare-roadmap-2026-05-29.md:161-166`)
specifies that 2a (licensing-required) and 2b (provider-protective)
must be tagged as **distinct categories** in #22 — but doesn't
specify the helper boundary.

### 5g. Photo-sharing revocation

The roadmap (line 150) says: *"Must be REVOCABLE — withdrawal should
actually stop sharing and be reflected in system state."* The
existing `archived_at` column supports archiving the row, but no
existing app path (messaging attachment send, parent gallery, future
photo features) consults consent state. Open: where does the
revocation check live, and how does it gate the messaging attachment
send path?

### 5h. Verbatim rule text source

The user's directive said *"Quote, don't paraphrase — I need the
literal regulatory language to decide the data model."* The verbatim
rule text for R 400.1952, R 400.1934(10), R 400.1931(2) is **not in
this repository.** The scoping pass tomorrow will need the rules PDF
on-hand to read the actual cadence verbs and subject phrasing — the
roadmap's paraphrase is enough to plan strategy but not enough to
pick the data model.

---

## 6. Files Referenced in This Investigation

Code (read-only, no changes):
- `src/lib/acknowledgments.js` — ACK_TYPES, CHILD_IN_CARE_SUB_TYPES, requiredSubTypesForChild
- `src/lib/childFiles.js` — PARENT_SIGNED_TYPES, PARENT_SIGNED_SATISFYING_CHANNELS, getChildFilesAuditState
- `supabase/migrations/024_child_files_and_acknowledgments.sql` — schema + RLS
- `supabase/migrations/025_intake_confirm_for_parent_rpc.sql` — the parent confirm RPC

Docs (read-only, no changes):
- `docs/milittlecare-roadmap-2026-05-29.md` — roadmap with cadence paraphrase
- `docs/prompts/milittlecare-roadmap-2026-05-29.md` — duplicate of the above in prompts/
- `docs/regulatory-rule-mapping.md` — rule-number → app-domain mapping (no verbatim text)
- `docs/pr-20-medication-log-scope.md` — medication scope (paraphrased)
- `docs/reference/staff_training_tracking_spec.md` — verbatim quote of R 400.1931(1) ONLY (not (2))
- `docs/licensed-home-compliance-audit-2026-05-23.md` — audit reference

NOT FOUND in repo (would be needed to complete §2 with verbatim text):
- Any file containing verbatim text of R 400.1952, R 400.1934, or
  R 400.1931(2). The "R_400_1901__to_400_1963 doc" referenced by the
  user is not present.

---

**End of findings document.** No build artifacts, no branch, no scope
proposal, no recommendations. Halt.
