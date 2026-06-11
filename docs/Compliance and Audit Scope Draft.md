Task: Draft docs/pr-compliance-engine-scope.md — the scope/design doc for the compliance-state engine that underlies three planned views: (1) the compliance health score, (2) the per-child "what's missing" readiness checklist, and (3) the auditor access mode. Doc ONLY — no code, no migration, no commit, no branch. This is design work to review later. Halt when done. Take the time to do it thoroughly; this is the product's core-value arc.
Read first (read-only), to ground the design in what already exists:

docs/strategy.md and any roadmap/planning doc mentioning the compliance health score (it was specced in past planning as a V3+ feature — an aggregate score from feature signals: MiRegistry status, funding-doc completeness, CDC reporting, attendance integrity, licensing-doc expiration, authorization currency, R 400.19xx compliance, discipline/ack status, drill-log currency, medication-log compliance, property records — gated on "don't build until 7-10 signals exist"). Find and quote the actual planned spec.
CLAUDE.md (domain rules, the R 400.xxxx regulatory framing, the never-hard-delete and retention conventions).
The migrations and src/lib modules for the compliance-relevant features already shipped, to inventory which signals actually exist today: acknowledgments/consents (migrations 024/026/027 + src/lib/acknowledgments.js), medication (028 + src/lib/medication.js), consent attachments (029/030), funding documents (008), plus whatever MiRegistry / CDC / attendance / discipline / drill-log features are present. The goal is a real count of shipped vs. not-yet signals.
supabase/migrations/024_child_files_and_acknowledgments.sql and the parent-RLS patterns, and api/consent-attachment-url.js (the parent-read Edge Function) — because the auditor access boundary must be designed with the same rigor as the parent boundary that was just built and verified.

The core insight to design around: the score, the readiness checklist, and the auditor view are three faces of one underlying compliance-state model — a thing that can answer, per child and per provider: what is required, what is on file, what is expired, what is missing, what doesn't apply. Design the model once; the three views are projections of it (score = the aggregate rollup; checklist = the itemized per-child view for the provider; auditor view = a scoped, time-boxed, read-only external projection). Don't design three separate features.
Resolve these, as a proper scope doc with a "DECISIONS — RESOLVED" table (match the format/rigor of docs/pr-consents-B-scope.md):
1. The compliance-state model. What does "compliant" mean as data? For a given child (and provider), what is the authoritative list of requirements, and for each, what are the possible states (on-file / missing / expired / not-applicable / pending-parent)? Is this computed on-read from existing tables (acknowledgments, medication, funding docs, etc.), or materialized? Recommend on-read-computed first (a derivation layer over existing data) unless there's a strong reason to materialize. Propose where this logic lives (e.g. a src/lib/complianceState.js derivation module) and its shape.
2. The per-child APPLICABILITY problem (the hard one — resolve carefully). A requirement isn't "missing" if it doesn't apply to that child. A field-trip consent isn't missing if the provider never does field trips; an on-premises water consent isn't missing if there's no pool; a medication authorization isn't missing if the child takes no medication. So the model needs a notion of applicability per requirement per child/provider. How is applicability determined — provider-declared (the provider toggles "we do field trips" / "we have water activities"), inferred from data (a medication row exists ? med consent applies), regulatory-universal (some disclosures apply to every child always), or a mix? This is the difference between a checklist that's useful ("you're missing the 2 things that actually apply") and one that's noise ("you're missing all 12 things, most irrelevant"). Propose the applicability model. Note this connects to the parked parent-view bug ("what should each parent surface show per consent category") — they share this question.
3. The score. Given the state model + applicability, how does the aggregate score compute? Weighting (are all signals equal? are licensing-critical ones weighted heavier?), how applicability factors in (you can't be penalized for what doesn't apply), the "don't build until 7-10 signals" gate — and a real inventory of how many signals exist today (from the read above), so the doc states plainly whether the score is buildable now or still accumulating. Propose the score formula but flag that the formula is the least-certain part and should be tuned against real provider data.
4. The readiness checklist (provider self-check). The itemized per-child view — what's on file, what's missing-and-applicable, what's expiring. This is the inspection-prep view. Propose where it lives in the UI and what it shows. Lowest-risk of the three; mostly a projection of the state model.
5. The auditor access mode (design the BOUNDARY with full rigor). A time-boxed, scope-limited, read-only access mode for a licensing inspector. The provider selects which children's records the audit covers and generates per-day (expiring) credentials/link; the auditor sees a clean, organized, read-only view of exactly the selected children's compliance records and NOTHING else. This is a new access-control role — a third actor beyond provider and parent. Design:

