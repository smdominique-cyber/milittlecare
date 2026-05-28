# MILittleCare

Michigan-focused SaaS for in-home daycare providers. The differentiator is deep integration with Michigan-specific programs (CDC scholarship, Tri-Share, GSRP) that national competitors (Brightwheel, Procare) don't touch. The goal is to become the default operating tool for Michigan home daycare providers who accept CDC scholarship payments.

## Tech Stack

- Frontend: React 18 + Vite (JavaScript, not TypeScript)
- Backend: Supabase (Postgres, Auth, Storage)
- Hosting: Vercel
- Routing: React Router 6
- Icons: lucide-react
- Excel: xlsx package (used for receipts; will be used for I-Billing exports)
- Images: browser-image-compression for parent uploads
- Lint: ESLint with React rules, --max-warnings 0 (strict)
- Testing: None yet. Add Vitest when first needed.

## Commands

- npm run dev — start Vite dev server
- npm run build — production build
- npm run preview — preview production build locally
- npm run lint — ESLint check, fails on any warning

## File Structure

- src/App.jsx — root component, routing setup
- src/main.jsx — entry point
- src/components/ — reusable UI components
- src/pages/ — route-level page components
- src/hooks/ — custom React hooks
- src/lib/ — utilities, Supabase client
- src/styles/ — CSS
- api/ — Vercel serverless functions
- supabase/migrations/ — sequential SQL migrations (001_, 002_, etc.)

NOTE: src/ReceiptsPage.jsx currently lives at src/ root; should eventually move into src/pages/. Not urgent.

## Conventions

- JSX file extensions, not JS
- Functional components with hooks; no class components
- Supabase client imported from src/lib/ (verify exact path before importing)
- Database access through Supabase JS client; no direct SQL from frontend
- Migration files numbered sequentially: 003_funding_sources.sql, etc.
- Migrations are forward-only by default; include a Down section as comments for rollback steps when destructive
- Commit messages: imperative, under 72 chars
- Error states announce to screen readers via `role="alert"`. Sets a project-wide accessibility baseline.

## Critical Domain Knowledge

This product handles real money via CDC scholarship reimbursement to providers and audit-track compliance for license-exempt providers. Mistakes have financial and regulatory consequences. Specifically:

