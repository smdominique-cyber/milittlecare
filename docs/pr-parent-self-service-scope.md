# PR Scope — Parent Self-Service Consents (Two-Tier: Low-Risk + Medium-Risk with Templates & E-Signature)

**Date:** 2026-06-03
**Status:** Scope — **DRAFT for review.** The two genuinely open
design calls: (a) the e-signature record data model (schema choices
in §6a) and (b) the upload-but-never-delete RLS enforcement
mechanism (§7 — trigger vs split-policy vs SECURITY DEFINER).
**Supersedes:** the read-only Phase 2 scope
(`docs/pr-compliance-engine-phase-2-scope.md`) — the three parent-
view bugs fold into the surfaces built here. Phase 2A's pure-refactor
half (consumer-side reads from the engine) stays useful and is
retained inside Phase X-1 below; Phase 2B's "read-only per-occurrence
surface" is superseded by the medium-risk e-sign flow that captures
those consents actionably.
**Branch (suggested, multi-phase):** see §12 phase split — `feature/parent-self-service-low-risk` first, then `feature/parent-self-service-medium-risk-templates-esign`.

---

## Summary

A two-tier parent self-service model — locked by Seth — based on
**compliance-evidence risk**:

- **Low-risk** (default ON, parent-initiated): things where the
  parent is the natural author OR where no licensing-rule "written
  permission" is on the line. Photo-sharing consent + revoke,
  parent's own contact info, emergency contacts, authorized
  pickup, child-data the parent authors (allergies, medical
  notes, dietary needs, doctor/dentist), receipt acknowledgments
  (handbook, licensing-rules notice, policies), viewing/downloading
  own records.
- **Medium-risk** (provider-gated, provider-initiated,
  parent-completed): the three licensing "written permission"
  consents — field trip (R 400.1952(2)), routine transportation
  (R 400.1952(1)), water activities (R 400.1934(10)). Per-occurrence
  variants of those rules included. Provider enables under
  Business tab (OFF by default), customizes a compliant starter
  template, sends from the child's record to the parent, parent
  completes via typed-name e-signature in the portal. The
  completed record is the compliance-evidence artifact.

**Excluded from self-service entirely:** religious-objection
statements and immunization waivers (require signed official forms;
stay provider-recorded with attachment).

**Cross-cutting:**

1. **Parents can upload but NEVER delete.** Enforced at the data
   layer (RLS + trigger), not just UI. The "preserve the audit
   trail" rule from `CLAUDE.md` is the substrate; this scope
   completes its enforcement on parent-touchable surfaces.
2. The three parent-view display bugs (raw type string,
   per-occurrence miscategorization, no per-occurrence parent
   surface) get fixed as part of building these surfaces
   correctly — they live on the same routes.
3. **Additive, not replacement:** enabling parent self-service
   does NOT remove the provider's ability to record on paper.
   Both paths satisfy the requirement; the provider chooses per
   category whether to expose the e-sign path.

**Recommended phase split (§12):**

- **Phase X — Low-risk self-service** (additive, no compliance-
  evidence boundary, ~2 weeks). The three parent-view bugs fold
  in here. Includes the upload-but-never-delete RLS lockdown
  (Phase X is where parents start gaining write paths — the
  enforcement has to land alongside or just before).
- **Phase Y — Medium-risk templates + e-signature** (the compliance-
  evidence boundary, ~3-4 weeks). Schema changes, the template
  system, the provider-send + parent-complete flow, the typed-name
  e-sign record. Verifies separately, ships separately.

---

## DECISIONS — RESOLVED + the two open ones

| # | Decision | Resolution |
|---|---|---|
| 1 | Two-tier model | **LOCKED by Seth.** Low-risk default ON parent-initiated; medium-risk provider-gated provider-initiated parent-completed. |
| 2 | The three medium-risk categories | **LOCKED:** field trip (R 400.1952(2)), routine transportation (R 400.1952(1) — annual baseline + per-trip non-routine), water activities (R 400.1934(10) — seasonal on-premises + per-trip off-premises). All five rule sub-clauses become five medium-risk template types. |
| 3 | Religious-objection / immunization waivers | **LOCKED: NOT in self-service.** Provider-recorded + attachment, same as today. |
| 4 | Additive — paper path preserved | **LOCKED.** The provider modal capture flow (`EnrollmentConsentsModal`) keeps working for every category; medium-risk e-sign is an opt-in second path the provider enables per category. |
| 5 | Compliance-evidence record shape | **Seth's call — see §6a.** Recommendation: extend `acknowledgments` table with a new channel value `'parent_portal_esign'` + two new columns (`typed_signature_text text`, `template_snapshot_text text`) + FK reference to a new `consent_templates` table. Snapshot the template body verbatim into the row at completion so future template edits cannot retroactively change what THIS parent agreed to. Schema change is locked in this recommendation — flagged for Seth approval. |
| 6 | Templates: stored where + customization model | **LOCKED:** new `consent_templates` table per provider. Ship compliant starters covering R 400.xxxx-required elements per consent type (§6b). Disclaimer: provider owns final language + its compliance. The compliant starter is the safety floor; the provider must be able to edit but cannot start from blank. |
| 7 | Snapshot mechanic — at send or at completion | **LOCKED: at completion.** Snapshot the EXACT text the parent saw immediately BEFORE they typed their name. Captures the late-edit case: provider sends a template, edits it 10 minutes later, parent then signs the edited version — what they signed is what gets stored. Send-time snapshot would store an obsolete version. |
| 8 | Send flow — from child's record | **LOCKED.** Mirrors the provider's medication / consents capture path. From a child's view, pick a template, send. Nothing reaches a parent without this deliberate per-child provider action. |
| 9 | Parent pending-to-do + notification | **LOCKED.** Mirror the intake-confirm pattern verbatim — `reminder_instances` row at send + email via the existing dispatcher (`api/cron-dispatch-reminders.js`) + a card on `/parent/acknowledge` Intake-like tab. Same RPC pattern as `intake_confirm_for_parent` for the atomic write. |
| 10 | Business-tab UI: enablement + templates | **LOCKED.** New section on the existing Business / Settings surface (where MiRegistry, Programs settings live). Per-category toggle (OFF by default) + per-template editor. |
| 11 | Upload-but-never-delete RLS — mechanism | **Seth's call — see §7.** Three options laid out (trigger-based archive block + remove parent DELETE policies; split UPDATE policies; SECURITY DEFINER RPC for archive). Recommendation: **trigger-based block on `archived_at` writes + DELETE-policy removal** (defense in depth; both paths covered). |
| 12 | The three parent-view bugs fold into Phase X | **LOCKED.** The bugs live on the same surfaces Phase X rebuilds; building the surfaces correctly fixes the bugs as a side effect. Phase X retains Phase 2A's pure refactor of the parent-side consumers to read from the engine — that's the substrate for both the bug fixes and the new actionable surfaces. |
| 13 | The Phase 2B per-occurrence read-only surface | **SUPERSEDED.** The medium-risk e-sign flow (Phase Y) captures per-occurrence consents actionably — the parent triggers the e-sign and the completed row IS the per-occurrence record. The "read-only history" surface from the Phase 2B proposal is replaced by the same panel showing the records of past e-signed consents (still a list view, but with first-class capture data underneath). When the provider records on paper instead, the paper-mode rows still appear in the same list — the parent surface is now ONE history view regardless of channel. |
| 14 | Care-critical edit notification | **LOCKED.** When a parent edits `children.allergies` or `children.medical_notes` from the low-risk My Family surface, fire a notification to the provider via the existing `api/notify-state-change.js` + `notification_log` substrate (same mechanism as the existing data-change pings). NEW `notification_kind` values: `child_allergies_updated_by_parent`, `child_medical_notes_updated_by_parent`. |
| 15 | Schema impact | **NOT ZERO.** Phase X needs RLS tightening (no schema columns; policy / trigger changes only). Phase Y needs the new `consent_templates` table + the `acknowledgments` extensions + the `acknowledged_via` CHECK expansion. Explicitly flagged in §10. |
| 16 | Verification gate is live + boundary-strength | **LOCKED — see §11.** Two real boundaries to verify with the same caliber as the consent-attachments cross-tenant gate: (a) the e-sign record captures and preserves everything needed, including the template snapshot surviving later template edits; (b) the upload-not-delete RLS denies parent deletion across every parent-write table, against real auth. |

