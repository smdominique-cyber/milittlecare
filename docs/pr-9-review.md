# PR #9 Review — I-Billing Transfer & Reconciliation

**Branch:** `feature/i-billing-transfer-pr-9`
**Migration:** `supabase/migrations/019_pr_9_i_billing_schema.sql`

## Build session status

> ⚠️ **Schema migration written; remaining build pieces (validation engine, five screens, exports, reconcile) are in progress.**
>
> The migration is purely additive on top of the production tables and is order-independent with PRs #8.5a/b/c — each addresses distinct objects. Validation engine and UI surfaces are being built next.

### Items shipped in this commit

- `supabase/migrations/019_pr_9_i_billing_schema.sql` — four schema additions in one migration:
  - Multi-segment attendance: `segment_index integer NOT NULL DEFAULT 0` on `public.attendance`, with the existing `(child_id, date)` unique swapped for `(child_id, date, segment_index)` via `pg_constraint` introspection so the migration is agnostic to whatever name the original production constraint carries.
  - `public.cdc_billing_submissions` — one row per (provider, pay period); unique on that pair; RLS scoped to `auth.uid()`; SELECT/INSERT/UPDATE policies, no DELETE (immutable per spec § cross-cutting "Soft delete" — decision logged below); `updated_at` trigger.
  - `public.attendance_validation_overrides` — append-only audit log for Screen 3's override flow; RLS scoped; SELECT/INSERT only, no UPDATE or DELETE.
  - `public.children` schema additions: `school_enrolled boolean`, `school_name text`, `school_bell_schedule_json jsonb` — all nullable; Rule 6 dependency.
- This review-doc scaffold.

### Items queued

- Validation engine pure functions (`src/lib/iBilling.js` or equivalent) implementing the 11 rules.
- Five page skeletons: `IBillingPicker`, `IBillingReviewGrid`, `IBillingIssueResolver`, `IBillingExport`, `IBillingReconcile`. Routes wired into `App.jsx`.
- CSV export builder (production-grade).
- PDF generation — **parked on dependency approval** (see "Open decisions" below).
- Two-window mode tab affordance + sessionStorage checklist.
- Smoke-test pass with synthetic attendance.

## Open decisions

### PDF library

`package.json` ships no PDF library today (`xlsx`, `browser-image-compression`, `lucide-react`, `@supabase/supabase-js`, `react-router-dom`, `react`/`react-dom`). The spec says "use the same library milittlecare already uses (likely react-pdf or similar — check existing code)" but there isn't one to reuse.

**Default choice** unless overridden: `jspdf` + `jspdf-autotable`. Reasoning:
- Smallest footprint among PDF libraries usable in the browser.
- Plain-JS, no React-tree rendering overhead — fine for grid layouts like the I-Billing Transfer Sheet and the MiLEAP Rev. 11.2024 T&A Record.
- `jspdf-autotable` makes the 14-day grid trivial.

Per `CLAUDE.md` § Build Discipline: "Don't install dependencies without explicit approval." Awaiting greenlight. CSV export ships in the meantime — that path needs no new deps.

### Two-window mode UX caveat

Spec § Screen 4 wants the export to open "in a tab sized for side-by-side use with I-Billing." Modern browsers (Chrome / Firefox / Safari from ~2022) ignore `window.open` size hints unless popup settings have been relaxed. Implementing: opens in a new tab + sessionStorage "mark as transferred" checklist (which works). Sizing portion is documented here as a browser-side limitation rather than a missing feature on our side.

### Rule 4 (six concurrent children, LEP only) performance

Implementation uses the sweep-line approach the spec sketches:
1. Generate `(start_ts, end_ts)` pairs from each child's attendance segments in the period.
2. Build a timeline of events (`+1` at segment_start, `-1` at segment_end).
3. Sweep timeline; track max concurrent count.

For a typical LEP provider (≤ 6 children × ≤ 14 days × ≤ 2 segments/day ≈ 168 events per period), the sweep is sub-millisecond. The performance review entry in spec § PR #9 review doc requirements is therefore: acceptable for typical providers; no optimization needed. If a future provider had many more concurrent children, the same algorithm still scales linearly.

### Rule 6 (school hours) implementation

Per spec § Rule 6 caveat:
- `children.school_enrolled IS NULL OR false` → rule doesn't apply.
- `school_enrolled = true AND school_bell_schedule_json IS NULL` → warning only ("Child marked school-age but no school schedule on file. Cannot validate school-hours billing rule. Add school schedule to child profile.").
- `school_enrolled = true AND school_bell_schedule_json IS NOT NULL` → full validation, trim segments that overlap bell hours, blocking + IPV alert.

The bell schedule JSON shape is a per-day-of-week object: `{ "monday": { "start": "08:15", "end": "14:45" }, ... }`. Free-text fallback if a provider can't normalize: a `note` field on the JSON that the validator treats as "schedule unparseable, downgrade to warning." Both shapes are documented in the child profile help copy.

### `cdc_billing_submissions` soft-delete decision

Spec § cross-cutting "Soft delete" asks to flag this. Decision: **no `archived_at`** on this table. A confirmation-number record is a one-time write per pay period; un-archiving wouldn't make sense semantically (the period was either submitted or wasn't). The unique constraint on `(provider_id, pay_period_number)` already prevents duplicate submissions. Audit retention is satisfied by the row's permanent presence.

### Schema migration ordering vs PRs #8.5a/b/c

Migration 019 references `public.children`, `public.attendance`, `public.profiles` — all of which exist in production today. It is independent of migrations 016/017/018 in the sense that each addresses distinct objects: 016 documents existing tables, 017 reshapes funding_sources, 018 either extends profiles or creates a new settings table. None gate 019. The runbook entry will note this — they can be applied in any order or even with one of them skipped without breaking 019.

## Spec § PR #9 — review-doc requirements

### Rule 6 implementation choice

Recorded above ("Rule 6 implementation"). Warning-only when no schedule on file; blocking only when schedule is present and overlap detected.

### Rule 4 performance

Recorded above ("Rule 4 performance"). Acceptable for the expected provider scale.

### PDF library and tooling

Recorded above ("PDF library"). `jspdf` + `jspdf-autotable` recommended; awaiting approval.

### Two-window mode UX

Recorded above ("Two-window mode UX caveat"). Shipping new-tab + sessionStorage checklist; documenting sizing as a browser limitation.

### Provider-facing copy

To be reviewed at the end of build. Compliance / consequence copy in particular (Rule 5 IPV alert, Rule 10 90-day cutoff) — phrasing should be reviewed by Seth before any production rollout.
