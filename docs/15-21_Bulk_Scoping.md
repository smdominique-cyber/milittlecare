Bulk scoping pass for PRs #15-#21. No code changes, no migrations, no merges. Output is six scope documents committed to a new branch.
Required reading before starting (in this order):

docs/strategy.md — positioning, redetermination ownership section, segment analysis
CLAUDE.md — Critical Domain Knowledge, especially the two new bullets about Licensed Home compliance and providers' lived experience
docs/licensed-home-compliance-audit-2026-05-23.md — the master audit; this is the primary source for PR scopes
docs/licensed-home-compliance-decisions-2026-05-23.md — the locked-in decisions
docs/regulatory-rule-mapping.md — R 400.1901-1951 citations
docs/pr-14-license-type-foundation-scope.md — use this as the FORMAT TEMPLATE for the new scope docs
docs/backlog.md — the redetermination ownership entry (post-July priority, not in this scoping)
docs/tech_debt.md — current tech debt that PRs #15-#21 may interact with

Then read the existing code to ground each scope in what's already there:

src/lib/cdcProviderCompliance.js (the banner pattern PR #15 will generalize)
src/lib/modules.js and src/hooks/useActiveModules.js (license_type gating, post-PR #14)
Existing acknowledgment-shaped code in the codebase (search for "acknowledg" and "ack")
Existing schema in supabase/migrations/ (note current state)
src/pages/ and src/components/ for surfaces that will be touched

Then produce six scope documents in docs/:

docs/pr-15-opt-in-reminder-system-scope.md
docs/pr-16-child-files-scope.md
docs/pr-17-discipline-policy-scope.md
docs/pr-18-staff-file-gaps-scope.md
docs/pr-19-drills-emergency-plan-scope.md
docs/pr-20-medication-log-scope.md
docs/pr-21-property-records-scope.md

Each scope doc must follow the format of pr-14-license-type-foundation-scope.md and include:

Regulatory citation (R 400.xxxx) and what the rule requires
What MILittleCare already has vs what's missing (audit-grounded)
Schema changes (tables, columns, indexes, ENUMs, with rationale)
Files touched (components, pages, hooks, lib modules)
UI surfaces (where the feature appears, what it looks like in plain words)
Module gating (which license_type values activate it)
Open questions with proposed answers
Dependencies on prior PRs
Effort estimate (S / M / L)
Out-of-scope items that belong in a future PR

Critical design constraints to incorporate across the scopes:
A. PR #15 must be general-purpose, not compliance-specific. The reminder system will eventually serve CDC redetermination reminders, "remember to bill" reminders, MiRegistry deadline reminders, and other non-compliance use cases. The schema and code structure must accommodate arbitrary reminder types without refactor. Design the reminder type as a flexible enum or text+CHECK column with category and subject_id fields that can reference children, providers, funding_sources, etc.
B. PR #16 introduces the general acknowledgments table. It must support arbitrary acknowledgment types beyond R 400.1937 (lead, firearms, food provider, infant safe sleep). Design with a type discriminator column and flexible subject reference. Future consumers will include the CDC redetermination "parent responsibility" acknowledgment (post-July, not in this PR's scope but the table design must accommodate it).
C. All compliance modules gate on license_type IN ('family_home', 'group_home'). Not on is_license_exempt, not on michigan_license_number, not on provider_type. PR #14 already established this. LEPs see no compliance UI.
D. Emergency plan (PR #19) uses structured fields, not uploaded PDF. Per the decisions doc. Specific fields: assembly point, alternate shelter location, parent contact protocol, lockdown plan, fire route, tornado shelter location.
E. MiRegistry is system of record for staff training (PR #18). MILittleCare tracks dates only and links out. No duplication of training content.
F. Soft delete via archived_at columns is mandatory for retention-relevant tables. Per CLAUDE.md and PR #13 pattern.
G. All user-facing copy uses exact MiLEAP terms. Per CLAUDE.md.
H. Reminders are opt-in per category with configurable lead time. All reminder defaults are OFF.
Branch and commit instructions:

Create branch: docs/pr-15-21-scoping
One commit per scope doc, descriptive message
Push the branch but DO NOT open a PR or merge to main
Halt and summarize what was produced

Halt criteria:
When all six scope docs are committed and pushed to docs/pr-15-21-scoping. Summary should list each PR's: title, effort estimate, top 1-2 open questions, and any non-obvious schema decisions.
Operating rules:

No code changes
No migrations
No merges
If you find a contradiction between the audit and the decisions doc, follow the decisions doc and flag the contradiction in your halt summary
If you find ambiguity in the rules that the audit didn't resolve, propose an answer and flag it as an open question
If you find tech debt that one of these PRs would clean up, note it but do not expand scope
Stay grounded in what the audit actually says — don't invent new requirements

Halt when complete.

UPDATE:

Update the seven scope documents on branch docs/pr-15-21-scoping to reflect decisions made in tonight's review. No code changes, no migrations. Documentation only.
For each scope doc, update the "Open questions" section to mark each OQ as RESOLVED with the decision text, and propagate the decision into the relevant design sections so the doc reads as authoritative.
Decisions to incorporate, per PR:
PR #15 (docs/pr-15-opt-in-reminder-system-scope.md):

OQ1 (dismissal semantics): RESOLVED — until next tick for recurring, until resolved for one-shot
OQ2 (per-recipient targeting): RESOLVED — provider-only V1, recipient_user_id deferred
OQ3 (subject_type CHECK vs free text): RESOLVED — defer to Claude Code at implementation time
OQ4 (legacy banner consolidation): RESOLVED — follow-up PR, V1 keeps legacy banners
OQ5 (missing referenced docs): RESOLVED — leave as dead references for now
Add: Vercel Pro is assumed active. Email channel is in V1 scope, not a follow-up. Re-enable ack-digest cron + add dispatcher cron in same deploy.
Add: getReminderSystemAuditState() audit-state helper requirement per the audit-state mandate.

PR #16 (docs/pr-16-child-files-scope.md):

OQ1 (parent portal self-sign): RESOLVED — INCLUDED in PR #16, not deferred to PR #16.5. This bumps effort from M to M+. Add explicit parent-portal extension to the implementation plan: extends existing parent portal page from PR #12 with intake acknowledgment surface; email notification via PR #15 when intake acks pending; parent self-sign channel writes directly to acknowledgments with acknowledged_via='parent_portal'.
OQ2 (annual review enforcement): RESOLVED — soft (reminder + badge, no billing block)
OQ3 (backfill strategy): RESOLVED — existing children flip to "intake incomplete" until provider sweeps
OQ4 (envelope row): RESOLVED — yes, envelope row + 7 sub-disclosure rows. Composite hash on envelope.
OQ5 (provider_id denormalization): RESOLVED — yes, denormalize
Add: getChildFilesAuditState(licensee_id) audit-state helper requirement.

PR #17 (docs/pr-17-discipline-policy-scope.md):

OQ1 (Path A vs Path B): RESOLVED — Path A (column on business_policies). Production introspection confirmed: business_policies has ~22 columns including late_fee_*, late_pickup_fee_*, payment_methods jsonb, emergency_procedures text, policies_set boolean; no existing discipline_policy_* column. Add discipline_policy_text, discipline_policy_version, discipline_policy_updated_at columns.
OQ2 (version bumping): RESOLVED — manual via "Save as new version" button distinct from autosave. Include confirmation modal when saving as new version (cascades to stale acknowledgments).
OQ3 (editor location): RESOLVED — new dedicated /discipline-policy route under Compliance sidebar nav
OQ4 (required-clause linter): RESOLVED — warn-only, never blocks save
OQ5 (stale-ack remediation channels): RESOLVED — same channels as initial acknowledgment
Add: staff_discipline_policy_ack_pending reminder category added to PR #15's REMINDER_CATEGORIES catalog
Add: getDisciplinePolicyAuditState(licensee_id) audit-state helper requirement.

PR #18 (docs/pr-18-staff-file-gaps-scope.md):

OQ1 (ALTER TYPE ADD VALUE compatibility): RESOLVED — run normally, fallback to two-migration sequence only if it fails at apply time
OQ2 (CCBC backfill): RESOLVED — automatic with check_type='ccbc' for existing rows. Migration includes pre-UPDATE SELECT to count affected rows. Production introspection confirmed: staff_time_entries currently has staff_user_id uuid NOT NULL, no caregiver_id column — XOR pattern in §A.3 is correct and required.
OQ3 (clock log location): RESOLVED — on /staff, not /staff-training. Staff training matrix gets summary indicator only.
OQ4 (physician attestation scope): RESOLVED — per-personnel including licensee themselves
OQ5 (module gate migration): RESOLVED — migrate STAFF_TRAINING gate from is_license_exempt to license_type IN ('family_home', 'group_home') in this PR
Add: cpr_first_aid_expiration and physician_attestation_expiration reminder categories added to PR #15's catalog
Add: getStaffFilesAuditState(licensee_id) audit-state helper. Critical: the helper must distinguish between Type 1 (MiRegistry mirror data — NOT counted in audit score by default) and Type 2 (MILittleCare-owned data — counted). Type 1 items are exposed via the helper but tagged so PR #22's score-computation can apply the opt-in rules.

PR #19 (docs/pr-19-drills-emergency-plan-scope.md):

OQ1 (REQUIRED_CELLS matrix curation): RESOLVED — ship with Claude Code's best-guess matrix interpreting Rule 39 / R 400.1939 + Michigan training materials. Include explicit code comment: "Best-guess interpretation. Verify with licensing consultant or Michigan training materials. Adjusting affects displayed completeness percentage but not regulatory adequacy."
OQ2 (JSONB vs columns): RESOLVED — JSONB
OQ3 ("other" drill type): RESOLVED — keep as single catch-all with free-text description
OQ4 (multi-language plan output): RESOLVED — out of scope V1, English only
OQ5 (per-child vs head-count): RESOLVED — head-count integer columns
Add: drill_fire, drill_tornado, drill_other reminder categories added to PR #15's catalog
Add: getEmergencyPlanAuditState(licensee_id) audit-state helper.

PR #20 (docs/pr-20-medication-log-scope.md):

OQ1 (schedule format): RESOLVED — free text V1, structured with auto-due-dose V2
OQ2 (re-acknowledgment trigger): RESOLVED — derived via snapshot_hash comparison from PR #16
OQ3 (OTC permission shape): RESOLVED — blanket OTC permission per child + per-prescription acknowledgment for non-OTC
OQ4 (allergies display): RESOLVED — display prominently on medication form (authorization + dose log entry); pull from children.allergies; UI affordance only, no schema change
OQ5 (multi-witness for controlled substances): RESOLVED — out of scope
Add: medication_authorization_renewal reminder category added to PR #15's catalog
Add: getMedicationLogAuditState(licensee_id) audit-state helper.

PR #21 (docs/pr-21-property-records-scope.md):

OQ1 (generalize funding_documents vs sibling): RESOLVED — Option B, sibling compliance_documents table
OQ2 (detector check cadence): RESOLVED — annual default, configurable per provider via PR #15
OQ3 (parent-accessible licensing notebook): RESOLVED — parent-portal entry V1, no public shareable link
OQ4 (pet disclosure scope): RESOLVED — per-family
OQ5 (radon level capture): RESOLVED — free-text result V1, structured numeric V2
OQ6 (detector photo evidence): RESOLVED — out of scope V1
Add: radon_test_due, heating_inspection_due, detector_check_overdue reminder categories added to PR #15's catalog
Add: getPropertyRecordsAuditState(licensee_id) audit-state helper.

Cross-cutting additions to incorporate where relevant:
A. Audit-state helper pattern — every PR's "Pure helpers" section gets an explicit getXxxAuditState(licensee_id) function that returns a structured object describing audit signals from that PR's domain. Future PR #22 (Compliance Health Score) consumes these helpers.
B. Type 1 vs Type 2 distinction — only PR #18 has MiRegistry mirror data (Type 1). Other PRs are pure MILittleCare-owned (Type 2). The audit-state helper signatures should reflect this; Type 1 data is exposed but tagged, not counted by default.
Operating rules:

No code changes, no migrations, no merges
Stay on docs/pr-15-21-scoping branch
One commit per scope doc with descriptive message ("Resolve OQs and incorporate review decisions: PR #N — title")
After all seven are updated, push the branch
Halt with a summary listing what was changed per doc

Halt criteria:
When all seven scope docs have been updated and pushed, halt with a summary of changes per doc and any remaining questions or contradictions.