---

## §1. Tier model — what's low-risk, what's medium-risk

The hinge: **does the rule require "written permission"?**

| Category | Tier | Rationale |
|---|---|---|
| Photo-sharing consent (grant + revoke) | **Low** | No licensing rule; provider-protective per CLAUDE.md. Parent is the only authority on their own preference. |
| Parent's own data (contact info, password, etc.) | **Low** | Parent IS the authority on their own info. |
| Emergency contacts | **Low** | Parent is the natural author; provider records them today as parent dictates. |
| Authorized-pickup list | **Low** | Parent's authority to authorize a third party for pickup. Greenfield surface — see §5d. |
| Child data parent authors (allergies, medical notes, dietary needs, doctor/dentist) | **Low** | Parent knows their child's health better than the provider. Provider gets a notification on care-critical edits (§9). |
| Receipt acknowledgments (handbook, licensing-rules notice, policies) | **Low** | The parent IS acknowledging receipt — there's no compliance asymmetry. Mirrors how the existing intake-bundle "licensing rules offered" acknowledgment works. |
| Viewing / downloading own records | **Low** | Reading isn't a write at all. |
| Field trip permission (R 400.1952(2)) | **Medium** | Rule requires "written permission" — compliance evidence. |
| Routine transportation (R 400.1952(1)(a) — annual) | **Medium** | Same. |
| Non-routine transportation (R 400.1952(1)(b) — per-trip) | **Medium** | Same. |
| On-premises water activities (R 400.1934(10)(b) — seasonal) | **Medium** | Same. |
| Off-premises water activities (R 400.1934(10)(a) — per-trip) | **Medium** | Same. |
| Medication permission | **OUT of self-service** (today) | Per the parked design questions; medication permission stays in the provider's modal until a future PR explicitly opens it. The risk model differs — physician + medication + child has more specialist context than the room can absorb in V1. |
| Religious-objection / immunization waiver | **OUT of self-service** | Per Seth — official signed forms; provider-recorded only. |

---

## §2. Low-risk tier — surfaces + flows

All low-risk surfaces are **parent-initiated, default-ON, no
provider gating**. The parent does the action; the system records
it; the provider is notified for care-critical changes only.

### §2a. Photo-sharing consent (grant + revoke)

**Today:** the parent has a read-only view on the Consents tab
showing what's on file. The provider records via paper in
`EnrollmentConsentsModal`.

**Phase X:** add parent-portal grant + revoke buttons on the
Consents tab's photo-sharing row. Backed by the existing
`acknowledgments` table — write rows with `acknowledged_via =
'parent_portal'` + `acknowledged_by_user_id = auth.uid()`.
The existing migration-024 parent INSERT policy already allows
this provided the row keys to a child in the parent's
parent_family_links.

**Channel:** the existing `parent_portal` channel value is the
right one — photo-sharing is provider-protective (no rule), so no
e-sign capture is needed. A single button + standard confirm
dialog ("Confirm you want to allow photo sharing for [child]") is
sufficient.

**Revoke** writes a `photo_sharing_consent_revoked` row, same as
the provider revoke path today.

### §2b. Parent's own data (contact info, password)

**Today:** `ParentMyFamilyPage.jsx` → "My Info" tab. Parent edits
`parent_profiles` row keyed to their own auth.uid(). Already
parent-write.

**Phase X:** no new functionality. Confirm the upload-not-delete
rule applies — the parent CAN update; archival stays provider-
side. (`parent_profiles` doesn't have an `archived_at` column
today; if it gains one, the trigger from §7 enforces.)

### §2c. Emergency contacts

**Today:** `ParentMyFamilyPage.jsx` → "Emergency" tab. Parent
already has full CRUD via migration 016's policies. **The parent
currently CAN delete** their own emergency contacts (migration
016:354-355 grants parent DELETE).

**Phase X:** keep the CREATE + UPDATE flows; **REMOVE the parent
DELETE policy** (per §7). Replace UI delete with archive (sets
`archived_at`); archival is provider-only via the existing
provider archive path or via a new parent "remove from active
list" intent that the provider sees as a pending action.

**Note on this interpretation:** if Seth wants parents to be able
to "remove" a contact from active use without provider-mediated
approval, the cleanest implementation is a parent UPDATE that
sets `removed_by_parent_at timestamptz` (a new soft-removed field,
distinct from `archived_at`). The contact stays in the audit
trail forever; "removed by parent" is a status the provider
sees. Seth flag — see §14 OQ.

### §2d. Authorized-pickup list (greenfield)

**Today:** does not exist. No table, no column. Grep confirms.

**Phase X:** add a parent-write surface. Implementation options:

- **Option A (recommended):** extend `emergency_contacts` with a
  boolean `pickup_authorized` column. Already parent-writeable;
  same RLS; same UI shape. Lowest surface area; one extra checkbox
  on the existing emergency-contact form.
- **Option B:** new `authorized_pickup` table. More structure
  (e.g., relationship, expiration date, photo) but more schema.

