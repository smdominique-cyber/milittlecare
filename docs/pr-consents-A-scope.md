# PR Scope — Consents Phase A: Photo-Sharing + Field-Trip Consent

**Date:** 2026-05-30
**Status:** Scope — ready to hand to CC.
**Branch (suggested):** `feature/consents-a-photo-fieldtrip`
**Builds on:** the PR #16 acknowledgments engine (ACK_TYPES catalog,
PARENT_SIGNED_TYPES, channel-aware audit, `intake_confirm_for_parent` RPC,
`requiredSubTypesForChild`). All currently on `main`.

---

## Why this is Phase A (and what's deferred)

The full consents roadmap covers seven consent needs. They split by DATA
SHAPE, not by topic — and the existing engine only supports one of the
shapes cleanly. This PR does ONLY the shape the engine already supports.

**Phase A (THIS PR) — sign-once, no time dimension:**
- Photo-sharing consent (durable, revocable)
- Field-trip blanket permission (once at enrollment, R 400.1952(2))

These need NO new schema, NO expiry concept, NO trips model. They are new
`ACK_TYPES` wired through the existing engine — the exact pattern shipped
twice on 2026-05-29 (licensing-notebook rename + licensing-rules-offered).

**Phase B (DEFERRED — separate PR) — time-bound recurring:**
- Routine transportation baseline ("at least annually," R 400.1952(1))
- On-premises water activities ("once per season," R 400.1934(10))
- Needs an `expires_at` / renewal concept the engine lacks today.

**Phase C (DEFERRED — separate PR, needs migration) — per-occurrence:**
- Non-routine transportation ("before each trip," R 400.1952(1))
- Off-premises water ("before each," R 400.1934(10))
- Medication (per-medication, R 400.1931(2))
- Needs a new trips/events/medication-instance dimension — the existing
  one-active-row-per-(type, child) shape CANNOT hold these. (A per-trip
  consent overwriting the prior trip's consent is a silent-data-loss bug;
  this is why it is NOT in Phase A.)

**Context:** the provider (Venessa) handles ALL of these manually on paper
today. Nothing is broken — Phase A ADDS digital capture where paper exists
now. No urgency pressure; paper keeps working while B and C are built right.

---

## The two consents in this PR

### 1. Field-trip blanket permission — `field_trip_permission`
- **Rule:** R 400.1907 is intake; the field-trip permission is R 400.1952(2):
  "At the time of initial enrollment, a licensee shall obtain written
  permission from a child's parent for the child to go on field trips that
  do not involve a vehicle."
- **Shape:** sign-once at enrollment. Parent-signed. Durable (no expiry).
- **Classification:** this is a LICENSING-REQUIRED consent (MiLEAP can ask
  for it). It is parent-signed — satisfied only by `parent_portal` /
  `in_person_paper`, NOT `provider_override` alone — same rule as the
  intake parent-signed types.

### 2. Photo-sharing consent — `photo_sharing_consent`
- **Rule:** NONE. Michigan licensing is SILENT on photo sharing (confirmed
  against both the 2019 and 2026 rule sets this session). This is a
  PROVIDER-PROTECTIVE consent (liability / parent trust), not a
  licensing requirement.
- **Shape:** sign-once at enrollment, durable, BUT must be **revocable**
  (see "Revocability" below — this is the one wrinkle vs. field-trip).
- **Scope (narrow, deliberate):** consent to share photos of the parent's
  OWN child, WITH that parent — which is what the existing messaging
  photo feature does today (child-scoped attachments via
  `message_attachments`). Broader uses (marketing, multi-child photos,
  white-label welcome content) are explicitly OUT and would be separate,
  more carefully-worded consents.
- **Consent LANGUAGE caveat:** the app captures and tracks consent; whether
  the wording legally protects the provider is a lawyer/insurer question,
  NOT a licensing-rule or code question. Use placeholder copy; flag that
  the final wording needs review before relying on it.

---

## Classification note for the compliance score (PR #22)

Tag these two DISTINCTLY:
- `field_trip_permission` → **licensing-required** consent category.
- `photo_sharing_consent` → **provider-protective** consent category.

A missing field-trip permission is a real compliance gap (MiLEAP cares).
A missing photo consent is a prudence gap (only matters to insurer / a
disputing parent). The #22 score must NOT conflate them — a missing
photo consent should not read as a licensing violation. Recommend a
`consent_category` tag or two separate audit-state fields so #22 can score
them differently.

---

## Build — what to do

### New ACK_TYPES
Add to `src/lib/acknowledgments.js` ACK_TYPES:
- `FIELD_TRIP_PERMISSION = 'field_trip_permission'`
- `PHOTO_SHARING_CONSENT = 'photo_sharing_consent'`

Add the same subitem-style mapping comment used for the R 400.1907 types
(rule citation for field-trip; "no rule — provider-protective" note for
photo), mirroring the regulatory-interpretation comment pattern already in
that file.

### Required-set / where these attach
**KEY DECISION — these are NOT part of the intake child-in-care bundle.**
They are enrollment-level consents, not per-attendance intake disclosures.
Do NOT add them to `CHILD_IN_CARE_SUB_TYPES` or
`requiredSubTypesForChild`'s intake bundle — that would wrongly fold them
into the R 400.1907 child-in-care statement envelope.

