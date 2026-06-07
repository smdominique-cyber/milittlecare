# Phase 3.1 — In-app guidance text · consultant review worksheet

> **DRAFT for licensing-consultant review.**
> This is draft in-app guidance text that will tell a Michigan licensed
> home-daycare provider how to resolve each compliance gap surfaced
> by the MILittleCare Compliance Checklist. Please confirm each is
> accurate to current MiLEAP/LARA licensing rules (R 400.1901–1963,
> effective 2026-04-27) AND/OR the CDC Scholarship Handbook
> (revised quarterly — see maintenance note below), or correct it.
> Where this worksheet asks a specific question, a one-line answer
> is enough — "confirmed" or a corrected version of the sentence.
> Citations are CC's best read of the rules; flag any that are wrong.
>
> **39 rows** (was 40 — `funding_dhs_198_on_file` removed
> 2026-06-06 per the CDC-layer correctness pass, see Maintenance
> Notes #3 below). Grouped A–H by the surface the provider goes to
> in order to fix the gap. Within each group the entries follow
> registry order. The deferred religious-objection row from Phase 1
> §6 is not in this worksheet (it isn't in the registry yet).
>
> Provider's experience: each row in the table below shows up as a
> short labeled line in the provider's Compliance Checklist with a
> red / amber color + a "How to resolve" sentence (the DRAFT
> GUIDANCE quoted in each entry) + an "Open [destination]" button
> (the FIX TARGET shown). The consultant's job: confirm the
> sentence is right and the destination matches the obligation.
>
> | Mark | Meaning |
> | --- | --- |
> | ✅ Confirmed | The guidance copy + cite + fix target are correct as-drafted. |
> | ✏️ Corrected → [corrected text] | The guidance/cite needs the consultant's correction. |
> | ⚠️ Reword → [reworded sentence] | The sentence is technically correct but reads wrong to a provider — softer/sharper rewrite. |
> | ❌ Wrong rule | The cited rule/handbook reference is not the controlling one. |

## Maintenance notes (read once, then refer to as needed)

**1 — CDC-sourced citations need quarterly verification.** Rows
**F1, F2, G2, G3, G4, H1** derive from the **CDC Scholarship Handbook**
(for Licensed Providers and/or for LEPs). The handbook is revised
**quarterly — Jan 1 / Apr 1 / Jul 1 / Oct 1.** Mark these as
"verify each quarter" in your compliance calendar; the in-app
guidance will rot otherwise. R 400 licensing citations (the rest
of the worksheet) are stable and don't need this rhythm.

**2 — H1's "is this licensing?" question is RESOLVED.** Earlier
revisions of this worksheet asked whether daily parent
acknowledgment of attendance was a R 400.1906 licensing obligation
or a CDC billing audit-trail requirement. **Answer: CDC billing
audit-trail.** The H1 entry below has been re-cited from R 400.1906
to the CDC Scholarship Handbook, and the engine row is now gated
on ≥1 active CDC funding source (commit `a0ed236`). A private-pay-
only provider should NOT see H1 as applicable.

**3 — `funding_dhs_198_on_file` (was G1) REMOVED.** The DHS-198 is
MDHHS's authorization NOTICE TO the provider, not a document the
provider fills out, signs, or uploads. It's an input the provider
receives, not a compliance obligation they fulfill — so it never
belonged on a compliance checklist. The registry row + tests +
worksheet entry are deleted. The underlying funding-document
vault feature (migration 008 + `FundingDocumentSlot` UI) still
ships and remains useful for providers who want to file their
DHS-198 copies — it just no longer surfaces as a compliance gap.

**4 — §2a three-way fix on G2/G3/H1 is BLOCKED on a loader
shape change.** During this correctness pass the engine's
applicability rules for the CDC-gated rows (G1—deleted, G2, G3,
H1) were audited for §2a compliance. The engine's loader
(`src/lib/complianceStateLoader.js` lines 43-56) returns `[]` for
three structurally indistinguishable cases: PostgREST error, thrown
exception, and "loaded successfully, zero rows." The resolver
cannot tell "private-pay-only provider" from "loader failed" from
the sourceRows it sees. Per the §2a principle ("never silently
resolve to does_not_apply"), the right fix is a loader shape
change to surface `{ rows: [], loaded: true/false }` (or a separate
loaded-keys Set) — that's its own decision, not in this pass. **The
worksheet entries below for G2 / G3 / H1 note this open
question** but the engine continues to return DOES_NOT_APPLY for
the absence-of-CDC case across all four rows consistently. The
practical effect: a transient loader failure on a CDC provider's
account would silently misclassify their CDC rows as "doesn't
apply." Worth knowing when reviewing live gates.

**5 — First-year LEP nuance on F1.** Per the CDC LEP handbook, an
LEP's MiRegistry annual ongoing training obligation begins the
calendar year AFTER enrollment/reenrollment — a brand-new LEP is
not subject to the Dec 16 deadline in their first partial year.
The engine **cannot precisely detect first-year LEPs today** — no
field on `profiles` records the MDHHS LEP enrollment date.
`profile.created_at` is when the MILittleCare account was created,
which is a bad proxy (a long-time LEP joining MILC last week would
falsely read as "first year"). The F1 guidance copy below carries
the nuance ("If you enrolled this calendar year, the Dec 16
deadline begins next year — verify against your records"); a
future migration adding `profiles.lep_enrollment_calendar_year`
would let the engine handle this precisely.

---

## Table of contents

- [Group A — Intake bundle (10 rows)](#group-a--intake-bundle-10-rows)
- [Group B — Children record annual fields (2 rows)](#group-b--children-record-annual-fields-2-rows)
- [Group C — Enrollment / operational consents (6 rows)](#group-c--enrollment--operational-consents-6-rows)
- [Group D — Medication (6 rows)](#group-d--medication-6-rows)
- [Group E — Staff files (9 rows)](#group-e--staff-files-9-rows)
- [Group F — MiRegistry tracker (2 rows)](#group-f--miregistry-tracker-2-rows)
- [Group G — Funding sources + CDC paperwork (3 rows — was 4; G1/DHS-198 removed)](#group-g--funding-sources--cdc-paperwork-3-rows--was-4-g1dhs-198-removed)
- [Group H — Attendance acknowledgments (1 row)](#group-h--attendance-acknowledgments-1-row)

Totals — **39 rows for consultant review** (was 40 — G1 removed
per Maintenance Note #3). Highest-stakes copy flagged inline (legal
exposure on medication role-gate; deadline consequences on
MiRegistry annual ongoing).

---

## Group A — Intake bundle (10 rows)

These are the parent acknowledgments that comprise R 400.1907's
child-in-care statement bundle. The provider captures them through
the **Families → child profile → Intake** flow.

---

### A1 — Child-in-care statement (envelope)

- **`requirement_key`:** `child_in_care_statement_envelope`
- **Rule citation (drafted):** R 400.1907
- **Gap state(s):** `missing_required` (no envelope captured yet) /
  `pending_parent` (provider attested but parent hasn't signed).
- **DRAFT GUIDANCE:** *"Send the parent the intake bundle so they
  can sign the child-in-care statement (and the eight
  sub-acknowledgments under R 400.1907)."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Does the voice ("Send the parent the
  intake bundle") accurately describe what providers who exclusively
  use **in-person paper** need to do? If not, recommend the
  channel-agnostic rewrite — e.g. *"Capture the parent's signatures
  on the eight items in the R 400.1907 child-in-care statement
  bundle."*
- **Consultant mark:** [ ]

---

### A2 — Lead-based paint disclosure (inform-only)

- **`requirement_key`:** `intake_lead_disclosure`
- **Rule citation (drafted):** R 400.1913
- **Gap state(s):** `missing_required` (home pre-1978 + no
  disclosure captured) / `pending_parent` / `unknown
  awaiting-provider-input` (provider hasn't answered the
  `home_built_before_1978` question yet).
- **DRAFT GUIDANCE:** *(missing / pending)* *"Capture the parent's
  signature on the lead-paint disclosure. R 400.1913 requires it
  for homes built before 1978."* *(awaiting)* *"Tell us whether
  your home was built before 1978 — that determines whether lead
  disclosure applies."*
- **Fix target:** *(missing/pending)* Families → this child →
  Intake. *(awaiting)* Business Info → Premises.
- **SPECIFIC QUESTION:** Is **R 400.1913** the controlling rule
  for the lead-paint disclosure obligation, applied to homes built
  before 1978? If a different clause governs (e.g. a federal cite
  rather than MiLEAP), correct it.
- **Consultant mark:** [ ]

---

### A3 — Firearms-on-premises disclosure

- **`requirement_key`:** `intake_firearms_disclosure`
- **Rule citation (drafted):** R 400.1916
- **Gap state(s):** `missing_required` / `pending_parent` /
  `unknown awaiting-provider-input` (provider hasn't answered
  `firearms_on_premises` yet).
- **DRAFT GUIDANCE:** *(missing / pending)* *"Capture the parent's
  signature on the firearms disclosure. The copy on the disclosure
  form varies depending on your firearms answer in Business Info —
  R 400.1916."* *(awaiting)* *"Tell us whether firearms are present
  on your premises — that determines the disclosure copy."*
- **Fix target:** *(missing/pending)* Families → this child →
  Intake. *(awaiting)* Business Info → Premises.
- **SPECIFIC QUESTION:** Is **R 400.1916** the controlling rule
  for the firearms-on-premises parent disclosure that must
  accompany the child-in-care statement? If the obligation lives in
  R 400.1907 itself (rather than 1916), correct the citation.
- **Consultant mark:** [ ]

---

### A4 — Agreement on who provides food

- **`requirement_key`:** `intake_food_provider_agreement`
- **Rule citation (drafted):** R 400.1907(1)(b)(ii)
- **Gap state(s):** `missing_required` / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's signature on the
  food-provider agreement — who provides each meal
  (R 400.1907(1)(b)(ii))."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Is sub-clause **(ii)** of R 400.1907(1)(b)
  the correct location of the "agreement on who provides food"
  obligation in the **2026-04-27** rule revision? (Some prior
  source documents had this at (i), (ii), or (iii) depending on
  rule version.)
- **Consultant mark:** [ ]

---

### A5 — Notice of licensing notebook availability

- **`requirement_key`:** `intake_licensing_notebook_availability`
- **Rule citation (drafted):** R 400.1907(1)(b)(vii) + R 400.1906(3)
- **Gap state(s):** `missing_required` / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's acknowledgment that
  they were notified of your licensing notebook's availability per
  R 400.1907(1)(b)(vii) + R 400.1906(3)."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Are **both** citations correct —
  R 400.1907(1)(b)(vii) for the parent acknowledgment AND
  R 400.1906(3) for the notebook contents — and is showing both to
  the provider helpful or noise? (Recommend keeping both for audit
  defensibility; consultant overrides if not.)
- **Consultant mark:** [ ]

---

### A6 — Offer of licensing rules copy

- **`requirement_key`:** `intake_licensing_rules_offered`
- **Rule citation (drafted):** R 400.1907(1)(b)(iii)
- **Gap state(s):** `missing_required` / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's acknowledgment that
  they were offered a copy of the licensing rules per
  R 400.1907(1)(b)(iii)."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Is *"offered a copy"* the correct
  rendering of (iii)? Or is the obligation stronger — e.g. *"must
  provide the rules upon request"* / *"must provide a copy at
  intake"* — that the guidance should reflect?
- **Consultant mark:** [ ]

---

### A7 — Infant safe sleep practices (children under 18 months)

- **`requirement_key`:** `intake_infant_safe_sleep`
- **Rule citation (drafted):** R 400.1930
- **Gap state(s):** `missing_required` / `pending_parent`
  (applicability gated by child age < 18 months at acknowledgment
  time).
- **DRAFT GUIDANCE:** *"Capture the parent's signature on the
  infant safe-sleep acknowledgment. R 400.1930 — applies until the
  child reaches 18 months."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Two parts. (a) Is **R 400.1930** the
  controlling citation for the infant safe-sleep parent
  acknowledgment? (b) Is **18 months** the correct age threshold
  for the obligation, or does the rule use a different age (e.g.
  12 months, 24 months)?
- **Consultant mark:** [ ]

---

### A8 — Acknowledgment of child health condition

- **`requirement_key`:** `intake_health_condition`
- **Rule citation (drafted):** R 400.1907(1)(b)(i)
- **Gap state(s):** `missing_required` / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's statement about the
  child's health condition at intake — R 400.1907(1)(b)(i)."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Is the obligation **a one-time statement
  at intake** (current guidance framing), OR is it **ongoing** —
  i.e. the parent must update the statement when the child's
  health condition changes? If ongoing, the guidance should say
  so.
- **Consultant mark:** [ ]

---

### A9 — Discipline policy receipt (parent at intake)

- **`requirement_key`:** `intake_discipline_policy_receipt`
- **Rule citation (drafted):** R 400.1907(1)(b)(iv)
- **Gap state(s):** `missing_required` / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's acknowledgment that
  they received your discipline policy — R 400.1907(1)(b)(iv).
  PR #17 will add a richer 'discipline policy receipt' surface
  separately."*
- **Fix target:** Families → this child → Intake.
- **SPECIFIC QUESTION:** Two parts. (a) Is sub-clause **(iv)**
  correct for the discipline-policy-receipt obligation in the
  2026-04-27 rules? (b) Drop the *"PR #17 will add a richer surface"*
  sentence from the in-app guidance — providers don't care about
  the MILittleCare roadmap. Confirm we should ship without that
  half-sentence.
- **Consultant mark:** [ ]

---

### A10 — Intake envelope is up to date (no drift)

- **`requirement_key`:** `child_in_care_statement_envelope_drift`
- **Rule citation (drafted):** R 400.1907 (derived — drift detector)
- **Gap state(s):** `pending_parent` — fires when the provider's
  premises answers (lead, firearms) or the child's age crossed the
  18-month line **after** the parent already signed the envelope,
  changing the required sub-types.
- **DRAFT GUIDANCE:** *"Premises or child-age info changed since
  this parent confirmed intake. Re-send the intake bundle so they
  can re-acknowledge — the engine detected drift in what's now
  required."*
- **Fix target:** Families → this child → Intake (re-send).
- **SPECIFIC QUESTION:** Does the word **"drift"** read as plain
  language to a Michigan provider, or is it confusing jargon?
  Recommend swapping the second sentence for *"What's required at
  intake changed since this parent signed — re-send so they can
  cover the new items"* if "drift" doesn't land.
- **Consultant mark:** [ ]

---

## Group B — Children record annual fields (2 rows)

These are columns on the `children` row (not acks). Provider edits
the child record directly.

---

### B1 — Immunization record (or waiver) on file

- **`requirement_key`:** `child_immunization_record`
- **Rule citation (drafted):** R 400.1907
- **Gap state(s):** `missing_required` (when
  `immunization_status` is null).
- **DRAFT GUIDANCE:** *"Record the child's immunization status —
  `up_to_date`, `waiver_on_file`, or `in_progress`. R 400.1907."*
- **Fix target:** Families → this child → child record.
- **SPECIFIC QUESTION:** Are the **three status values** —
  `up_to_date`, `waiver_on_file`, `in_progress` — the actual
  MiLEAP-accepted compliance statuses? Specifically: does
  **`in_progress`** count as compliant under R 400.1907, or must
  the child have completed immunizations OR a signed waiver on
  file (i.e., is `in_progress` actually a non-compliant state we
  shouldn't be offering as a clean choice)?
- **Consultant mark:** [ ]

---

### B2 — Annual review of child records

- **`requirement_key`:** `child_annual_record_review`
- **Rule citation (drafted):** R 400.1907 annual review
- **Gap state(s):** `expired` (`records_last_reviewed_on` > 12
  months) / `missing_required` (absent + child enrolled > 12
  months).
- **DRAFT GUIDANCE:** *(expired)* *"Mark this child's records as
  reviewed for the current year — R 400.1907 annual review."*
  *(missing)* *"Schedule an annual review of this child's records
  and update `records_last_reviewed_on` when complete."*
- **Fix target:** Families → this child → child record.
- **SPECIFIC QUESTION:** Does *"Mark this child's records as
  reviewed"* misrepresent the obligation by suggesting it's a
  one-click timestamp? The annual review is presumably a
  substantive review (verify ages, allergies, immunizations,
  emergency contacts are current). Recommend rewording the expired
  case to: *"Complete this year's review of the child's records,
  then update the review date — R 400.1907."* Confirm the
  reworded copy is correct.
- **Consultant mark:** [ ]

---

## Group C — Enrollment / operational consents (6 rows)

The five medium-risk consents (field-trip, transportation, water
activities) plus photo-sharing. Provider captures through Families
→ child profile → Consents.

---

### C1 — Non-vehicle field trip permission (at enrollment)

- **`requirement_key`:** `consent_field_trip_permission`
- **Rule citation (drafted):** R 400.1952(2)
- **Gap state(s):** `missing_required` / `pending_parent`. Also
  resolves to N/A if the provider answered "No" to the
  applicability question in Business Info → "What applies".
- **DRAFT GUIDANCE:** *"Capture the parent's signature on the
  field-trip permission for this child — R 400.1952(2). If you
  never run field trips, mark this 'No' in Business Info →
  'What applies to my program?'."*
- **Fix target:** Families → this child → Consents (with a
  secondary text mention of the Business Info opt-out).
- **SPECIFIC QUESTION:** Per the rule text, is this consent
  captured **once at initial enrollment**, or does it need to be
  **annually renewed**, or **per trip**? The current guidance
  implies once-at-enrollment (the registry's category labels it
  "at enrollment"); confirm.
- **Consultant mark:** [ ]

---

### C2 — Routine transportation permission (annual)

- **`requirement_key`:** `consent_transportation_routine_annual`
- **Rule citation (drafted):** R 400.1952(1)(a)
- **Gap state(s):** `missing_required` (only when provider
  answered "Yes" to the routine-transport applicability question)
  / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's signature on the
  routine transportation permission — R 400.1952(1)(a). Annual
  baseline. Per-trip non-routine acks are captured separately when
  the trip happens."*
- **Fix target:** Families → this child → Consents.
- **SPECIFIC QUESTION:** Is **"annual"** the correct cadence for
  R 400.1952(1)(a) routine transportation, or does the rule allow
  a single sign at initial enrollment for the duration of the
  child's enrollment? (The registry uses an annual `expires_at`
  shape based on prior reading; confirm.)
- **Consultant mark:** [ ]

---

### C3 — On-premises water activities permission (annual / seasonal)

- **`requirement_key`:** `consent_water_activities_on_premises_seasonal`
- **Rule citation (drafted):** R 400.1934(10)(b)
- **Gap state(s):** `missing_required` (when provider answered
  "Yes" to the pool/water applicability question) /
  `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's seasonal signature on
  the on-premises water-activity permission — R 400.1934(10)(b).
  Per-trip off-premises water acks are captured separately."*
- **Fix target:** Families → this child → Consents.
- **SPECIFIC QUESTION:** Is the cadence **seasonal** (once per
  water season — spring/summer), or **annual** (once per
  calendar year regardless of season), or **per-activity**?
  And is **R 400.1934(10)(b)** the correct sub-clause given that
  R 400.1901(1)(yy) excludes water-tables/slip-and-slides/wading
  pools/sprinklers from the "water activity" definition?
- **Consultant mark:** [ ]

---

### C4 — Per-trip non-routine transportation consent (recency)

- **`requirement_key`:** `consent_transportation_nonroutine_per_trip_recency`
- **Rule citation (drafted):** R 400.1952(1)(b)
- **Gap state(s):** `not_applicable` (no recent trip acks exist —
  data-inferred negative) / `on_file` (recent trip acks exist).
  There is **no `missing_required` state** — per-trip permissions
  are captured at the time of each trip, not pre-emptively.
- **DRAFT GUIDANCE:** *(text-only)* *"Per-trip transportation
  permissions are captured at the time of each trip; this row
  shows 'on file' when recent trip records exist."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** Does treating per-trip non-routine
  transportation as a **backward-looking "on file when recent
  records exist"** row correctly model the rule? The obligation
  per R 400.1952(1)(b) is **per-trip permission BEFORE each
  non-routine trip**. So when a non-routine trip happens **without**
  a prior parent ack, that IS a violation — but the engine has no
  way to detect "a trip happened but the ack didn't" without trip
  records existing independently. Is the current data-inferred
  modeling acceptable, or do we need to flag this rule as
  something the engine cannot fully verify?
- **Consultant mark:** [ ]

---

### C5 — Per-trip off-premises water activity consent (recency)

- **`requirement_key`:** `consent_water_activities_off_premises_per_trip_recency`
- **Rule citation (drafted):** R 400.1934(10)(a)
- **Gap state(s):** Same shape as C4 — `not_applicable` / `on_file`.
  No `missing_required` state.
- **DRAFT GUIDANCE:** *(text-only)* Same shape as C4 (different
  rule clause).
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** Same as C4, applied to R 400.1934(10)(a)
  off-premises water. Is the data-inferred "on file if recent
  records exist" model acceptable for this rule, or does it
  understate the obligation?
- **Consultant mark:** [ ]

---

### C6 — Photo-sharing consent

- **`requirement_key`:** `consent_photo_sharing`
- **Rule citation (drafted):** None — provider-protective only.
- **Gap state(s):** `missing_required` (when not captured) /
  `pending_parent` / can be revoked.
- **DRAFT GUIDANCE:** *"Capture the parent's photo-sharing
  consent. If they decline (or revoke), the engine will record
  that as the active state — provider-protective, not
  licensing-required. R 400 is silent on this."*
- **Fix target:** Families → this child → Consents.
- **SPECIFIC QUESTION:** Per prior CC research (against both the
  2019 and 2026 rule sets), R 400 is silent on
  provider→parent digital photo sharing. **Confirm this is still
  accurate** in the 2026-04-27 revision (i.e. no new sub-rule
  added). If silent, is the *"provider-protective, not
  licensing-required"* framing useful or misleading? Recommend
  keeping if accurate.
- **Consultant mark:** [ ]

---

## Group D — Medication (6 rows)

R 400.1931 — the high-stakes category. Includes **A22 below — real
legal exposure**, flagged separately.

---

### D1 — Medication authorization on file

- **`requirement_key`:** `medication_authorization_for_authorization`
- **Rule citation (drafted):** R 400.1931(3)–(6)
- **Gap state(s):** `not_applicable` (no active authorization rows
  for the child) / `on_file` (authorization row exists).
- **DRAFT GUIDANCE:** *(text-only)* *"This row reflects whether a
  medication-authorization record exists for the child. Add one
  via the medication modal when the child takes medication."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** Is the text-only treatment correct? Or
  should this row prompt the provider to **capture authorization
  paperwork as part of intake** when intake metadata mentions
  "regular medication" — i.e. a child whose intake notes a known
  regular medication BUT has no authorization on file is arguably a
  gap, not a "not applicable." Confirm whether the engine should
  surface this as actionable or stay text-only.
- **Consultant mark:** [ ]

---

### D2 — Per-medication parent permission (non-OTC)

- **`requirement_key`:** `medication_permission_per_authorization`
- **Rule citation (drafted):** R 400.1931(2)
- **Gap state(s):** `missing_required` / `pending_parent` /
  `pending_parent` reason `authorization-changed-since-permission`
  (drift — the dose/schedule/prescriber changed since the parent's
  last permission).
- **DRAFT GUIDANCE:** *(missing/pending)* *"Capture the parent's
  permission for this specific medication — R 400.1931(2)."*
  *(drift)* *"The medication's dose, schedule, or prescriber
  changed since the parent's last permission. Re-send for
  re-acknowledgment."*
- **Fix target:** Families → this child → Medication.
- **SPECIFIC QUESTION:** Two parts. (a) Is **R 400.1931(2)** the
  controlling sub-clause for per-medication parent permission? (b)
  When dose / schedule / prescriber changes mid-course, is
  **re-sending for re-acknowledgment** the legally-correct path, or
  does the rule allow a more graceful amendment — e.g. verbal
  parental authorization documented in the provider's records,
  with a follow-up signature within X days?
- **Consultant mark:** [ ]

---

### D3 — OTC-blanket parent permission (topical OTC)

- **`requirement_key`:** `medication_permission_otc_blanket`
- **Rule citation (drafted):** R 400.1931(8)
- **Gap state(s):** `missing_required` / `pending_parent`.
- **DRAFT GUIDANCE:** *"Capture the parent's blanket OTC topical
  permission (sunscreen / repellent / diaper rash cream) — covers
  all topical OTC collectively per R 400.1931(8) but doesn't waive
  the per-medication permission requirement."*
- **Fix target:** Families → this child → Medication.
- **SPECIFIC QUESTION:** Does R 400.1931(8) actually permit a
  **single covering permission** for sunscreen + repellent +
  diaper rash cream + similar topical OTC — i.e. a "blanket"
  permission — OR does each individual topical OTC item still need
  its own parent permission, with (8) only exempting them from
  subrules (1) (role-gate) and (7) (dose log)? CC's reading: (8)
  exempts from (1)+(7) but not (2), so the permission requirement
  still applies; the OPEN question is whether a single blanket
  consent form can cover multiple topical OTCs OR each needs its
  own. Confirm the correct interpretation.
- **Consultant mark:** [ ]

---

### D4 — Role-gate integrity (dose-administering staff eligibility) — **HIGH-STAKES**

- **`requirement_key`:** `medication_role_gate_integrity`
- **Rule citation (drafted):** R 400.1931(1)
- **Gap state(s):** `missing_required` reason
  `ineligible-role-administered-non-otc-dose` — fires when a past
  dose was administered by a caregiver without the eligible role
  (only licensees + child_care_staff_members may administer
  non-topical-OTC; the DB trigger blocks NEW ineligible
  administrations going forward).
- **DRAFT GUIDANCE:** *(guidance-only, no fix button)* *"An
  ineligible caregiver administered a non-OTC dose in the past.
  Document the corrective action in your records and confirm only
  licensees + child-care staff members administer non-topical-OTC
  medication going forward — R 400.1931(1). The DB trigger blocks
  new ineligible administrations; this row reflects historical
  evidence."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** **(High stakes — please answer
  carefully.)** When a historical ineligible-administration is
  discovered after the fact, is *"document the corrective action
  in your records and confirm staffing going forward"* the
  legally-correct provider response? Or does the obligation
  require **external reporting** — e.g. notifying MiLEAP, an
  incident report to the family, a medication incident form — that
  the in-app guidance should also reference? If external reporting
  is required, what is the precise instruction the guidance should
  give?
- **Consultant mark:** [ ]

---

### D5 — Original container attestation (per non-OTC authorization)

- **`requirement_key`:** `medication_original_container_attestation`
- **Rule citation (drafted):** R 400.1931(4)
- **Gap state(s):** `missing_required` (when the authorization
  row has `original_container_confirmed = false`).
- **DRAFT GUIDANCE:** *"Confirm the medication is stored in its
  original labeled container — R 400.1931(4). Update the
  authorization record after verifying."*
- **Fix target:** Families → this child → Medication.
- **SPECIFIC QUESTION:** What is the rule's **precise phrasing**
  for the container requirement? "Original labeled container" is
  CC's draft. The rule may say something more specific —
  *"manufacturer's original container labeled with the child's
  name and dosing instructions"* or similar. Provide the exact
  phrase the consultant would put on a paper attestation, and
  we'll mirror it.
- **Consultant mark:** [ ]

---

### D6 — Dose log retention (per non-OTC authorization)

- **`requirement_key`:** `medication_dose_log_retention`
- **Rule citation (drafted):** R 400.1931(9)
- **Gap state(s):** Usually `on_file` (DB-enforced — archive-only,
  2-year retention) / `unknown` (rare anomaly: a dose event
  disappeared).
- **DRAFT GUIDANCE:** *(text-only — data anomaly variant when
  unknown)* *"This row reflects the dose log's retention state.
  The DB enforces archive-only + 2-year retention per
  R 400.1931(9). An 'unknown' state here means an event row
  disappeared — contact support."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** Two parts. (a) Is **R 400.1931(9)** the
  correct citation for medication-administration log retention?
  (b) Is **2 years** the correct retention period for dose-log
  records, or is the period longer (e.g. *"2 years after the child
  leaves care"*, *"4 years"*, etc.)?
- **Consultant mark:** [ ]

---

## Group E — Staff files (9 rows)

R 400.1919–1924. Per-caregiver compliance. Fix surface today:
Staff Training matrix + Team page (per-caregiver deep-link is
sub-work in 3.1's §4).

---

### E1 — Background check eligibility (per caregiver) — **HIGH-STAKES**

- **`requirement_key`:** `caregiver_background_check_eligibility`
- **Rule citation (drafted):** R 400.1919 + R 400.1903(1)(r)
- **Gap state(s):** `missing_required` / `expired` /
  `pending_parent` reason `pending` (background check is awaiting
  result).
- **DRAFT GUIDANCE:** *(missing/expired)* *"Record this
  caregiver's background-check eligibility result. R 400.1919 +
  R 400.1903(1)(r). An eligible determination is required BEFORE
  unsupervised contact with children."* *(pending)* *"This
  caregiver's background check is pending review — they may not
  have unsupervised contact until the determination comes back
  eligible."*
- **Fix target:** Staff Training (degraded — per-caregiver deep-
  link is sub-work).
- **SPECIFIC QUESTION:** Two parts. (a) Are **both citations**
  correct — R 400.1919 (background check rule) and R 400.1903(1)(r)
  (the definition / scoping clause)? (b) Is **"BEFORE unsupervised
  contact with children"** the correct legal threshold, or is the
  rule stricter — e.g. *"before any contact"* / *"before any work
  on premises"* / *"before hire"*?
- **Consultant mark:** [ ]

---

### E2 — CPR + pediatric first aid currency (per caregiver)

- **`requirement_key`:** `caregiver_cpr_first_aid_current`
- **Rule citation (drafted):** R 400.1924(8) + R 400.1920(3) + R 400.1921(3)
- **Gap state(s):** `missing_required` (no record) / `expired`
  (certification date past).
- **DRAFT GUIDANCE:** *"Record this caregiver's current CPR +
  pediatric first-aid certification (the expiration date printed
  on their card). R 400.1924(8) + R 400.1920(3) / R 400.1921(3)."*
- **Fix target:** Staff Training (degraded).
- **SPECIFIC QUESTION:** Which **caregiver roles** must have
  current CPR + pediatric first aid? CC's current registry
  applicability rule names the **licensee + child_care_staff_member**
  per R 400.1920(3) and R 400.1921(3). Are **assistants** and
  **volunteers with unsupervised access** also required to have
  it, or genuinely exempt? If others are required, the guidance
  needs to expand.
- **Consultant mark:** [ ]

---

### E3 — New-hire 14-topic training (per caregiver, 90-day deadline)

- **`requirement_key`:** `caregiver_new_hire_training_complete`
- **Rule citation (drafted):** R 400.1923
- **Gap state(s):** `missing_required` (incomplete) / `expired`
  (90 days elapsed without completion) / `unknown` reason
  `caregiver-missing-date-of-hire` (the `needs_provider_data`
  bucket — provider can add the hire date themselves).
- **DRAFT GUIDANCE:** *(missing/expired)* *"Record completion of
  the 14 mandated new-hire training topics for this caregiver.
  R 400.1923. Must be done within 90 days of hire AND before
  unsupervised care."* *(needs_provider_data)* *"This caregiver is
  missing their hire date. Edit the caregiver record and set
  `date_of_hire` — the engine needs it to track the 90-day
  new-hire window."*
- **Fix target:** *(missing/expired)* Staff Training (degraded).
  *(needs_provider_data)* Team (degraded — per-caregiver
  deep-link is sub-work).
- **SPECIFIC QUESTION:** Three parts. (a) Is **14** the correct
  topic count under R 400.1923 (not 13, 15, etc.)? (b) Is the
  deadline **"within 90 days of hire AND before unsupervised
  care"** — both conditions — or is one of them sufficient? (c)
  Should the **14 topics themselves** be listed in the in-app
  guidance, or is the topic list better as a separate provider
  reference?
- **Consultant mark:** [ ]

---

### E4 — MiRegistry account & membership (per caregiver, ≥30-day)

- **`requirement_key`:** `caregiver_miregistry_account`
- **Rule citation (drafted):** R 400.1922
- **Gap state(s):** `missing_required` / `expired` (status =
  `expired`). Type 1 mirror (MiRegistry is the system of record).
- **DRAFT GUIDANCE:** *"Confirm this caregiver's MiRegistry
  account status (`submitted` / `materials_received` /
  `awaiting_print` / `current`) — R 400.1922. We mirror what you
  enter; verify in MiRegistry directly. 30-day window from
  employment."*
- **Fix target:** Staff Training (degraded).
- **SPECIFIC QUESTION:** Two parts. (a) Is the **30-day window
  from employment** correct, or does R 400.1922 use a different
  trigger — e.g. *"30 days from unsupervised contact"* or *"by
  hire date"*? (b) Are **`submitted` / `materials_received` /
  `awaiting_print` / `current`** the actual MiRegistry account
  statuses that compliance accepts, or is the list incomplete /
  named differently?
- **Consultant mark:** [ ]

---

### E5 — Professional development hours (per caregiver, annual)

- **`requirement_key`:** `caregiver_professional_development_hours`
- **Rule citation (drafted):** R 400.1924
- **Gap state(s):** `missing_required` (hours below role
  threshold for the current calendar year). Type 1 mirror.
- **DRAFT GUIDANCE:** *"Log this caregiver's professional-
  development hours for the current calendar year — R 400.1924.
  The required hour count varies by their regulatory role."*
- **Fix target:** Staff Training (degraded).
- **SPECIFIC QUESTION:** The guidance says *"varies by role"* but
  doesn't state the actual thresholds. Please provide the
  required hours per role: **licensee:** ___, **child_care_staff_member:**
  ___, **assistant:** ___, **volunteer_with_unsupervised_access:**
  ___. We'll bake the numbers into the in-app guidance so the
  provider knows the target.
- **Consultant mark:** [ ]

---

### E6 — Health & safety update acknowledgments

- **`requirement_key`:** `caregiver_health_safety_update_acked`
- **Rule citation (drafted):** R 400.1924(11)
- **Gap state(s):** `missing_required` reason `unacked-update`
  (per published MiLEAP update notice).
- **DRAFT GUIDANCE:** *"Acknowledge the published health-safety
  update for this caregiver — R 400.1924(11). MiLEAP publishes
  notices; each applicable caregiver must read and acknowledge
  within the notice's stated timeframe."*
- **Fix target:** Staff Training (degraded).
- **SPECIFIC QUESTION:** Two parts. (a) Is **(11)** the correct
  sub-clause for the health-safety-update acknowledgment
  obligation? (b) **How are these updates distributed** to
  providers in practice — email to the licensee from MiLEAP, posted
  to MiRegistry, posted to a state portal, mailed paper notices?
  We want the guidance to say *"You'll see new health & safety
  updates published in [the actual channel]"* — what's the right
  channel name?
- **Consultant mark:** [ ]

---

### E7 — Physician attestation of staff health (annual) — **rule citation unconfirmed**

- **`requirement_key`:** `caregiver_physician_attestation_annual`
- **Rule citation (drafted):** ❓ (Phase 1 marked as *"R 400.1933 (?)"*)
- **Gap state(s):** `unknown` reason `feature-not-yet-shipped` —
  PR #18 surface; no in-app capture flow today.
- **DRAFT GUIDANCE:** *(no fix button, informational variant)*
  *"Tracking ships with PR #18 (staff file gaps). Keep paper
  records of physician attestation of staff mental and physical
  health annually — an auditor will ask."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** **What is the controlling rule citation**
  for the annual physician attestation of staff mental + physical
  health? Phase 1 left it as a `?`. Once cited, the in-app
  guidance will read *"R 400.xxxx requires annual physician
  attestation of staff mental and physical health — keep paper
  records until tracking ships."*
- **Consultant mark:** [ ]

---

### E8 — Staff acknowledgment of discipline policy (at hire) — **rule unconfirmed**

- **`requirement_key`:** `caregiver_discipline_policy_ack_at_hire`
- **Rule citation (drafted):** ❓ (no citation in registry today)
- **Gap state(s):** `unknown` reason `feature-not-yet-shipped` —
  PR #17 surface.
- **DRAFT GUIDANCE:** *(no fix button)* *"Tracking ships with
  PR #17 (discipline policy receipt). Keep paper records of staff
  acknowledgment of your discipline policy at hire."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** Does Michigan **actually require** staff
  to acknowledge the discipline policy at hire (parallel to the
  parent intake-time acknowledgment in R 400.1907(1)(b)(iv))? If
  yes, what is the **controlling rule citation**? If no, this
  registry row should be removed in a future revision (the
  worksheet itself just confirms whether the obligation exists at
  all).
- **Consultant mark:** [ ]

---

### E9 — Daily arrival/departure log (per caregiver, operating days)

- **`requirement_key`:** `caregiver_daily_arrival_departure`
- **Rule citation (drafted):** R 400.1906
- **Gap state(s):** `unknown` reason `feature-not-yet-shipped` —
  PR #18 surface for non-app-user caregivers.
- **DRAFT GUIDANCE:** *(no fix button)* *"Tracking ships with
  PR #18 for non-app-user caregivers. App-user staff are covered
  today via the staff time-clock; non-app-user caregivers need
  paper records until the substrate ships."*
- **Fix target:** *(text-only — no button.)*
- **SPECIFIC QUESTION:** Is **R 400.1906** the correct citation
  for the daily caregiver arrival/departure log requirement? And
  does the rule **accept either electronic OR paper records**, or
  does it mandate a specific format the provider must use?
- **Consultant mark:** [ ]

---

## Group F — MiRegistry tracker (2 rows)

LEP-only (license-exempt providers). The MiRegistry tracker page
is the fix surface.

---

### F1 — MiRegistry annual ongoing training (Dec 16 deadline) — **HIGH-STAKES DEADLINE**

- **`requirement_key`:** `provider_miregistry_annual_ongoing`
- **Rule citation (updated 2026-06-06):** CDC Scholarship Handbook
  for LEP — Annual Ongoing Health & Safety Training (Dec 16 deadline).
  Was: *"LEP Handbook p.12"* — re-cited to the canonical handbook
  framing (the obligation is CDC-eligibility, not R 400 licensing).
- **Gap state(s):** `missing_required` (not completed this cycle)
  / `expired` (current cycle's Dec 16 deadline passed without
  completion). Type 1 mirror.
- **DRAFT GUIDANCE (updated 2026-06-06):** *"Complete the Michigan
  Ongoing Health & Safety Training Refresher and log the completion
  date — CDC LEP handbook Dec 16 deadline. Missing the deadline
  closes your CDC scholarship account; you'll need to complete the
  current year's training and re-enroll with MDHHS before resuming
  CDC billing. We mirror what you enter; verify in MiRegistry
  directly."* **First-year nuance (added 2026-06-06):** *"If you
  enrolled this calendar year, the Dec 16 deadline begins next
  year — verify against your enrollment records. The app cannot
  detect your enrollment year automatically yet."*
- **Fix target:** `/miregistry` page.
- **SPECIFIC QUESTION (revised 2026-06-06):** The Dec 16 deadline
  and the "account closes; reenrollment requires completing the
  current year's training" mechanic are now **CONFIRMED** per
  earlier consultant review — those parts no longer need a yes/no.
  The remaining ASK: **(a)** Is the **first-year nuance copy**
  ("If you enrolled this calendar year, the Dec 16 deadline begins
  next year") an accurate paraphrase of the handbook's "the
  calendar year AFTER enrollment/reenrollment" language? And
  **(b)** is *"reenroll with MDHHS"* the correct verb for the
  re-eligibility path, or should it be *"reapply"* / *"resubmit
  the eligibility application"*?
- **Consultant mark:** [ ]

---

### F2 — MiRegistry Level 2 currency (advisory — pay-rate tier)

- **`requirement_key`:** `provider_miregistry_level_2_currency`
- **Rule citation (updated 2026-06-06):** CDC Scholarship Handbook
  for LEP — Level 2 pay-rate tier. Reframed from *"LEP Handbook
  p.13 (rolling 10-hour)"* — see the next bullet.
- **Reframed 2026-06-06 (Part 4 of the CDC-layer correctness
  pass):** Level 2 is **OPTIONAL**. It's a higher-pay tier an LEP
  earns by completing 10 approved training hours per year. When
  Level 2 "expires," the consequence is the provider **drops to
  the Level 1 (base) pay rate** — they have NOT fallen out of
  compliance, the CDC account is NOT closed, and they are NOT in
  violation. The registry row's `severity` is now **`'low'`** to
  render in the soft/subtle treatment per the Phase 3.1 component
  contract's severity ladder (subtle link-style, not amber/red).
  The engine doesn't yet have an explicit `advisory` /
  `informational` state kind; if a future engine pass adds one,
  this row should adopt it.
- **Gap state(s):** `expired` (when
  `miregistry_level_2_expires_on` is past). Type 1 mirror. Rendered
  with `severity='low'`.
- **DRAFT GUIDANCE (updated 2026-06-06 for advisory tone):** *"Your
  Level 2 expiration date has passed — your CDC pay rate has
  dropped to Level 1 (base). This is NOT a compliance violation;
  Level 2 is the optional higher pay tier. Log 10 more approved
  training hours to reset the rolling clock and earn Level 2
  back, or stay at Level 1 if Level 2 isn't worth the time for
  you. We mirror what you enter; verify in MiRegistry directly."*
- **Fix target:** `/miregistry` page.
- **SPECIFIC QUESTION (revised 2026-06-06):** Two parts. (a)
  Confirm the **pay-rate drop is IMMEDIATE on the expiration
  date** (no grace period) — CC's understanding from the handbook
  is *"drops back to Level 1 effective that date."* (b) Confirm
  the "Level 2 is optional, not a compliance requirement" framing
  is the correct provider-facing voice — i.e. **this is a
  "money on the table" alert, not a delinquency**. If yes, the
  severity-low visual treatment + the rewritten guidance copy
  above are correct.
- **Consultant mark:** [ ]

---

## Group G — Funding sources + CDC paperwork (3 rows — was 4; G1/DHS-198 removed)

CDC Scholarship paperwork tied to each child's CDC funding source.
Fix surface today: Families → family → Funding tab.

> **G1 (`funding_dhs_198_on_file`) REMOVED 2026-06-06.** Per the
> CDC-layer correctness pass, the DHS-198 is MDHHS's authorization
> notice TO the provider (showing authorized hours / dates), not a
> document the provider fills out, signs, or uploads. It's an INPUT
> the provider receives, not an obligation they fulfill — so it
> doesn't belong as a compliance checklist row. The registry row,
> the three associated tests, and this worksheet entry are deleted.
> The underlying funding-document vault feature (migration 008 +
> `FundingDocumentSlot` UI + the funding-docs reminder catalog
> rows) still ships and remains useful for providers who want to
> file their DHS-198 copies — it just no longer surfaces as a
> compliance gap. See Maintenance Notes #3 at the top of this
> worksheet.

---

### G2 — Enrollment Agreement on file (per licensed CDC source)

- **`requirement_key`:** `funding_enrollment_agreement_on_file`
- **Rule citation (drafted):** CDC Handbook (not R 400)
- **Gap state(s):** `missing_required` / `expired`.
- **DRAFT GUIDANCE:** *"Upload the enrollment agreement for this
  CDC funding source — required for licensed-billing-basis CDC.
  Licensed Family Homes / Group Homes only."*
- **Fix target:** Families → this family → Funding tab.
- **SPECIFIC QUESTION:** Per CC's current registry rule, the
  Enrollment Agreement is **applicable only to licensed CDC
  sources** (where `details.billing_basis = 'enrollment'`), not
  all CDC. Confirm this licensed-only scoping is correct, or
  expand. Specifically: do LEPs **ever** need to upload an
  Enrollment Agreement (e.g. when they have a special case), or
  is the artifact purely a licensed-provider thing?
- **Consultant mark:** [ ]

---

### G3 — CDC authorization currency (per CDC funding source)

- **`requirement_key`:** `cdc_authorization_currency`
- **Rule citation:** CDC Scholarship Handbook (not R 400)
- **Gap state(s):** `expired` (`authorization_end` past) /
  `on_file` with `expiring_soon` flag (≤30 days) / `unknown`
  reason `no-authorization-end-on-funding-source`
  (`needs_provider_data` — the provider can add the end date
  themselves).
- **DRAFT GUIDANCE (re-scoped 2026-06-06 — Part 5 of the
  CDC-layer correctness pass):** *(expired)* *"This child's CDC
  authorization has expired and billing has stopped. The PARENT
  handles redetermination (they submit documentation; MDHHS
  begins eligibility review in the 11th month of each
  authorization cycle) — not the provider. Make sure the parent
  knows redetermination is due, and update the authorization end
  date here once the new approval comes through. Questions about
  authorization: MDHHS, 844-464-3447."* *(expiring_soon)*
  *"Authorization expires in N days — confirm the parent has
  started redetermination with MDHHS. The provider doesn't
  process redetermination; the parent does."*
  *(needs_provider_data)* *"This CDC funding source is missing
  its authorization end date. Edit the funding source and set
  `authorization_end` so the engine can track expiry. Find the
  end date on the parent's MDHHS authorization notice."*
- **Previous (incorrect) drafting said the provider should
  *"process redetermination with MDHHS."* That was wrong —
  redetermination is the parent's responsibility, not the
  provider's. The corrected copy above scopes the obligation to
  what the provider actually does (track the date, know that
  billing stops when the auth lapses) vs what the parent does
  (submit redetermination paperwork).
- **Fix target:** Families → this family → Funding tab.
- **SPECIFIC QUESTION (revised 2026-06-06):** **(a)** Confirm the
  parent-vs-provider role split as drafted: parent handles
  redetermination (submits docs starting 11th month), provider
  keeps the authorization end date current + is aware billing
  stops on lapse. **(b)** Confirm **MDHHS at 844-464-3447** is
  the correct contact number for authorization questions (we
  pulled this from the CDC Scholarship Handbook). **(c)** Is the
  word **"redetermination"** the current handbook's terminology,
  or has it been renamed (e.g. "renewal" / "reauthorization")?
- **Consultant mark:** [ ]

---

### G4 — CDC fingerprint reprint currency (5-year cycle)

- **`requirement_key`:** `cdc_fingerprint_reprint_currency`
- **Rule citation (updated 2026-06-06):** CDC Scholarship Handbook
  (5-year cycle, all CDC providers). Was: *"CDC Handbook (5-year
  cycle, LEP)"* — re-scoped.
- **Corrected 2026-06-06 (Part 6 of the CDC-layer correctness
  pass):** Pre-correction, the engine row was **LEP-only**. That
  was wrong. Per the CDC Scholarship Handbook, **all CDC
  providers** (LEPs AND licensed Family Home / Group Home) plus
  their staff plus household members who were fingerprinted prior
  to April 2024 need a 5-year re-fingerprint background check.
  Licensed Family Home / Group Home providers with CDC are
  equally subject. The registry applicability now gates on **CDC
  enrollment only** (plus license-status being answered;
  otherwise `unknown` per §2a). The label dropped *"(LEP only)"*.
- **Gap state(s):** Multi-band ladder (info → warning → urgent →
  critical → expired) per the severity logic in
  `cdcProviderCompliance.js`.
- **DRAFT GUIDANCE (updated 2026-06-06):** *"Your fingerprint
  reprint is on a 5-year cycle. The current state of your
  `fingerprint_date` field tells the engine how close you are —
  update after each reprint. Applies to YOU (the licensee), your
  STAFF, and HOUSEHOLD MEMBERS who were originally fingerprinted
  before April 2024."*
- **Fix target:** Business Info → Licensing tab (provider-level
  field; not per-family). **Note:** the `?section=licensing` deep-
  link is a 3.1 sub-work item (Phase 3.1 scope doc §4.2 B-1
  extends `?section=` to BusinessInfo) — confirm the target before
  the row's button ships.
- **SPECIFIC QUESTION (revised 2026-06-06):** Two parts. **(a)**
  Confirm the **April 2024** prior-fingerprint cutoff in the
  guidance copy — that's the trigger date for the 5-year reprint
  requirement per CC's read of the handbook. **(b)** Confirm
  the reprint requirement extends to **staff and household
  members**, not just the licensee — the engine currently only
  tracks the licensee's `fingerprint_date`; if staff/household
  members are also tracked separately (e.g. via the caregivers
  table) the engine would need additional rows or the guidance
  would need to point at a separate tracking surface.
- **Consultant mark:** [ ]

---

## Group H — Attendance acknowledgments (1 row)

The daily attendance audit-trail row. Per (child, day, segment).
Fix surface: provider can run an override from `/acknowledgments`;
parent acks via `/parent/acknowledge`.

---

### H1 — Daily attendance parent acknowledgment (CDC-gated)

- **`requirement_key`:** `attendance_parent_acknowledgment_per_day`
- **Rule citation (updated 2026-06-06):** **CDC Scholarship
  Handbook (daily attendance audit trail).** Was: *"R 400.1906
  (audit trail)"* — re-cited. See Maintenance Notes #2 at the top
  of the worksheet.
- **Gap state(s):** `missing_required` (parent hasn't ack'd) /
  `pending_parent` (provider_override on file but no parent
  signature). **Now gated on ≥1 active CDC funding source** —
  private-pay-only providers and CDC-less providers see
  `not_applicable`.
- **DRAFT GUIDANCE:** *(missing)* *"This day's attendance for a
  CDC-enrolled child hasn't been acknowledged by the parent yet.
  Either prompt the parent (the existing acknowledgment digest
  cron sends weekly), or run a provider override with a
  documented reason if the parent is genuinely unreachable. CDC
  billing audit trail."* *(pending)* *"Provider override is on
  file but the parent hasn't acknowledged. This usually clears
  when they next open the portal."*
- **Fix target:** `/acknowledgments` (provider-side override
  surface).
- **STATUS:** The previous worksheet revision asked whether this
  was a R 400 licensing requirement or a CDC billing
  audit-trail expectation — the answer has been resolved as
  **CDC billing audit trail**. The engine row is now re-cited
  + CDC-gated (commit `a0ed236` on `feature/h1-cdc-gating`).
  Remaining ASK below.
- **SPECIFIC QUESTION (revised 2026-06-06):** Now that the row is
  CDC-billing-scoped (not R 400 licensing): **(a)** Confirm
  *"provider override with a documented reason"* is an acceptable
  substitute under the CDC billing audit-trail expectations when
  a parent is unreachable. **(b)** Is the timeframe expectation
  "daily by day of care" (engine assumption) — or does CDC accept
  weekly within X days / monthly? **(c)** Is *"acknowledgment
  digest cron"* the right name for the surface that prompts the
  parent — or does the provider call it something else (the
  weekly attendance email)?
- **Consultant mark:** [ ]

---

## End of worksheet

**39 rows for consultant review** (revised 2026-06-06 — see
Maintenance Notes #3 at the top):

| Group | Rows | High-stakes flag |
|---|---:|---|
| A — Intake bundle | 10 | — |
| B — Children record annual fields | 2 | — |
| C — Enrollment / operational consents | 6 | — |
| D — Medication | 6 | D4 (role-gate integrity — real legal exposure) |
| E — Staff files | 9 | E1 (background-check threshold) |
| F — MiRegistry tracker | 2 | F1 (Dec 16 deadline mechanic — partially confirmed; first-year nuance still open) |
| G — Funding sources + CDC paperwork | 3 *(was 4 — G1/DHS-198 removed)* | — |
| H — Attendance acknowledgments | 1 | H1 (was: "is this licensing?" — now RESOLVED as CDC billing audit trail; remaining ask is timeframe + override language) |
| **Total** | **39** | **3 high-stakes** *(was 4 — H1's foundational question is resolved)* |

Once each row carries a ✅ Confirmed or ✏️ Corrected mark + (where
applicable) the corrected sentence, the build PR for Phase 3.1
pulls the confirmed rows into the in-app guidance content map and
ships them. Rows still in DRAFT render text-only fallback per the
3.1 scope doc §6.2 / §9 Step 5.

**Don't forget the quarterly verification cadence (Maintenance
Note #1).** Rows F1, F2, G2, G3, G4, H1 derive from the CDC
Scholarship Handbook, which is revised Jan 1 / Apr 1 / Jul 1 /
Oct 1. After this consultant pass lands, set a recurring quarterly
reminder to re-verify those six CDC-sourced rows; R 400 rows are
stable and don't need this rhythm.