Recommendation: Option A for Phase X. Real provider usage data
will tell us whether the richer Option B model earns its
complexity.

### §2e. Child data the parent authors

The child data the parent legitimately owns:

- `children.allergies` — already a free-text column (migration 016).
- `children.medical_notes` — already a free-text column.
- Dietary needs — currently embedded in `allergies` or
  `medical_notes` as free text. Phase X: keep them in those
  columns OR add `children.dietary_needs text` if Seth wants
  structure. Recommendation: leave in `medical_notes` for V1.
- Doctor / dentist — currently nowhere. Phase X: add
  `children.physician_name text`, `children.physician_phone text`,
  `children.dentist_name text`, `children.dentist_phone text`
  (four nullable text columns).

**RLS:** parent must have UPDATE access on `children` rows in
their family. Today the provider owns `children` write paths
(provider_id = user_id). New parent UPDATE policy required —
allow parents linked via `parent_family_links` to UPDATE the
narrow set of columns above (`allergies`, `medical_notes`,
`physician_*`, `dentist_*`). NOT `intake_completed_at`,
`records_last_reviewed_on`, `school_*`, `archived_at`,
`user_id`, etc.

**Column-level write enforcement:** Postgres RLS doesn't natively
do column-level filtering. Two options:

- **SECURITY DEFINER RPC** `child_parent_update`: server-side
  function that accepts only the allowed columns. RPC validates
  the parent's authority via parent_family_links, writes only the
  allowed columns. Mirrors `intake_confirm_for_parent`.
- **BEFORE UPDATE trigger** on `children` that rejects parent
  updates to non-allowed columns.

Recommendation: **RPC**. It's the same pattern as
`intake_confirm_for_parent`. The trigger approach scatters
authorization across two layers; the RPC keeps it in one.

### §2f. Receipt acknowledgments (handbook, licensing-rules notice, policies)

**Today:** the intake-bundle's `licensing_rules_offered` ack is
the closest precedent. The provider attests; the parent confirms
via the existing intake-confirm flow.

**Phase X:** a parent-initiated "I confirm receipt of [document]"
button next to provider-uploaded documents (handbook PDF,
licensing rules notice, policy PDFs). Writes an ack row of a new
type — e.g., `parent_receipt_acknowledgment` with
`subject_type='child'`, `subject_id=child.id`, `acknowledged_via=
'parent_portal'`, and a per-document discriminator (likely an
`occurrence_metadata.document_id` reference, reusing the existing
jsonb metadata column added in migration 027). No schema change
beyond a new ACK_TYPES string.

**Note:** distinct from the intake-bundle parent-signed items
(R 400.1907). Those are licensing-required and ride the existing
intake-confirm bundle. Phase X's "receipt acks" are catch-all
extras the provider wants to track (handbook, policies they
distribute beyond Rule 7).

### §2g. View / download own records

**Today:** the parent can see acknowledgment rows on the Consents
tab + read what the provider stored. No bulk download.

**Phase X:** add a "Download my records" button per child + per
family that produces a PDF (or zip of PDFs) containing the
parent's signed/confirmed acknowledgments + their family / child
contact data. Builds on the existing PDF/export pattern from
`src/lib/iBillingPdf.js` + `taxExport.js`. No data-model change.

---

## §3. Medium-risk tier — the compliance-evidence boundary

This is where Phase Y lives. The three sub-categories (field
trip / transportation / water activities) cover five concrete
template types because two of them have annual + per-occurrence
variants.

### §3a. The five medium-risk consent types

| Consent type | Rule | Cadence | Template |
|---|---|---|---|
| Field trip (non-vehicle) | R 400.1952(2) | Once at enrollment | `field_trip_permission_template` |
| Routine transportation annual | R 400.1952(1)(a) | Annual | `transportation_routine_annual_template` |
| Non-routine transportation per-trip | R 400.1952(1)(b) | Per trip | `transportation_nonroutine_per_trip_template` |
| On-premises water seasonal | R 400.1934(10)(b) | Once per season | `water_activities_on_premises_seasonal_template` |
| Off-premises water per-trip | R 400.1934(10)(a) | Per outing | `water_activities_off_premises_per_trip_template` |

All five reuse existing ACK_TYPES values from `acknowledgments.js`.
No new ACK_TYPES required.

### §3b. The compliance-evidence record (Phase Y)

The completed e-sign record must be **producible at inspection as
the parent's written permission**. To satisfy "written permission"
electronically, the record must capture:

1. The authenticated parent's identity (auth.uid()).
2. The typed-name signature string (free text — the parent types
   their full legal name).
3. The exact timestamp of signing.
4. The exact template text the parent saw immediately before
   signing — snapshotted into the row, NOT a FK to mutable
   template state.
5. A reference (FK + version stamp) to the template used, for
   audit-trail lineage.

This is the data model question in §6a.

---

## §4. The three parent-view bugs — folded into Phase X

The bugs from the parked list, as restated for context:

**Bug 1** — raw type string rendered instead of friendly label on
the parent Intake tab (e.g., `water_activities_off_premises_per_trip`
shown literally).

**Bug 2** — per-occurrence consent type miscategorized into the
parent intake-confirm bundle.

**Bug 3** — no parent-facing surface for per-occurrence consents.

**Phase X folds each fix in by reading from the Phase 1 engine.**

- **Bug 1's fix:** the engine's REQUIREMENT_REGISTRY exposes
  `requirement.label`. Parent surfaces render the label from the
  engine, never the raw type string.
- **Bug 2's fix:** the engine categorizes correctly
  (per-occurrence types are `category='consents'`, not
  `'child_files'`). The parent intake page projects only
  `child_files`; per-occurrence rows are structurally excluded
  from the intake bundle.
- **Bug 3's fix:** **superseded by Phase Y's e-sign flow.** The
  Phase Y completion writes a per-occurrence ack row via the
  new `parent_portal_esign` channel; that row appears in the
  Consents tab's per-child history list. When the parent has
  e-signed a per-occurrence consent, they see it. When the
  provider has recorded one on paper instead (the additive
  path), the paper-mode row appears in the same list. **Phase
  X carries an interim read-only fix** (a per-occurrence section
  on the Consents tab listing what's on file from the paper
  path), so the bug is fixed before Phase Y ships the actionable
  surface. Phase Y then makes the same section actionable.

The interim Phase-X fix for Bug 3 is one of the read-only
sections in §5b below — it ships in Phase X regardless of when
Phase Y ships.

---

## §5. Phase X surfaces — what gets built

A single PR (or two small ones — see §12). The surfaces:

### §5a. Updated Consents tab (`ParentEnrollmentConsentsPanel.jsx`)

The existing panel is the host. New elements:

