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
- Real customer in production: Venessa is a live user with real data. Migrations must be reversible; backfills must be reviewed before applying to production data.

## Module Architecture

The app is moving toward a funding-source-driven module activation model where features turn on/off based on which programs a provider's children are funded by. See docs/funding_source_spec.md for the design. The first PR establishes this scaffolding. Subsequent PRs slot in as modules (CDC I-Billing reconciliation, Tri-Share split billing, MDHHS-4025 vault, MiRegistry deadline tracker) without touching each other.

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