Decision to make explicit (flag in halt): these consents are still
per-CHILD (each child needs field-trip permission; photo consent is
per-child since it's about that child's images). So they reuse the
polymorphic `subject_type='child'`, `subject_id=<child>` shape — but as
STANDALONE acknowledgments, not sub-rows of the intake envelope. Confirm
the engine supports a standalone parent-signed ack that isn't part of the
intake bundle (it should — the acknowledgments table is polymorphic and
doesn't require envelope membership), and describe where these get
surfaced for signing (see UX below).

### Channel-aware audit
- `field_trip_permission` → add to `PARENT_SIGNED_TYPES` (licensing-required,
  parent must sign).
- `photo_sharing_consent` → ALSO parent-signed in the sense that the parent
  is the one consenting, satisfied by `parent_portal` / `in_person_paper`.
  BUT it's provider-protective, not licensing-required — so if you're
  introducing a `consent_category` distinction, tag it accordingly so #22
  doesn't score it as a licensing item.
- Decide and flag: do these feed `pending_parent_signatures_count` (the
  intake-bundle rollup), or a NEW separate count? **Recommendation: a new
  separate audit surface** (e.g. `pending_enrollment_consents`) rather than
  folding into the intake `pending_parent_signatures_count` — because these
  aren't intake disclosures and mixing them makes the intake number lie.
  This is a judgment call; flag it, propose, wait for confirmation before
  changing the audit-state typedef (it's the PR #22 contract).

### Revocability (photo consent only)
This is the one genuinely-new mechanic vs. everything shipped so far.
- A parent who consented to photo sharing must be able to WITHDRAW.
- Withdrawal should be a real state change, not just deleting the ack —
  there should be a record that consent was given AND later revoked (audit
  trail: "consented 2026-06-01, revoked 2026-08-15").
- Modeling options to PRESENT (do not pick silently):
  - (a) Revocation = archive the active consent ack + write a new ack of a
    revocation type / status. Reuses `archived_at`.
  - (b) A status field on the consent (active / revoked).
  - (c) Something else.
  - Flag the tradeoff; the key requirement is the audit trail survives
    (you can see it was given and when it was revoked), not just current
    state.
- **Downstream effect of revocation:** when photo consent is revoked, the
  messaging photo-attachment path SHOULD respect it (stop allowing new
  photo shares for that child, or warn). NOTE: wiring revocation into the
  messaging send path may be its own follow-up — if it's more than a small
  change, FLAG it and scope the consent-capture + revocation-record in THIS
  PR, and the messaging-enforcement as a fast follow. Do not silently
  half-build the enforcement.

### UX — where consents get signed
- **Provider side:** where does the provider record/request these? They're
  enrollment-level, so likely on the family/child enrollment screen, not
  the intake modal. Investigate where enrollment consents would naturally
  live and propose; reuse the existing channel chooser
  (parent_portal / in_person_paper / provider_override) pattern from the
  intake modal where it fits.
- **Parent side:** the parent confirms via the same portal pattern as
  intake. Decide whether these surface on the existing
  `/parent/intake-acknowledge` page (probably NOT — they're not intake) or
  a new enrollment-consents surface. Propose; don't assume.

### No migration expected
`acknowledgments.type` is free-text (no CHECK enum) — new type strings need
no schema change, same as the 2026-05-29 additions. The revocability model
MIGHT need a column (if option (b) status-field is chosen) — if so, FLAG it
and STOP before building, don't introduce a migration unprompted.

---

## Tests
- New ACK_TYPES present, distinct string values.
- `field_trip_permission` and `photo_sharing_consent` are parent-signed:
  pending under `provider_override`, satisfied under `parent_portal` /
  `in_person_paper` — same channel-aware coverage pattern as the intake
  types.
- These are NOT in the intake bundle (`requiredSubTypesForChild` does not
  return them; the intake `pending_parent_signatures_count` is unchanged by
  their presence/absence).
- Photo-consent revocation: consent → revoke → audit trail shows both
  states; current state reads "revoked."
- vitest green (real total + delta), build clean.

---

## Halt for review — show:
1. The two new types + where wired (and confirmation they're standalone,
   NOT folded into the intake bundle).
2. The audit-state decision: new separate consent count vs. folded into
   intake rollup (propose + wait for confirmation — it's the #22 contract).
3. The revocability model chosen (present options, pick one, justify) and
   whether messaging-enforcement is in-scope or a flagged fast-follow.
4. The provider + parent UX placement (proposed, not assumed).
5. Confirmation of no migration (or FLAG if the revocation model needs one).
Do NOT deploy or merge.

---

## Explicitly OUT of this PR (deferred, named)
- Phase B: annual transportation, seasonal on-premises water (needs expiry).
- Phase C: non-routine transportation, off-premises water, medication
  (needs trips/events/medication-instance model + migration).
- Broadened photo consent (marketing, multi-child, white-label).
- White-label / branding work (separate roadmap track entirely).