- Audit retention: 4 years for licensed providers, longer for license-exempt. Never hard-delete funding or attendance records — use soft delete via archived_at columns.
- CDC compliance terminology: Use exact MiLEAP terms in user-facing copy. "CDC Scholarship" not "subsidy." "I-Billing" not "billing portal." "MDHHS-4025" not "verification form." "MiRegistry" not "training tracker."
- Module activation principle: Features hide themselves when not relevant to a provider's active funding mix. A private-pay-only provider should never see the word "CDC" anywhere in the UI. See docs/funding_source_spec.md for the full design.
- CDC-primary providers are the norm, not the exception: many MILittleCare providers — especially home daycare and license-exempt — have CDC Scholarship as the funding for the MAJORITY of their roster. The hybrid funding model (private_pay per family, CDC/Tri-Share/etc. per child) is correct, but UI and copy must not imply that private_pay is "the default case." Future backfills must not assume a default funding type — flag rows for human review instead of guessing.
- **MiRegistry deadline + Level 2 mechanics (license-exempt providers).** Per the *Scholarship Handbook for License Exempt Provider* (rev 2026-04, pages 11–13, 22): every license-exempt provider must complete the Annual Ongoing Training (Michigan Ongoing Health & Safety Refresher) by **December 16** each year. Missing the deadline closes the provider's account, and they must reapply with MDHHS before resuming CDC billing. Pay rate is $2.95/hour at Level 1 (default after LEPPT) and $4.40–$4.95/hour at Level 2, varying by child age band. Level 2 requires 10 hours of MiRegistry-approved training (each session ≥ 1 hour; LEPPT itself doesn't count) and resets on a **rolling expiration date** set by MiRegistry every 10 additional hours — not a calendar year. A provider whose Level 2 expiration falls mid-year drops back to Level 1 effective that date — pay-rate logic must check the level on the actual care date, not the year. We store the level and expiration date as transcribed values from the MiRegistry transcript; we do not compute them ourselves. See `docs/miregistry_tracker_spec.md` and `src/lib/miregistry.js`.
- Real customer in production: Venessa is a live user with real data. Migrations must be reversible; backfills must be reviewed before applying to production data.
- Schema verification requires user-visible dashboard evidence. After any production schema change, the user personally runs verification queries in the Supabase web SQL Editor and saves a screenshot of the results. Migration runbook entries are not written until that evidence exists. Claude Code reports of verification are insufficient — see `docs/tech_debt.md` § Verification gap discovered 2026-05-15.
- **Licensed Home compliance: R 400.1901-1951 adopted 2026-04-27.** Michigan Child Care Home Licensing Rules took effect with an approximately 90-day compliance window. Licensed Family Homes (up to 6 children) and Group Homes (up to 12 children) must be fully compliant by approximately late July 2026. MILittleCare's positioning is the "Licensed Home" version targeting Family Home, Group Home, and License-Exempt Provider segments. Compliance modules gate to licensed homes only via the `license_type` field (PR #14); LEPs see no compliance UI. The six compliance categories ship as PRs #16-#21 with PRs #13-#15 as foundation work. See `docs/licensed-home-compliance-audit-2026-05-23.md`, `docs/licensed-home-compliance-decisions-2026-05-23.md`, and `docs/regulatory-rule-mapping.md`.
- **Providers' lived experience is data, even when their mechanism explanation is wrong.** When a provider says "kids fall off without warning," they are describing their experience. The mechanism (the state mails a notice that providers miss) is technically a warning, but if providers consistently miss it, the warning has functionally failed. When validating features against customer feedback, separate "what they experience" from "what they think is happening." Build for the experience. Don't dismiss feedback because the mechanism explanation is wrong. Example: redetermination falloffs. State says they notify. Providers say they're not notified. Both are true at different levels, and the gap is the product opportunity. Surfaced during May 2026 customer research; see `docs/customer-research-2026-05-23.md`.
- **What MILittleCare owns vs mirrors.** Records that live in MILittleCare's own schema (Type 2) - CPR/First Aid certs, physician attestations, discipline policy acknowledgments, drill logs, medication events, property records, child intake - are the provider's local audit-of-record. An auditor walking into the home sees these as the provider's records. Records mirrored from MiRegistry (Type 1) - annual ongoing training completion, professional development hours, MiRegistry account status - are convenience surfaces. MiRegistry is the system of record per R 400.1922; an auditor verifies these in MiRegistry, not in MILittleCare. Design implication: audit-state helpers tag Type 1 fields explicitly; compliance health score (future PR #22) excludes Type 1 from the score by default with a per-category opt-in toggle.
- **Audit state and GSQ readiness are related but distinct.** Audit state measures regulatory compliance risk (am I exposed if licensing walks in?). GSQ (Great Start to Quality) measures program quality (am I 1-5 star rated?). The two share roughly half of the underlying signals - staff qualifications, family partnerships, written policies, drills - but GSQ also requires observation-based evidence MILittleCare doesn't currently capture (curriculum quality, classroom environment, teacher-child interactions). A given data capture often serves both readers. Design implication: audit-state helpers can tag GSQ-relevant signals as such; the eventual GSQ readiness widget consumes a different subset of the same data. Both trackers are opt-in, default OFF.
- **Defense in depth for legally consequential rules.** Most app rules are enforced in JavaScript code only - sufficient for typical product invariants. But rules where bypass means real legal exposure (e.g. R 400.1931 prohibition against assistants/volunteers administering medication) get enforced at BOTH the app code AND the database trigger level. This redundancy protects against future admin tools, API endpoints, or migrations that might bypass app code. First example: PR #20's medication_event_caregiver_role_check() trigger on medication_administration_events. Apply this pattern selectively - most app rules don't need it; rules with legal liability do.
- **Compliance health score and GSQ readiness are opt-in surfaces, default OFF.** Some providers want a quantified view of their audit risk or quality-rating progress. Others find scores stressful or surveilling. The widgets are enabled in settings. Within the audit score, MiRegistry mirror data inclusion is a per-category sub-toggle (default strict - only MILittleCare-owned data counts). Surfaces opt-in across the board.
## Module Architecture

The app is moving toward a funding-source-driven module activation model where features turn on/off based on which programs a provider's children are funded by. See docs/funding_source_spec.md for the design and current roadmap. Already shipped: scaffolding, funding document vault, MiRegistry deadline tracker. Next up: CDC pay period catalog, attendance foundation, CDC I-Billing reconciliation. Tri-Share split billing is deferred until real demand surfaces — see funding_source_spec.md § Roadmap for rationale.

## Build Discipline

- Branch before any non-trivial change: git checkout -b feature/...
- Small, logical commits. Don't bundle unrelated changes.
- Show proposed file changes before applying. Wait for approval on multi-file PRs.
- Don't run database migrations against production without explicit approval.
- Don't install dependencies without explicit approval.

## Documentation Conventions

1. **User help is inline.** Every user-facing feature requires inline help in the UI — tooltips, info icons next to confusing fields, empty-state guidance with "what is this and how do I use it?" copy. No feature ships without it. We do NOT maintain a separate HTML help doc; it would rot.
2. **Developer docs live in `docs/`.** Architectural decisions, specs, runbooks, and conventions go in markdown files under `docs/`. Naming: `docs/<topic>.md`. Existing: `funding_source_spec.md`, `tech_debt.md`. Create on first need: `architecture.md`, `runbook.md`, `deployment.md`.
3. **Same-PR documentation discipline.** When a PR introduces tech debt, the same PR updates `docs/tech_debt.md`. When a PR changes a convention, the same PR updates `CLAUDE.md`. When a PR introduces a new operational procedure (migration application, deployment, rollback), the same PR adds it to `docs/runbook.md`. Documentation lag is a bug, not a follow-up.
4. **`CLAUDE.md` is the source of truth for project conventions.** Anything that future-Claude-Code or future-Seth needs to know to make consistent decisions lives here.
5. **Migration runbook entries.** Every migration that requires manual application (which is all of them, for now) gets a `docs/runbook.md` entry describing what it does, dependencies on prior migrations, expected verification output, and rollback steps.