- **Reads from the engine** (`getChildComplianceStateForCategory({
  category: 'consents' })`) instead of inline `pendingEnrollmentConsents
  ForChild` — locks Bug 1 (every row has `requirement.label`) and
  Bug 2 (per-occurrence is in the `consents` category, never
  leaks into intake).
- **Photo consent row gains buttons.** "Grant" + "Revoke" buttons
  next to the existing tri-state badge. Writes
  `parent_portal`-channel rows via the existing acknowledgments
  table.
- **New per-occurrence section** (Bug 3 read-only fix). One
  disclosure per per-occurrence type, collapsed by default, with
  count. Expanded view shows per-event list (date, description,
  channel, attachment). Read-only in Phase X. **Phase Y makes it
  actionable** when the provider has enabled the category and
  sent a pending consent.
- **Medium-risk pending state surface (Phase Y).** When the
  provider has SENT a pending e-sign consent, a "Sign now" card
  appears at the top of the relevant child's section — or
  duplicated on a "To-do" tab for discoverability.

### §5b. Updated My Family page (`ParentMyFamilyPage.jsx`)

- **"My Info" tab:** no change.
- **"Children" tab:** the existing read view becomes a partial
  edit view. Parent can edit `allergies`, `medical_notes`,
  `physician_*`, `dentist_*` via the new
  `child_parent_update` RPC. NOT the school fields, not the
  intake fields, not `archived_at`. Save triggers a notification
  to the provider for `allergies` / `medical_notes` edits (§9).
- **"Guardians" tab:** parent can already CRU; remove the
  D part (§7 RLS lockdown). Replace UI delete with a "remove from
  active list" affordance that goes through the provider.
- **"Emergency" tab:** add `pickup_authorized` checkbox per
  contact (§2d Option A). Parent CRU; no D.
- **"Tax / FSA" tab:** add the "Download my records" affordance
  (§2g).

### §5c. New parent-portal acknowledgments tab section

Currently `ParentAcknowledgmentsPage.jsx` has three tabs:
Attendance, Intake, Consents. Phase X adds:

- **A receipt-acknowledgment subsection** on the existing Consents
  tab (or a new fourth tab — see §14 OQ). Lists each document the
  provider has flagged for receipt confirmation; each has a "Mark
  as received" button.

### §5d. The interim Bug 3 read-only fix (Phase X)

Same shape as the Phase 2B proposal: a collapsed-by-default
disclosure per per-occurrence type on the Consents tab, expanding
to a per-event list (date, description, channel, attachment).
Carries through to Phase Y where the same section gains the
actionable e-sign flow.

---

## §6. Phase Y surfaces — the e-signature flow

The compliance-evidence boundary.

### §6a. Data model for the e-signature record

**Recommendation: extend the existing `acknowledgments` table.**

Why not a new table:
- The completed e-sign record IS an acknowledgment. It satisfies
  the same rule the paper-mode path satisfies; the audit-state
  helpers + the Phase 1 engine already know how to count it.
- A new table forks the verdict — every consumer that checks "is
  this consent on file?" would need to join two tables.
- The engine's `state_resolver` for each ack type doesn't have to
  change; it already returns `on_file` when there's an active
  row matching the type + child.

**The schema changes (Phase Y migration):**

```sql
-- 1. Expand the channel CHECK constraint to allow the new value.
alter table public.acknowledgments
  drop constraint chk_acknowledgments_via;
alter table public.acknowledgments
  add constraint chk_acknowledgments_via check (
    acknowledged_via in (
      'parent_portal',
      'provider_override',
      'in_person_paper',
      'parent_portal_esign'         -- NEW
    )
  );

-- 2. Two new columns for the e-sign payload.
alter table public.acknowledgments
  add column if not exists typed_signature_text    text,
  add column if not exists template_snapshot_text  text;

-- 3. A new column referencing the template (for lineage; not the
--    source of truth for the displayed text).
alter table public.acknowledgments
  add column if not exists consent_template_id     uuid
    references public.consent_templates(id) on delete set null;

-- 4. CHECK: parent_portal_esign rows MUST have non-null signature
--    + snapshot. Other channels MUST leave them null (defense
--    against accidental writes via the wrong channel).
alter table public.acknowledgments
  add constraint chk_acknowledgments_esign_shape check (
    (acknowledged_via = 'parent_portal_esign'
       and typed_signature_text   is not null
       and template_snapshot_text is not null
       and length(typed_signature_text)   > 0
       and length(template_snapshot_text) > 0)
    or
    (acknowledged_via <> 'parent_portal_esign'
       and typed_signature_text   is null
       and template_snapshot_text is null)
  );
```

**Channel-aware satisfaction rule update.** Today the rule
(`PARENT_SIGNED_SATISFYING_CHANNELS` in `childFiles.js`) includes
`parent_portal` and `in_person_paper`. The new
`parent_portal_esign` channel **also satisfies parent-signed
requirements** — it's the parent's own typed-name signature, with
the captured template text being the "written permission" the rule
contemplates. Update the constant + every consumer's
`acknowledged_via` filter. **Phase 1 engine's Pattern A resolver
reads the constant via direct duplication** (per Phase 1 §10
note) — both copies need updating in lockstep.

**Audit-trail behavior unchanged.** The row's `archived_at`
soft-delete semantics + the partial-unique-index "one active per
(provider, type, subject_type, subject_id)" constraint hold for
per-occurrence types as before (those types are EXEMPT from the
unique constraint per migration 027). E-sign rows live alongside
paper-mode rows in the audit history.

**Template snapshot — why store the text on the row, not just a
template_id.** The rule wants the parent's written permission. If
the provider edits the template later (e.g., adds a new
destination, removes a clause), the parent's permission is for
the OLD wording. A future inspector reading the row sees exactly
what the parent agreed to. Storing only an id + version forces a
JOIN that could miss the version semantic if the templates table
itself ever gets re-indexed or schema-changed. Storing the text
on the row is **defense against future schema migrations** — the
compliance evidence is self-contained.

### §6b. The templates table

```sql
create table public.consent_templates (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references auth.users(id) on delete cascade,
  consent_type    text not null,             -- one of the five medium-risk values
  label           text not null,             -- "Field trip permission — Smith Family Daycare"
  body_text       text not null,             -- the actual paragraph the parent will see
  body_text_version integer not null default 1,  -- bumps on edit
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index consent_templates_active_unique
  on public.consent_templates (provider_id, consent_type)
  where archived_at is null;
-- One active template per (provider, consent_type). Re-templating
-- archives the previous + inserts a new row.

create index consent_templates_provider
  on public.consent_templates (provider_id);
```