The access mechanism (expiring token/link? a temporary scoped auth? — weigh options; the consent-attachment Edge Function is a reference for server-side scoped access).
The scope boundary: auditor sees ONLY the selected children, ONLY their compliance records, ONLY within the time window — and the cross-tenant/cross-scope denial must be as airtight as the parent boundary. Spell out the authorization check.
Expiry: how the window is enforced server-side (not just hidden in UI).
Read-only: structurally, not just by convention.
Name the verification gate this will need (the same caliber as the parent cross-tenant gate: prove an auditor scoped to child A cannot reach child B, and cannot reach anything after expiry — against real rows/auth).
Flag this as the highest-risk piece (it's a new auth surface) and recommend it be built/verified as its own phase, separately and last.

6. Build phasing. Given all the above, recommend how to sequence the build into phases (e.g. state model + applicability first ? checklist ? score ? auditor mode), what each phase depends on, and which phases are gated (the score on signal-count; the auditor mode on its own boundary verification). Note what's buildable now vs. what waits.
Also address: how this relates to / possibly subsumes parked items (the three parent-view bugs share the applicability question; the trips entity could be an applicability input — "does this provider do trips"); the state-modernization-hedge principle from strategy (compliance intelligence is explicitly a "survives state modernization" priority — note the alignment); retention/audit-trail implications.
Deliverable: a thorough scope doc with the DECISIONS table, the signal inventory (shipped vs. not), the applicability model, the auditor-boundary design, and a phased build recommendation. Set status to "Scope — DRAFT for review" (NOT "FINAL" — these are big design calls Seth must react to, especially #2 applicability and #5 the auditor boundary). Leave untracked (no git add, no commit). Where a decision is genuinely Seth's call (weighting in #3, applicability mechanism in #2, access mechanism in #5), present the options and your recommendation rather than forcing a choice. Halt with a summary of the decisions and the open questions flagged for Seth.


Phase 2
Task: Draft docs/pr-compliance-engine-phase-2-scope.md — the scope/design doc for Phase 2: refactor existing compliance-state consumers to read from the Phase 1 engine, which (per the parent scope doc) also fixes the three known parent-view consent bugs. Doc ONLY — no code, no migration, no commit, no branch. Halt for review.
Authoritative parent docs: docs/pr-compliance-engine-scope.md (§ on Phase 2) and docs/pr-compliance-engine-phase-1-scope.md (the engine that now exists). Read both. Phase 1 shipped src/lib/complianceState.js + src/lib/complianceStateLoader.js (merged to main) — the pure engine + impure loader. Read those two files to know the exact API Phase 2 consumes (getRequirementState, getChildComplianceState, getProviderComplianceState, resolveApplicability, the SourceRows shape, the six state kinds).
Read first (read-only), to map the consumers and the bugs:

src/lib/acknowledgments.js (pendingEnrollmentConsentsForChild) and src/lib/childFiles.js (getChildFilesAuditState) — the existing per-consent verdict logic the engine is meant to replace/supersede. Identify every consumer that currently computes consent/compliance state independently.
The parent-facing surfaces with the three known bugs: src/pages/ParentEnrollmentConsentsPanel.jsx, the parent intake view (ParentIntakeAcknowledgePage or wherever the Intake tab renders), and any other parent consent surface. The three bugs (from the parked list, all confirmed live):

Raw type string rendered instead of a friendly label on the parent Intake tab (e.g. water_activities_off_premises_per_trip shown literally).
Per-occurrence consent miscategorized into the parent intake-confirm bundle (a per-occurrence type appearing in the intake-confirmation flow where it doesn't belong).
No parent-facing "on file" surface for per-occurrence consents — the enrollment panel excludes them by design, so a parent sees "not on file" for everything even when per-occurrence consents exist. (The meatiest one.)


The provider-side consumers too: anywhere the dashboard, family view, or child view computes "what's on file / what's missing" independently (these should eventually read from the engine for consistency).

Resolve in the doc (with a DECISIONS table, matching prior scope-doc rigor):

Consumer inventory. List every place in the app that currently computes consent/compliance/on-file state independently — parent surfaces, provider surfaces, dashboards, badges. For each: what it computes now, and whether Phase 2 refactors it to read from the engine, or leaves it (with reasoning). Recommend the scope — likely the parent consent/intake surfaces (where the bugs are) are the priority; provider surfaces may be a later phase if they're working. Don't over-reach: refactoring a correctly-working consumer carries regression risk for little gain. Be explicit about what's in vs. out.
How the three bugs get fixed by the refactor. For each bug, trace why reading from the engine fixes it:

Bug 1 (raw string): the engine's registry has friendly labels per requirement — confirm the engine exposes a display label, and that the parent surface rendering from the engine would use it. If the engine doesn't currently expose labels, flag that as a Phase 2 addition (it's the registry; labels likely belong there).
Bug 2 (per-occurrence miscategorized): the engine correctly categorizes per-occurrence vs. enrollment vs. intake requirements — confirm the engine's categorization is authoritative and the parent intake surface reading from it would no longer miscategorize.
Bug 3 (no per-occurrence parent surface): this is the meaty one — it's not just a refactor, it's a missing view. The engine knows per-occurrence consent state, but the parent UI has nowhere to show it. So Phase 2 likely needs to add a parent-facing surface for per-occurrence consents (showing "on file" for recorded trips/water), informed by the "what should each parent surface show per consent category" question that's been parked. Resolve: what should the parent see for per-occurrence consents? (They're event records, not enrollment state — so the framing differs. Propose the UX.)


The "what each parent surface shows per consent category" model. Bug 3 forces this question, parked since the consent phases. Per consent category (intake-bundle, enrollment durable, time-bound, per-occurrence, medication), what should the parent see and where? Propose a coherent model so the parent surfaces are consistent, not patched ad hoc. This is the real design content of Phase 2.
Backward-compat / regression surface. The refactor changes live behavior on surfaces real users (including Vanessa's families) see. What's the risk that swapping a consumer to the engine changes a correct current behavior? How is that caught? This is NOT a dormant-library phase — it ships visible change. Name the verification approach.
Verification gate. Unlike Phase 1 (pure logic, tests sufficient), Phase 2 changes parent-facing UI, so the gate is partly live: (a) the three bugs are demonstrably fixed (state the before/after for each — what the parent sees now vs. after), and (b) no correctly-working surface regressed. Propose how to verify each — including which need a live check on a real account (the Jeff/klsnay/Dominique fixtures and the real consent data are available). Treat the three bug-fixes as explicit acceptance criteria.
Schema impact. Likely zero (reading from an existing engine), but if exposing labels or adding the per-occurrence parent surface needs anything, flag it. Confirm or flag.
Phasing within Phase 2. If this is large (refactor + a new parent surface + the category model), propose whether to split — e.g. the pure refactor of existing surfaces first (lower risk), then the new per-occurrence parent surface (the additive part) second. Recommend.

Deliverable: the consumer inventory, the per-bug fix tracing, the parent-surface category model, the regression/verification approach, schema confirmation, and a phasing recommendation. Status "Scope — DRAFT for review" (the parent-surface category model in #3 and the per-occurrence UX in bug 3 are design calls Seth must react to). Leave untracked. Halt with the decisions table and the open questions flagged — especially the parent-surface category model and whatever bug 3's new surface should look like.

Update 2

Task: Draft docs/pr-parent-self-service-scope.md — scope/design for parent self-service consents (low-risk tier + provider-initiated medium-risk tier with templates + e-signature), which supersedes the read-only Phase 2 (the three parent-view bugs fold in here). Doc ONLY — no code, no migration, no commit, no branch. Halt for review. This is a large feature touching a compliance-evidence boundary — scope it with a recommended phase-split, don't design it as one monolith.
Parent docs: docs/pr-compliance-engine-phase-2-scope.md (the read-only Phase 2 this supersedes — the consumer inventory and three-bug trace there are still valid; this feature builds the parent surfaces with actions instead of read-only). Read it. Also docs/pr-compliance-engine-phase-1-scope.md + src/lib/complianceState.js (the engine these surfaces read from). And read the existing parent surfaces (ParentEnrollmentConsentsPanel.jsx, ParentIntakeAcknowledgePage.jsx, ParentAcknowledgmentsPage.jsx) and the intake-confirm flow (the existing "parent completes a pending action" pattern — the medium-risk send/complete flow mirrors it).
The design (locked by Seth — build the scope around these):
Two tiers of parent action:
Low-risk — default ON, parent-initiated (parent just does these):

Photo-sharing consent: grant + revoke.
Their own data: contact info, emergency contacts, authorized-pickup list.
Child data they author: allergies, medical notes, dietary needs, child's doctor/dentist.
Acknowledging receipt (handbook, licensing-rules notice, policies).
Viewing/downloading their own records.
Rationale: none of these are licensing "written permission" requirements OR the parent is the natural author — no compliance-evidence risk. (Note: for care-critical edits like allergies/medical, the provider must be notified of the change.)

Medium-risk — provider-gated, provider-initiated, parent-completed:

Covers the licensing "written permission" consents: field trip (R 400.1952(2)), routine transportation (R 400.1952(1)), water activities (R 400.1934(10)).
Provider enables the category under the Business tab (dashboard). OFF by default. This is the compliance safety-valve — the provider decides whether their inspection context accepts electronic parent acknowledgment.
Templates: managed under the Business tab. Ship compliant starter templates (one per medium-risk consent type, with the R 400.xxxx-required elements present) that the provider can customize. A disclaimer makes clear the provider owns the final language and its compliance. Nothing is free-form-from-scratch without a compliant base.
Provider sends from the child's record (viewing a child ? pick a template ? send to that child's parent). Nothing reaches a parent without this deliberate provider action.
Parent completes in the portal: the sent consent lands as a pending to-do (mirror the intake-confirm pattern) plus a notification. The parent completes via typed-name e-signature.
The record (the compliance-evidence boundary — design carefully): a completed medium-risk consent must capture and store, as a producible-at-inspection electronic record: the authenticated parent identity, the typed-name signature string, a timestamp, and the exact template text the parent agreed to (snapshot the text at completion — if the provider later edits the template, the completed record must still show what this parent actually agreed to). This is what makes it defensible as "written permission." Specify the data model for this (likely extends the acknowledgments pattern — acknowledged_via='parent_portal_esign' or similar, with the signature + template snapshot stored). Confirm whether this needs schema (likely yes — a place to store the typed signature + template snapshot) and flag it.
Additive: enabling parent self-service does NOT remove the provider's ability to record the consent on paper as today. Both paths satisfy the requirement.

Cross-cutting rules:

Parents can upload but NEVER delete. Any parent-facing action can add/create/upload; deletion and archival stay provider-only (preserves the never-hard-delete audit trail). Enforce this at the data layer (RLS), not just UI — a parent must not be able to archive/delete any record, including their own uploads.
The three parent-view display bugs (raw type string, per-occurrence miscategorization, no per-occurrence parent surface) get fixed as part of building these surfaces correctly — they're the same surfaces. Carry the fixes from the Phase 2 scope.
Still excluded: religious-objection / immunization waivers (require signed official forms — stay provider-recorded + attachment, not e-sign self-service).

Resolve in the doc (DECISIONS table, prior-scope rigor):

Data model for the medium-risk e-signature record (signature + template-text snapshot + identity + timestamp) — schema needed? Flag it.
The template system — storage, the compliant starters (draft the required elements per consent type from the actual R 400.xxxx rules), the customization + disclaimer, the snapshot-at-send-or-completion mechanic.
The provider-send flow (from child's record) and the parent pending-to-do + notification flow — mirror intake-confirm.
The Business-tab UI: category enablement toggles + template management.
The low-risk tier UI — where each low-risk action lives in the parent portal; the provider-notification on care-critical edits.
The upload-but-never-delete RLS enforcement — how the policies guarantee parents can't delete.
Verification gate — this touches a compliance-evidence boundary AND parent-facing live behavior. Name what must be verified live: the e-sign record captures everything needed (esp. the template snapshot surviving later template edits), the upload-not-delete RLS denies parent deletion (test against real auth, like the attachments boundary), the three bugs fixed, no regression. Treat the upload-not-delete RLS as a real boundary needing the same live-verification caliber as the consent-attachments cross-tenant gate.
Phase split — recommend how to break this into buildable/verifiable phases. Likely: low-risk tier (lower risk, additive) as one phase; the medium-risk template+send+e-sign system as another (it has the compliance-evidence boundary + schema, verify separately); the bug-fixes can ride with whichever touches those surfaces first. Recommend the sequence and what each phase's hard gate is.

Deliverable: the decisions table, the data model (with schema flagged), the template starter requirements per consent type, the flows, the RLS design for upload-not-delete, the verification gates, and the phase-split recommendation. Status "Scope — DRAFT for review" (the data model, the template-snapshot mechanic, and the e-sign record are design calls Seth must react to). Leave untracked. Halt with decisions + flagged questions — especially the e-signature record's data model and the upload-not-delete 
RLS.

Phase 3 

Task: BUILD Phase X — parent low-risk self-service + upload-but-never-delete RLS lockdown + the three parent-view bug fixes. Per docs/pr-parent-self-service-scope.md (Phase X section). Branch off main, build, push, halt. Migration written but NOT applied (Seth applies). Do NOT merge — there's a live verification gate (the upload-not-delete boundary).
Authoritative spec: docs/pr-parent-self-service-scope.md — Phase X scope. Read it fully. Phase Y (templates + e-signature) is OUT of this build entirely — do not build templates, the e-sign record, or any new tables. Also read docs/pr-compliance-engine-phase-2-scope.md (the three-bug trace + consumer inventory — still valid; build the surfaces with low-risk actions instead of read-only). And read src/lib/complianceState.js (the engine the surfaces read from), the parent surfaces (ParentEnrollmentConsentsPanel.jsx, ParentIntakeAcknowledgePage.jsx, ParentAcknowledgmentsPage.jsx), and migration 016 (the existing emergency_contacts + guardians parent DELETE policies that Phase X removes).
Branch: git checkout main, git pull, create feature/parent-self-service-phase-x. Confirm before editing.
Build — three things:
1. The upload-but-never-delete RLS lockdown (the boundary — closes a LIVE gap). Per §7, Option A (Seth-approved):

Remove the parent DELETE policies on emergency_contacts and guardians (migration 016 currently grants these — production parents can currently delete these records; this closes that).
Add a block_parent_archive BEFORE UPDATE trigger on the parent-writable tables that prevents a parent from setting archived_at (or otherwise soft-deleting). Defense-in-depth: both the DELETE path and the archive path blocked for parents.
Apply to every table a parent can write. Enumerate them explicitly (emergency_contacts, guardians, and any others the low-risk tier touches — contact info, child medical/allergy/dietary, photo consent). Missing a table = a hole, so list them and cover each.
Provider archive/delete is unaffected — only the parent role is blocked from deletion/archival.
Replace any parent-facing "delete" UI with "remove from active list" semantics that route to a provider action (or simply remove the parent's delete affordance), per §2c — propose the cleanest UX.
This goes in a migration (written, NOT applied — Seth applies). Confirm next migration number on disk.

2. The low-risk self-service tier (default ON, parent-initiated). Per §2/§5:

Photo-sharing consent: parent can grant + revoke.
Parent's own data: contact info, emergency contacts, authorized-pickup (edit, add — NOT delete per #1).
Child data the parent authors: allergies, medical notes, dietary, child's doctor/dentist (edit, add — NOT delete).
Acknowledging receipt (handbook/rules/policies).
All reads (view/download own records).
Care-critical edits notify the provider (allergies, medical) via the existing notify-state-change mechanism (§14 decision) — wire this so a provider learns when a parent changes safety-relevant data.
All writes through the appropriate data-layer helpers — no inline Supabase in components.

3. The three parent-view bug fixes (fold in, per the Phase 2 trace):

Bug 1: raw type string ? use the engine's registry label (rendering reads from complianceState.js, not the raw a.type).
Bug 2: per-occurrence consent miscategorized into the intake-confirm bundle ? the parent intake surface projects only category: 'child_files' requirements from the engine; per-occurrence (category: 'consents') no longer leaks in.
Bug 3: no per-occurrence parent surface ? NOTE: the full per-occurrence parent view was the Phase 2B/Phase Y read-only-vs-esign question. For Phase X, build the read-only per-occurrence "on file" surface (collapsed disclosure per the earlier decision — "? Per-trip transportation permissions (N on file)") so parents can SEE recorded per-occurrence consents. The e-sign/self-serve version of these is Phase Y (medium-risk). So Phase X gives per-occurrence a read-only surface; Phase Y later adds the ability to complete them. Confirm this split is clean.

Constraints: NO templates, NO e-signature, NO new tables (those are Phase Y). Migration is policy + trigger + any small column adds only — NOT applied (Seth applies). All parent writes through data-layer helpers. Don't touch untracked junk.
Tests: the low-risk action logic, the bug-fix rendering (label lookup, category projection), and unit coverage where the harness allows. Build clean, vitest green (existing suite + new, no regression).
Commit + push, halt. Do NOT merge. Commit msg: feat(parent-self-service): Phase X — low-risk self-service + upload-not-delete RLS lockdown + parent-view bug fixes.
Verification gate — the upload-not-delete boundary must be proven LIVE against real auth (same caliber as the attachments cross-tenant gate). Tests don't prove RLS; real parent auth does. After Seth applies the migration, the gate (using the real fixtures — Jeff/2549scio, klsnay, Dominique family):

Parent CANNOT delete — signed in as a real parent, attempt to delete/archive an emergency contact, a guardian, and each other parent-writable record. Every attempt must be DENIED (RLS blocks DELETE; trigger blocks archive). Enumerate each table tested.
Parent CAN still add/edit — the same parent can add an emergency contact, edit contact info, update an allergy ? succeeds (upload/edit works; only delete is blocked).
Provider CAN still delete/archive — the provider is unaffected.
Care-critical notify fires — a parent allergy/medical edit notifies the provider.
The three bugs fixed — on a real parent account: no raw type strings (friendly labels), no per-occurrence consent in the intake-confirm bundle, and per-occurrence consents now show in a read-only "on file" surface. Before/after per bug.

Gate: #1 is the boundary — if a parent can delete or archive ANY record on ANY parent-writable table, the lockdown has a hole; halt, don't merge, find the missing table. Report the migration SQL for Seth to apply and the exact step-by-step for the live gate.

Phase 3
Task: Draft the scope doc for Compliance Engine Phase 3 — the compliance checklist surface + applicability resolution. Document ONLY — no code, no migration, no branch beyond the doc. Write to docs/pr-compliance-engine-phase-3-scope.md, commit on a docs branch, push, halt. Do NOT build, do NOT merge. This is scope-and-approve, like the Y1 and compliance-engine-phase-1 scope docs.
Read first (authoritative): docs/pr-compliance-engine-scope.md + the phase-1 and phase-2 scope docs, src/lib/complianceState.js + complianceStateLoader.js + complianceState.test.js (the shipped pure engine — the REQUIREMENT_REGISTRY, the six states, resolveApplicability, the 'auto' default), docs/feature-interaction-map.md (§7 compliance + §13 planned + §15 divergence #10), docs/regulatory-rule-mapping.md, and the licensed-home compliance audit/decisions docs. Match the rigor and format of the phase-1 scope doc.
What Phase 3 is (confirm against the phase-1/overall scope, don't invent): the surface that runs the shipped engine against a real provider + their children and shows requirement states, PLUS the applicability-resolution mechanism — the compliance_applicability_overrides table and the onboarding questions (transport routinely / pool / animals) that populate it, so the engine's deliberately-unknown 'auto' requirements can be resolved per provider rather than silently defaulting.
Resolve these in the scope doc (decisions table + rationale, Y1-style):

The applicability overrides table — shape of compliance_applicability_overrides (per-provider? per-child? per-requirement?), how it feeds resolveApplicability, and how it interacts with the engine's hybrid model (universal / data-inferred / provider-declared). Confirm it never lets the engine silently resolve a real regulatory requirement to not_applicable without an affirmative provider answer — that's the load-bearing §2a principle from phase 1; the override is the affirmative basis, not a silent default.
The onboarding questions — which questions (the scoped three: transport routinely, pool/water, animals — confirm against the phase-1 doc), where they're asked (the existing onboarding wizard? a new compliance-setup step? the Business tab?), and how a provider changes the answer later (the phase-1 doc noted these need a settings surface — does Phase 3 build it or defer?).
THE CATALOG-VS-CAPTURE-SURFACE PROBLEM (flagged by the feature map, §15 #10): the registry deliberately includes requirements that have NO capture surface yet (drills, property, discipline policy, physician attestation, religious objection — they return unknown / feature-not-yet-shipped, shipping in PRs #17–#21). The checklist WILL surface these. Decide and document how the checklist presents a requirement that exists in the catalog but has nowhere to be satisfied yet: a distinct "coming soon / not yet trackable" state? Hidden until its PR ships? Shown as unknown with an explanation? This is a real UX decision Phase 3 must make — the checklist can't just show a pile of unexplained "unknown" rows a provider can't act on. Recommend an approach with reasoning.
The checklist surface itself — where it lives (new page? Business tab? dashboard section?), what it shows (per-child? per-provider? both?), how the six engine states render, and what's actionable from it (does clicking a missing_required row deep-link to where you satisfy it, or is it read-only display in Phase 3?).
Read-only vs. actionable scope — is Phase 3 just display + applicability resolution, with the score (Phase 4) and the deep-link-to-fix as later phases? Recommend the cut that keeps Phase 3 shippable on its own.
The verification gate — Phase 3 touches the engine's correctness principle, so spell out what must be proven (the applicability override produces the right state transitions; an unanswered 'auto' requirement stays unknown not not_applicable; the not-yet-modeled requirements present gracefully). Live-verify against real provider data, same caliber as prior gates.

Constraints: doc only. Status "Scope — DRAFT for review." The genuinely open calls (the overrides table shape, where onboarding questions live, and especially the catalog-vs-capture-surface presentation) are Seth's to approve. Flag anything that depends on PRs #17–#21 that haven't shipped. Don't touch untracked junk.
Report: the decisions table, the open questions for Seth, and especially your recommendation on #3 (the catalog-vs-capture-surface presentation) since the feature map flagged it as unresolved.

Phase 3 Task 2
Task: BUILD Compliance Engine Phase 3 per the approved scope docs/pr-compliance-engine-phase-3-scope.md. Seth has approved all decisions, including the three open calls: #4 Option A (distinct "not-yet-trackable" state), #3 (Business Info "What applies to my program?" section, no onboarding-wizard change, no first-open mini-prompt), #2 (per-provider overrides, with nullable family_id/child_id columns shipped unused for forward-compat). Build on a branch off main, halt. Migration written but NOT applied (Seth applies manually). Do NOT merge — Phase 3 has a live verification gate first.
Read first: the approved scope doc (build to it verbatim), src/lib/complianceState.js + complianceStateLoader.js + complianceState.test.js (the shipped engine — resolveApplicability, the overrides: Map seam decision #1 references, the registry's data_state/reason fields), docs/feature-interaction-map.md §7, and the Phase 1 scope doc for the §2a never-silently-resolve principle.
Build, per the scope's locked decisions:

Migration — compliance_applicability_overrides table. Per-provider rows (provider_id, requirement_key or applicability_key, the answer/value, timestamps, soft-delete per the project's archived_at convention). Include family_id and child_id columns nullable and unused (forward-compat per decision #2 — comment them clearly as reserved-for-future-per-child-scope so a future reader knows they're intentional, not dead). RLS: provider reads/writes own rows only. Idempotent. Header carries the verification SQL Seth runs after applying. And the canonical SECURITY DEFINER trailer + revoke from anon on any function (per the CLAUDE.md rule — this is exactly the recurring trap).
The applicability input surface — the Business Info "What applies to my program?" section. The scoped questions (transport routinely / pool-water / animals — confirm the exact set against the scope doc and Phase 1 registry). Writes to the overrides table. A provider can change answers later (it's a settings section, not a one-time wizard step). Each answer feeds resolveApplicability so an affirmative answer resolves the relevant 'auto'/unknown requirement — and critically, an unanswered question leaves the requirement unknown, NEVER silently not_applicable (the §2a load-bearing principle).
The checklist surface — the read-only compliance display. Per decision #7: a /compliance sidebar page (provider-level) AND a per-child Compliance tab in Families. Renders the engine's six states. Per decision #4 Option A: requirements whose registry row has data_state indicating not-yet-shipped (the feature-not-yet-shipped reason) render in the distinct visual state — the "tracking ships with PR #N, keep paper records, an auditor will ask" treatment — NOT hidden, NOT confused with awaiting-provider-input. Read the registry's reason/data_state to drive this; don't hardcode the list.
Read-only scope (decision #6) — Phase 3 displays + resolves applicability. NO deep-link-to-fix, NO score. Those are later phases. Don't build them.
Opt-in posture (decision #8) — ON for new providers, OFF for existing during rollout. Implement whatever gating the scope specifies.

Constraints: build to the approved scope; where the scope and this prompt differ, the scope doc wins (flag the discrepancy). Migration written, NOT applied. Don't touch untracked junk. Tests for the new logic (the applicability-override ? state-resolution path especially — prove an unanswered question stays unknown, an affirmative answer resolves correctly).
Build clean, full suite green. Commit + push, halt. Do NOT merge.
The verification gate (HARD — no merge until it passes, run by Seth after applying the migration, against real provider data):

Migration applied + schema confirms (table, columns incl. the nullable forward-compat ones, RLS, any function grants — confirm no anon).
Answer an applicability question (e.g. "we have a pool") ? the relevant water requirement resolves from unknown to applies/tracked. Confirm live.
Leave a question UNanswered ? its requirement stays unknown, NOT not_applicable. This is the §2a proof — the load-bearing one.
A not-yet-shipped requirement (drills/discipline-policy/etc.) renders in the Option-A "keep paper records" state, NOT hidden, NOT plain-unknown.
The checklist shows correctly at both the /compliance provider level and the per-child Families tab.
If step 3 or 4 fails, halt — those are the principle-bearing checks.

Report: what was built, the migration SQL for Seth to apply, and the exact gate steps.

3.1 Scope 
Task: Draft the scope doc for Compliance Engine Phase 3.1 — actionable guidance + deep-link-to-fix on the compliance checklist. DOCUMENT ONLY — no code, no migration. Write to docs/pr-compliance-engine-phase-3-1-scope.md, commit on a docs branch, push, halt. Do NOT build, do NOT merge. Scope-and-approve, same discipline as the Phase 3 scope doc. Precondition: Phase 3 is merged (commit b6dd1d5); 3.1 builds on it.
Read first (authoritative): the merged Phase 3 code — src/lib/complianceState.js (the REQUIREMENT_REGISTRY, the six state kinds, the classifyUnknownReason buckets including needs_provider_data and feature_not_yet_shipped), src/components/compliance/ChecklistRow.jsx (where rows render today), ComplianceChecklistPage.jsx, FamilyComplianceTab.jsx; the Phase 3 scope doc + docs/regulatory-rule-mapping.md; docs/feature-interaction-map.md for the fix-surface routes. Match the rigor/format of the Phase 3 scope doc.
What 3.1 is: every gap row on the compliance checklist becomes actionable — it tells the provider, in plain language, how to resolve the gap, and where a real fix surface exists, gives them a deep-link button to go there. Built as a reusable provider-facing component (<ActionableGap> or similar) so future surfaces (dashboard banners, Staff Training, MiRegistry, iBilling, funding vault) can adopt it — but 3.1 ships it on the compliance checklist ONLY. Approved scope decisions (Seth confirmed):

Both tiers: guidance text + deep-link button.
Deep-link where a real target exists; guidance-text-only where it doesn't (a button to nowhere is worse than no button).
Reusable component built day-one, shipped on compliance only (prove it in one place; other adopters are separate later PRs).
CC drafts the per-requirement guidance content; Seth reviews the flagged/low-confidence ones.

Resolve these in the scope doc (decisions table + rationale, Phase-3-style):

The component contract. Design the reusable primitive: what props ({ guidanceText, fixTarget?: { label, to, params }, severity }?), how it renders the guidance + optional button, how a consumer with no fixTarget degrades to text-only. Make the contract generic enough that a dashboard banner or Staff Training row could adopt it unchanged — but don't build those; just prove the contract isn't compliance-specific. Where does it live (src/components/compliance/ for now, or a shared src/components/ui/ since it's meant to spread)?
THE CORE WORK — the per-requirement guidance + fix-target table. For EACH of the ~52 registry requirements (or each meaningfully-distinct gap type), produce a row: requirement key ? its gap states ? the plain-language "how to resolve" guidance ? the deep-link fix target (route + params) OR "no target — text only" with the reason. This is where the real scoping lives. Group by fix-surface. CRITICAL: for each fix target, confirm the route actually exists and is addressable — e.g. "missing staff record ? /staff-training" only works if that page can be deep-linked to the right caregiver; "missing DHS-198 ? funding vault" needs the funding-document-slot to be reachable by URL. The Phase 3 Finding #5 fix added a ?family=&tab= deep-link scheme to FamiliesPage — note which targets can reuse that vs. which need new param-handling (and flag the latter as sub-work). Mark every requirement where you're NOT confident the guidance is regulatorily accurate as "NEEDS SETH REVIEW" — Seth is the accuracy check; wrong compliance guidance is worse than none.
Map guidance to the existing state buckets. The rows already classify into missing_required, expired, pending_parent, needs_provider_data, awaiting_input (deep-links to Business Info "What applies"), feature_not_yet_shipped (keep-paper, NO fix target — leave as-is), not_applicable (no action). Define what guidance + target each bucket gets. Note: feature_not_yet_shipped and not_applicable rows should NOT get fix-buttons — confirm that.
Deep-link infrastructure reuse. The FamiliesPage useSearchParams + KNOWN_TABS + clearDeepLinkParams scheme from Phase 3 Finding #5 is the precedent. Decide: which fix targets reuse it, which need their own page to gain param-handling (each of those is sub-work to enumerate), and whether the read/clear helpers should be extracted into a shared module now (tech_debt flagged this).
Read-only-ness preserved. 3.1 adds navigation to fix surfaces — it does NOT add inline editing on the checklist itself. The checklist stays a read-only dashboard; the fix happens on the destination surface. Confirm this scope boundary.
Verification gate. Spell out what the live gate proves: guidance text renders correctly per bucket; deep-links land on the right fix surface (reusing the Phase 3 Finding #5 verification pattern); no-target rows show text-only with no dead button; the component renders identically whether or not a fixTarget is supplied.

Constraints: doc only. Status "Scope — DRAFT for review." The genuinely open calls for Seth: the guidance content accuracy (#2 — flag everything uncertain), and any fix target that needs new deep-link param-handling (a size/scope question — those might defer to 3.2). Flag any requirement whose fix surface doesn't exist yet. Don't touch untracked junk.
Report: the decisions table, the full per-requirement guidance+target table (#2) with every "NEEDS SETH REVIEW" clearly marked, the list of fix targets that need new param-handling (sub-work), and the open questions for Seth.