# Licensed Home Compliance — Open Question Decisions (2026-05-23)

**Source:** Decisions recorded in response to the open questions raised in `docs/licensed-home-compliance-audit-2026-05-23.md`. This doc is the authoritative answer set the PR scoping work draws from.

## OQ1 — R 400.xxxx citations

**Decision:** A complete mapping table was produced and committed to `docs/regulatory-rule-mapping.md` in this same commit. Every new compliance PR cites the actual Michigan Administrative Code (e.g. `R 400.1939`) in migration headers and code comments, matching the existing pattern from migration 012.

## OQ2 — Emergency plan: structured or uploaded PDF?

**Decision:** Structured fields. The PR for Category A (drills + emergency response plan) will model all 10 emergency types × the 9 plan dimensions as structured data. Tradeoffs accepted:

- Longer build (rated Large)
- Better data quality and inspectability
- Enables future template pre-population, printable plan generation, completeness validation

This bumps Category A from M/L back to L per the audit's contingent rating.

## OQ3 — License-type field reconciliation

**Decision:** New `license_type` ENUM as the compliance source of truth. The repo already has `is_license_exempt` (boolean) and `provider_type` (CDC-billing ENUM); a third independent field would risk three sources of truth. Instead:

1. Add `profiles.license_type` ENUM with values `'family_home'`, `'group_home'`, `'license_exempt'`
2. Backfill migration derives from existing signals:
   - `provider_type = 'licensed_family'` → `'family_home'`
   - `provider_type = 'licensed_group'` → `'group_home'`
   - `provider_type = 'licensed_center'` → flag for human review (out of milittlecare scope)
   - `is_license_exempt = true` → `'license_exempt'`
   - All other rows (null/ambiguous) → flag for human review via in-app prompt
3. Update `modules.js` to gate compliance modules on `license_type` not `is_license_exempt`
4. Update `LicenseStatusPromptModal` from binary (exempt yes/no) to ternary (family/group/exempt)
5. Add editor to `BusinessInfoPage`
6. Document `provider_type` as CDC-billing concept; `license_type` as compliance concept (both keep existing)

This is the scope of **PR #14 — License-type foundation**.

## OQ4 — Reminder channel + cron capacity

**Decision:** Email + in-app banners. Vercel Pro upgrade happens this week to remove the 2-cron limit (currently capped, acknowledgment digest disabled per `docs/tech_debt.md`). After upgrade:

1. Acknowledgment digest cron from PR #12 can be re-enabled
2. PR #15 (opt-in reminder system) builds for both channels from the start
3. Provider chooses per category and per reminder type (in-app only, email only, or both)

## OQ5 — Acknowledgment model ownership

**Decision:** Defer to PR scoping. The general `acknowledgments` table goes wherever the first consumer demands it most naturally. PR #16 (Child files / Category D) is likely the right home since the child-in-care statement is the first multi-acknowledgment bundle, but the decision is held until PR #16 scoping starts.

## OQ6 — `children.archived_at` retention gap

**Decision:** Standalone schema-hygiene migration BEFORE PR #16. Scoped as **PR #13 — children.archived_at + soft-delete audit**. Includes:

- Migration adding `archived_at timestamptz` to `children`
- App-code audit of every `children` query — add `archived_at IS NULL` filter or explicitly include archived rows
- Convention enforcement: matches existing pattern from `caregivers`, `funding_sources`, etc.

Sequenced before PR #14 (foundation) so the retention behavior is correct from the start of all compliance work.

## OQ7 — `business_policies` schema undocumented

**Decision:** Production introspection happens during PR #17 (Discipline policy / Category C) scoping. SQL query against production to enumerate columns; if discipline policy fits the existing table, use it; if not, document the schema gap in tech_debt and add a separate table. Do NOT scope PR #17 until this introspection is complete.

## OQ8 — Non-app-user staff arrival/departure log

**Decision:** Provider-entered log is acceptable. The rule (R 400.1906) requires the daily arrival/departure record exists but does not specify who enters it. Provider recording on behalf of drivers/volunteers who never log into the app is reasonable. This expands the existing `staff_time_entries` pattern (currently `staff_user_id`-keyed for app users) to also support a `caregiver_id`-keyed manual entry for non-app-users.

Caveat: if a licensing consultant interprets this differently, the decision will need revisiting. Until then, the simpler design wins.

## OQ9 — Staff ratios

**Decision:** Out of scope for the six compliance categories. The Family Home (R 400.1927) and Group Home (R 400.1928) ratio rules require a ratio-validation module, but the audit confirms no ratio enforcement exists today and no ratio module is in the six categories. Captured as a future PR in the backlog. Not a July deadline blocker.

## Updated PR sequence (post-decisions)

| # | Title | Scope | Difficulty |
|---|---|---|---|
| **PR #13** | `children.archived_at` + soft-delete audit | Schema hygiene; pre-req for Rule 7 retention | S |
| **PR #14** | License-type foundation | New ENUM, backfill, modules.js gating, UI capture | S-M |
| **PR #15** | Opt-in reminder system | Preferences model, settings UI, in-app + email channels | M |
| **PR #16** | Category D — Child files | Extends Children tab; introduces `acknowledgments` table | M |
| **PR #17** | Category C — Discipline policy | Policy storage, intake + hire acknowledgements | M |
| **PR #18** | Category E — Staff file gaps | Physician attestation, non-app-user clock | S-M |
| **PR #19** | Category A — Drills + emergency plan | Drill log, schedule engine, structured plan (10×9) | L |
| **PR #20** | Category B — Medication log | Authorizations + per-dose log, role gating | L (M after C/D) |
| **PR #21** | Category F — Property records | property_records + document vault generalization | M |

Compliance deadline: late July 2026 (~9 weeks from this decision). Sequenced to land dependencies first; foundation PRs (#13-#15) clear the deck before any of the six compliance categories ship.

## Backlog implications

Items to add to `docs/backlog.md` under future-work:

- **Staff ratio module** — R 400.1927 / R 400.1928. Not in compliance PRs.
- **Food allergy care plan surface** — R 400.1937. Possible future surface, not in the six categories.
- **CCBC API integration** — R 400.1919. Current implementation captures status manually; API integration would automate.
- **MiRegistry API integration** — R 400.1922 / R 400.1924. Future enhancement; current Tier 2 design tracks dates only.
- **Transportation tracking** — R 400.1951. Out of scope unless customer requests.