RLS:
- Provider SELECT/INSERT/UPDATE/DELETE on their own templates.
- Parents see template text ONLY through the snapshot column on a
  sent consent — never direct SELECT on the templates table.

Per-provider category enablement: add to `profiles`:

```sql
alter table public.profiles
  add column if not exists medium_risk_consents_enabled jsonb
    default jsonb_build_object(
      'field_trip_permission',                  false,
      'transportation_routine_annual',          false,
      'transportation_nonroutine_per_trip',     false,
      'water_activities_on_premises_seasonal',  false,
      'water_activities_off_premises_per_trip', false
    );
```

OFF by default. Provider flips toggles in the Business tab. The
send action is gated server-side on this column: the send-RPC
refuses if the category isn't enabled.

### §6c. Compliant starter templates — required elements per consent type

Per R 400.xxxx — the elements the starter must include so the
finished signed record is defensible as written permission. Real
template wording will be finalized by Seth + the licensing
consultant; the structure below is the COMPLIANCE-REQUIRED scaffolding.

**Field trip (R 400.1952(2)) — initial enrollment:**

> Field trip permission for [child's full name]
>
> I, [parent name], grant permission for [child name] to participate in non-vehicle field trips supervised by [provider name / business name]. This includes walking trips and trips to nearby parks, libraries, or community spaces accessed on foot. This permission is given at initial enrollment and remains on file until I withdraw it in writing.
>
> Signed: ____________ (typed name) Date: [auto]

Required: parent name + child name + provider name + scope of trips + duration + signature + date.

**Routine transportation annual (R 400.1952(1)(a)):**

> Routine transportation permission for [child's full name]
>
> I, [parent name], grant permission for [provider name] to transport [child name] for routine purposes during the year beginning [date]. "Routine" means regularly scheduled travel on the same day of the week, at the same time, to the same destination — for example, to/from school or to a regularly scheduled activity. This permission must be renewed at least annually.
>
> Routine destinations: [destinations]
>
> Signed: ____________ (typed name) Date: [auto]

Required: parent name + child name + provider name + cadence definition + destinations list + 1-year validity + signature + date.

**Non-routine transportation per-trip (R 400.1952(1)(b)):**

> Non-routine trip permission for [child's full name]
>
> I, [parent name], grant permission for [provider name] to transport [child name] on a non-routine trip on [trip date] to [destination]. The purpose of the trip is [purpose]. I understand this permission applies to this trip only; other non-routine trips require separate permission.
>
> Signed: ____________ (typed name) Date: [auto]

Required: parent + child + provider + trip date + destination + purpose + scope (this trip only) + signature + date.

**On-premises water seasonal (R 400.1934(10)(b)):**

> On-premises water activity permission for [child's full name]
>
> I, [parent name], grant permission for [child name] to participate in on-premises water activities at [provider name / location] during the [year] water season. On-premises water activities include [list — e.g., kiddie pool, sprinkler play if covered].
>
> Signed: ____________ (typed name) Date: [auto]

Required: parent + child + provider + season identifier + activities list + signature + date.

**Off-premises water per-trip (R 400.1934(10)(a)):**

> Off-premises water activity permission for [child's full name]
>
> I, [parent name], grant permission for [child name] to participate in an off-premises water activity on [outing date] at [location]. The water body type is [type — e.g., swimming pool, lake]. I understand this permission applies to this outing only; other outings require separate permission.
>
> Signed: ____________ (typed name) Date: [auto]

Required: parent + child + provider + outing date + location + water body type + scope (this outing only) + signature + date.

**Customization + disclaimer.** Every starter is editable. A
prominent disclaimer in the template editor reads:

> The starter wording is a compliance scaffolding, not legal
> advice. You own the final language and its compliance — review
> with your licensing consultant or attorney before relying on it.
> MILittleCare provides the record-keeping; the wording's adequacy
> for your inspection context is your responsibility.

### §6d. Provider send flow

From a child's view (existing family modal):

1. New "Send consent for e-signature" button in the per-child
   actions, gated visible on `medium_risk_consents_enabled` for
   at least one type.
2. Modal: pick consent type from the enabled list; preview the
   template text (with placeholder substitution: child name,
   destination if per-trip, etc.); optional per-send overrides
   for the per-occurrence fields (trip date, destination, water
   body type); send button.
3. Send writes:
   - A `reminder_instances` row of category
     `consent_esign_pending` with `subject_id=child.id` (parent
     surface looks here).
   - A pending `consents_pending_esign` table row (NEW — see
     §6e) capturing the consent_type + template_id + per-send
     overrides + provider_id + child_id + sent_at + expires_at
     (optional, default null = no expiry).
   - Fires a notification via the existing
     `notify-state-change` substrate ⇒ email to the parent.
4. The pending row drives the parent's "Sign now" card on the
   Consents tab. Atomic via a new SECURITY DEFINER RPC
   `consent_esign_send` mirroring `intake_confirm_for_parent`'s
   shape.

### §6e. The pending table

```sql
create table public.consents_pending_esign (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           uuid not null references auth.users(id) on delete cascade,
  child_id              uuid not null references public.children(id) on delete cascade,
  consent_type          text not null,        -- one of the five medium-risk values
  consent_template_id   uuid not null references public.consent_templates(id),
  template_body_at_send text not null,        -- the body the provider sent
  per_send_metadata     jsonb,                -- trip date, destination, water body type, etc.
  sent_at               timestamptz not null default now(),
  expires_at            timestamptz,          -- null = no expiry
  resolved_at           timestamptz,          -- set when parent completes OR provider rescinds
  resolved_via          text,                 -- 'parent_completed' | 'provider_rescinded'
  archived_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index consents_pending_esign_active_child
  on public.consents_pending_esign (child_id, resolved_at)
  where archived_at is null;
```

The `template_body_at_send` column gives the parent a stable text
to read between send and completion. The `template_snapshot_text`
on the resulting ack row captures whatever the parent saw at
completion (which may equal `template_body_at_send` if the
provider didn't edit, or differ if they did and the parent re-read
before signing).

### §6f. Parent completion flow

When the parent opens `/parent/acknowledge` and the Consents tab
has pending e-sign cards:

1. Card per pending consent: shows the template body verbatim
   (from `consents_pending_esign.template_body_at_send` OR the
   latest template body if the provider re-edited — recommendation:
   show the latest in the UI but capture what the parent saw at
   sign time).
2. The parent reads, types their full legal name, taps "I sign
   this consent."
3. RPC `consent_esign_complete` (SECURITY DEFINER, mirrors
   `intake_confirm_for_parent`):
   - Validates the caller is an active parent linked to the child.
   - Reads the pending row.
   - Reads the CURRENT body of the referenced template.
   - Writes an `acknowledgments` row with
     `acknowledged_via='parent_portal_esign'`,
     `typed_signature_text=<typed name>`,
     `template_snapshot_text=<current body>`,
     `consent_template_id=<template_id>`,
     plus the per-occurrence metadata if applicable.
   - Sets `consents_pending_esign.resolved_at=now()` +
     `resolved_via='parent_completed'`.
   - Resolves any matching `reminder_instances` row.
   - All in one transaction.

### §6g. Business-tab UI: enablement toggles + template management

New section on `BusinessInfoPage.jsx` (or a new sibling tab):

- "Parent self-service consents (e-signature)" section.
- One toggle per consent type (default OFF).
- Per-toggle: "Manage template" button → opens the template
  editor.
- Template editor: shows the starter text (read-only initially),
  edit affordance flips it to a textarea, save (writes a new
  version). Disclaimer panel (§6c) always visible.

---

## §7. Upload-but-never-delete RLS enforcement

The cross-cutting rule: parents can add, edit (within scope), and
upload, but **NEVER delete or archive**. Implemented at the data
layer.

### §7a. Mechanism — three options

**Option A — Trigger-based block on archived_at + remove parent DELETE policies (RECOMMENDED).**

```sql
-- 1. Remove every parent DELETE policy.
-- (Cataloged below in §7b; for emergency_contacts, guardians, and
--  any future parent-write table.)

-- 2. BEFORE UPDATE trigger on every parent-write table that has
--    an archived_at column: reject the UPDATE if the caller isn't
--    the provider and is trying to set archived_at to non-null.
create function public.block_parent_archive() returns trigger
language plpgsql security definer as $$
begin
  -- Trigger fires for any UPDATE. Allow:
  --   - The provider (children.user_id = auth.uid()) sets archived_at.
  --   - Anyone else can update non-archived_at columns.
  -- Block: a non-provider sets archived_at from null to non-null
  --        (or to anything other than null).
  if NEW.archived_at is distinct from OLD.archived_at then
    -- Caller is trying to change archived_at. Verify caller authority.
    if not exists (
      select 1 from public.children c
      where c.id = NEW.id      -- adapt per table key shape
        and c.user_id = auth.uid()
    ) then
      raise exception 'block_parent_archive: only the provider can archive this record';
    end if;
  end if;
  return NEW;
end;
$$;

-- Attach per table.
```

**Pros:** defense in depth (RLS removal + trigger block); explicit
error message in any client that tries.

**Cons:** trigger is per-table; one trigger per affected table.
Some scaffolding cost.

**Option B — Split UPDATE policies by column (NOT supported natively).**

Postgres RLS doesn't natively filter by which columns are updated.
Workarounds (column GRANT/REVOKE) are awkward and don't compose
well with row-level policies. **Rejected.**

**Option C — SECURITY DEFINER RPCs for everything parent-write.**

Every parent write goes through an RPC that explicitly excludes
`archived_at`. Pros: one place to enforce. Cons: API surface
explosion — every parent CRU path needs an RPC.

**Recommendation: Option A.** It's already the pattern the
`intake_confirm_for_parent` RPC is using server-side. Combine
with DELETE-policy removal for full coverage.

### §7b. Per-table audit

The tables parents touch:

| Table | Today's parent privileges | After Phase X |
|---|---|---|
| `parent_profiles` | SELECT, INSERT, UPDATE on own row | Same. Add archived_at column + trigger if/when archival is wanted. |
| `emergency_contacts` | SELECT, INSERT, UPDATE, **DELETE** | Remove DELETE policy. Replace UI delete with "remove from active list" intent — provider archives. |
| `guardians` | SELECT, INSERT, UPDATE, **DELETE** | Same as emergency_contacts. |
| `children` | (parent has no UPDATE today) | Add narrow parent UPDATE via `child_parent_update` RPC (§2e). No DELETE policy. |
| `acknowledgments` | SELECT (per migration 024 parent SELECT policy), INSERT (parent-portal self-confirm via the intake RPC; new flows via the e-sign RPC) | Same. Add new trigger to block parent-side UPDATE of archived_at — only the provider archives an ack. |
| `consent_attachments` | SELECT (via parent RLS in migration 029), NO direct INSERT/UPDATE/DELETE | Same. Parents view via the Edge Function. |
| `consent_templates` (new) | No parent access. | Parents see template text only via the snapshot column on completed acks. |
| `consents_pending_esign` (new) | SELECT for pending rows targeting their child. | Same. |

### §7c. The boundary verification gate

Per §11 — same caliber as the consent-attachments cross-tenant
test. Live verification with real seed accounts.

---

## §8. Schema changes summary (Phase X + Phase Y)

### Phase X (low-risk)

- **No new tables.**
- **`emergency_contacts`:** add `pickup_authorized boolean default false` (§2d Option A).
- **`children`:** add `physician_name text`, `physician_phone text`, `dentist_name text`, `dentist_phone text` (§2e).
- **Policy changes:**
  - Remove parent DELETE policies on `emergency_contacts`, `guardians`.
  - Add narrow parent UPDATE via `child_parent_update` RPC on `children`.
  - Add `block_parent_archive`-style trigger on every parent-write table that has `archived_at`.
- **New ACK_TYPES:** `parent_receipt_acknowledgment` (§2f). No CHECK change (free-text type column).

### Phase Y (medium-risk)

- **New table:** `consent_templates`.
- **New table:** `consents_pending_esign`.
- **`acknowledgments`:** add `typed_signature_text text`, `template_snapshot_text text`, `consent_template_id uuid`. Expand `chk_acknowledgments_via` to allow `parent_portal_esign`. Add `chk_acknowledgments_esign_shape`.
- **`profiles`:** add `medium_risk_consents_enabled jsonb` (default all OFF).
- **New SECURITY DEFINER RPCs:** `consent_esign_send`, `consent_esign_complete`, `consent_esign_rescind`, `child_parent_update` (the last one straddles X/Y; ship in X).
- **No new buckets, no new Edge Functions.**

---

## §9. Care-critical edit notifications

Two new `notification_log.kind` values:

- `child_allergies_updated_by_parent` — fired when a parent
  changes `children.allergies`.
- `child_medical_notes_updated_by_parent` — fired when a parent
  changes `children.medical_notes`.

Mechanism: `child_parent_update` RPC writes a row to
`notification_log` after the UPDATE succeeds. The existing
`api/notify-state-change.js` cron / dispatcher path picks it up
and emails the provider. **Mirrors the existing data-change
notification pattern** (e.g., guardian-added notifications).

No schema change; the `notification_log` table already accepts
arbitrary `kind` values.

---

## §10. Verification gate — live + boundary-strength

Two boundaries need the same caliber as the consent-attachments
cross-tenant gate. The rest is standard live before/after.

### §10a. The two real boundaries

**Boundary 1 — Upload-but-never-delete (Phase X).**

Test against real auth on the preview environment using the
existing seeded fixtures (Jeff / klsnay / Dominique):

1. As parent A, attempt to DELETE one of their emergency contacts
   via direct PostgREST (`.delete()`). Expect 403 or 401 — RLS
   denies (DELETE policy removed).
2. As parent A, attempt to UPDATE their guardian row setting
   `archived_at = now()`. Expect a trigger exception:
   `block_parent_archive: only the provider can archive this
   record`.
3. As parent A, attempt to UPDATE `children.user_id` to their own
   id (privilege escalation). Expect denial via the narrow column
   list the RPC enforces.
4. As parent A, attempt to update parent B's emergency contact
   (cross-tenant). Expect 403 / 0 rows affected — existing parent
   RLS denies.
5. As parent A, archive their own consent attachment via
   `archive_consent_attachment` (or whatever path exists). Expect
   denial — the parent doesn't own the archive surface.
6. Provider (Vanessa-equivalent) archives a parent A row.
   Succeeds.

Every test produces a row in the existing audit log substrate
(or an `archive_attempt_blocked` log row — see §14 OQ).

**Boundary 2 — E-signature record integrity (Phase Y).**

1. Provider sends a field trip e-sign request to parent A.
   `consents_pending_esign` row created.
2. Parent A opens the portal, sees the pending card, reads the
   template text.
3. Provider edits the template in the Business tab between send
   and completion (e.g., adds a new clause).
4. Parent A completes the e-sign by typing their name.
5. Verify:
   - The new `acknowledgments` row has
     `acknowledged_via='parent_portal_esign'`.
   - `typed_signature_text` matches what the parent typed.
   - `template_snapshot_text` matches what the parent SAW at
     completion (the post-edit text if the parent re-read after
     the edit; or the pre-edit if the parent's session loaded
     the body before the edit and they didn't refresh — the
     recommendation is to refresh-and-show before allowing the
     submit). Seth react.
   - The `consent_template_id` references the template row.
6. Provider then archives the template + creates a new
   replacement. Verify:
   - The parent's signed ack row STILL shows the original
     `template_snapshot_text`. **The snapshot survives template
     archive.**
   - Engine reports the consent as `on_file` via the e-sign
     channel.
7. Cross-tenant: parent B attempts to read parent A's e-sign
   row. RLS denies — same parent_family_links scope as the
   existing acknowledgments parent SELECT policy.
8. Provider attempts to retroactively change parent A's signed
   row's `typed_signature_text`. Trigger denies (the e-sign
   columns are write-once at insert; not updatable after).

### §10b. The three bug fixes

Per §4 — three before/after checks on a fixture child with
per-occurrence acks present.

### §10c. No-regression check

- `/parent/acknowledge` Intake tab still renders correctly when
  no per-occurrence acks exist.
- `/parent/acknowledge` Consents tab still renders all existing
  durable + Phase B time-bound rows correctly.
- Provider modal capture flow still works for every category (the
  paper path is unaffected by self-service additions).
- `/parent/messages` photo-attachment reminder still fires
  correctly per `photoConsentNeedsReminderForChild`.

### §10d. Tests

Vitest:

- New helper tests for `getChildComplianceStateForCategory` (from
  Phase 2A, retained).
- New tests for the `consent_esign_complete` RPC's verdict-shape
  (parent-side mock).
- Engine tests: the `parent_portal_esign` channel value satisfies
  Pattern A rows (Phase 1's PARENT_SIGNED_SATISFYING_CHANNELS
  constant updates in lockstep with `childFiles.js`'s copy; the
  existing duplication-invariant test in
  `complianceState.test.js` locks it).
- New RLS tests via the existing Supabase mock pattern for the
  upload-not-delete RLS.

---

## §11. Risks + how they're caught

**Risk 1 — Schema migration touches `acknowledgments`.** Phase Y
modifies a load-bearing table. The CHECK expansion + new columns
are additive; the new `chk_acknowledgments_esign_shape` enforces
shape per channel. Migration is reversible (drop the new
constraint + drop columns).

**Risk 2 — Template snapshot timing.** Per §10a Boundary 2: if
the parent loads the body, provider edits, parent submits without
refreshing, what's stored? Recommendation: the completion RPC
reads the CURRENT template body server-side at completion. The
parent's UI shows the body at session start; on submit, the
client re-fetches the body, shows a confirm dialog if it changed
("This template was just updated by your provider. Review the new
text before signing"), then submits. **Atomic vs. stale-read is
the call to make.**

**Risk 3 — Parent revoke / amend after e-signing.** A parent who
signs and later changes their mind has no self-service revoke for
medium-risk consents. The provider must amend on paper or send a
new e-sign request. Phase Y ships without parent revoke; it's a
future PR if real demand surfaces.

**Risk 4 — RLS audit during the lockdown.** Removing parent
DELETE policies on tables real users currently delete from is a
breaking change for those users mid-session. Recommendation: ship
the UI-side affordance changes (remove the trash button) BEFORE
the policy removal; verify on preview; then remove the policy.
Two-step rollout reduces "parent clicked delete, got 403, has no
explanation" surface.

**Risk 5 — Parent UPDATE on `children` widening scope creep.**
Future PRs adding more parent-editable child columns must update
the `child_parent_update` RPC's column allowlist; otherwise the
parent can't edit them. This is a feature, not a bug — every new
parent-editable column requires explicit RPC update + RLS audit.

---

## §12. Phase split recommendation

### Phase X — Low-risk self-service + bug fixes + RLS lockdown

**Branch:** `feature/parent-self-service-low-risk`

**Scope:**
- All of §2 (photo grant/revoke, child-edit, emergency contacts
  updates, authorized pickup, receipt acks, download records).
- Phase 2A's pure refactor of parent consumers to read from the
  Phase 1 engine. Locks Bugs 1 + 2 by category.
- Phase 2B's read-only per-occurrence section. Locks Bug 3
  visibility before Phase Y makes it actionable.
- §7 RLS lockdown (DELETE policy removal + trigger block).
- §9 care-critical notifications.

**Schema:** policy + trigger changes; minor column additions to
`emergency_contacts` and `children`. No new tables.

**Difficulty:** **M-L.** Multiple parent surfaces touch; the RLS
lockdown is verified live.

**Phase X verification gate:**
- Bugs 1 + 2 + 3 (read-only fix) demonstrably fixed live.
- Upload-not-delete RLS verified per §10a Boundary 1.
- Care-critical notifications fire in live preview test.
- No regression on existing parent surfaces.

**Dependencies:** Phase 1 engine (shipped). Builds on Phase 2A's
work IF that PR shipped between; otherwise rolls it in.

### Phase Y — Medium-risk templates + e-signature

**Branch:** `feature/parent-self-service-medium-risk-templates-esign`

**Scope:**
- §3 + §6 — full medium-risk system.
- New `consent_templates` + `consents_pending_esign` tables.
- `acknowledgments` schema extension + new channel + CHECK.
- New RPCs: `consent_esign_send`, `consent_esign_complete`,
  `consent_esign_rescind`.
- Business-tab UI for enablement + template management.
- Parent pending-to-do + e-sign completion UI.
- The three parent-view bugs' actionable fix on per-occurrence
  (the e-sign flow makes the section actionable).
- Update `PARENT_SIGNED_SATISFYING_CHANNELS` constant (childFiles.js
  + complianceState.js duplicate).

**Schema:** new tables + column additions + new CHECK + new
trigger (Phase X covers some).

**Difficulty:** **L.** Compliance-evidence boundary; multiple new
surfaces; new schema.

**Phase Y verification gate:**
- §10a Boundary 2 (e-signature record integrity) verified live.
- Template snapshot survives template edit / archive verified
  live.
- Engine sees `parent_portal_esign` rows as `on_file` for the
  affected requirement (test).
- Provider can disable a category and existing e-signed records
  remain visible + valid.
- No regression on Phase X surfaces.

**Dependencies:** Phase X complete.

### Why two phases

1. **Compliance-evidence boundary lives in Phase Y.** Mixing the
   boundary verification with the low-risk additive UI work
   blurs what's gated on what. Keeping the schema + e-sign
   isolated lets the boundary gate stand alone.
2. **Phase X ships sooner.** Low-risk wins land first (the bug
   fixes are user-visible; the RLS lockdown is audit-protective)
   without waiting on the harder Phase Y design.
3. **Smaller blast radius per PR.** Two small PRs verify
   independently; one big PR has more places to regress.

### Why NOT three phases (bug fixes alone first)

The bug fixes touch the same surfaces Phase X rebuilds. Splitting
them as a separate first PR means rewriting the same parent
panel twice. Folding them into Phase X is the natural shape.

---

## §13. Out of scope (explicitly deferred)

Named so they aren't quietly absorbed.

- **Medication permission via parent e-sign.** Stays in the
  provider's modal until a future PR; the risk model differs
  (physician + medication + child context too dense for V1
  parent self-service).
- **Religious-objection / immunization waivers.** Provider-only
  with attachment.
- **Parent revoke of medium-risk consents.** Provider amends; no
  parent revoke surface in Phase Y.
- **Bulk template management** (e.g., template gallery across
  providers). Per-provider only.
- **Per-template versioning UI in the Business tab.** Each edit
  archives the previous and inserts a new row; the UI shows the
  current template only. History viewable from a "show archived"
  toggle if Seth wants it; not V1.
- **Parent-to-parent comments on consents** (e.g., one parent
  reviewing the other's signature). Not in scope.
- **Pre-fill the typed name from `parent_profiles.full_name`.**
  Recommendation: leave the field empty so the parent's act of
  typing IS the affirmative gesture; pre-filling would weaken
  the compliance evidence semantically. Seth react.
- **Multi-parent co-signing.** Single-parent e-sign per consent
  in V1.
- **A separate Parent Audit Log surface** (lets the parent see
  "you signed X on Y at Z"). The download-records affordance
  (§2g) is the V1 equivalent.
- **Provider notification on every parent-portal action.**
  Phase X fires only on care-critical edits (`allergies`,
  `medical_notes`); other low-risk edits don't ping the
  provider. Phase Y fires on e-sign completion (the parent
  completing IS the signal the provider needs).

---

## §14. Open questions for Seth

1. **§6a — the e-signature record data model.** Recommendation:
   extend `acknowledgments` (additive: new channel value + two
   text columns + template_id reference) rather than create a
   parallel table. Confirms compliance-evidence is self-contained
   on one row. Approve / modify?

2. **§7 — upload-but-never-delete enforcement mechanism.**
   Recommendation: Option A (trigger-based block + DELETE policy
   removal). Alternative: Option C (SECURITY DEFINER RPCs for
   everything). Choice affects the migration shape.

3. **§2c — emergency-contact "remove from active list" UX.**
   Should the parent be able to mark a contact as "remove from
   active use" themselves (writing a soft-removed timestamp), or
   does that go through the provider too? The strict reading of
   "never delete" is provider-only; the practical reading is "the
   parent can mark inactive but the provider does the archive."
   Pick.

4. **§5c — receipt-acknowledgments tab placement.** Subsection on
   existing Consents tab, or new fourth tab? Recommendation:
   subsection (avoids tab proliferation).

5. **§10a Boundary 2 timing question.** Parent loaded the body
   at session start; provider edited; parent re-opens the page or
   submits without refresh. What should the e-sign flow do?
   Recommendation: the completion RPC fetches CURRENT body
   server-side; if it differs from what the client claims to have
   shown, return 409 (or a special "template_changed" code) and
   force the parent to re-read. Approve?

6. **§6c — template starter wording.** The bullets above are
   compliance-required ELEMENTS, not finalized wording. Who
   writes the final wording — Seth, the licensing consultant, or
   does CC draft for Seth's review?

7. **§13 — pre-fill the typed name.** Recommendation: leave
   empty. Pre-filling makes the typing trivial; the compliance
   intent is that the parent affirmatively types as part of the
   sign action. Seth react.

8. **§13 — parent rescind / revoke of medium-risk consents.**
   Not in V1; provider amends on paper for now. Confirm or scope
   in.

9. **§7c — audit log row on RLS denial.** Should the trigger
   write a `block_attempt_log` row on every denied parent
   archive attempt, or just raise an exception silently? Recommendation:
   raise + leave logging to standard PostgREST 4xx logs. Adding
   an audit row creates write surface on a path that should be
   rare.

---

## Halt for review — what Seth reads next

This doc, with these focus areas:

1. **§6a** — the e-signature record data model. The compliance-
   evidence boundary's load-bearing decision.
2. **§7** — the upload-but-never-delete enforcement mechanism.
   The other real boundary.
3. **§12** — the phase split. Two PRs vs. one or three.
4. **§14** — the nine open questions.

After Seth reacts on those, the immediate next step is the
**Phase X build PR** (low-risk + RLS lockdown + bug fixes). Phase
Y follows once Phase X verifies in production.

Status: **DRAFT for review.**

---

**End of parent-self-service scope doc — DRAFT.** No code, no
migration, no commit, no branch. Untracked. Halting for review.
