# PR #19 — Drills + Emergency Response Plan (Rule 39): Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** This document is the spec for a follow-on implementation pass.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` § OQ2 + Updated
PR sequence): **structured emergency plan fields, not uploaded PDF.**
All 10 emergency types × the 9 plan dimensions are modeled as structured
data. Tradeoffs accepted: longer build (rated L), better data quality
and inspectability, enables future template pre-population, printable
plan generation, completeness validation.

**Cross-PR constraint D (specific structured fields):** the prompt
enumerates required fields: assembly point, alternate shelter location,
parent contact protocol, lockdown plan, fire route, tornado shelter
location. This scope doc incorporates those AND expands them per the
rule text (the audit captured 9 plan dimensions × 10 emergency types,
which I will reconcile with the prompt's 6 specifically-named fields).

**Rule citation:** **R 400.1939 (Rule 39) — Emergency preparedness and
response planning.** Requires:
- A written **emergency response plan** covering 10 emergency types: fire,
  tornado, accident, water (if applicable), flood, power outage, weather,
  disaster, bomb / man-made event, intruder / active shooter.
- Plan elements: evacuation, relocation, shelter-in-place, lockdown,
  family reunification, continuity of operations, infant / toddler
  accommodation, disability accommodation, chronic medical condition
  accommodation.
- A drill schedule and log:
  - Fire drills: every 3 months (4 per year).
  - Tornado drills: 2× annually between March and November.
  - Other drills (lockdown, shelter-in-place, etc.): at least annually.
- The drill log must record date, time, evacuation duration.
- Drill log retained 2 years.

---

## 0. Headline findings (drive the whole plan)

1. **No emergency-plan or drill schema exists anywhere.** Confirmed in
   the audit via repo-wide grep — zero hits in `src/`, `api/`, or
   `supabase/migrations/` for drill / evacuation / tornado / shelter /
   lockdown / reunification terms outside this prompt + docs. Greenfield.

2. **Rated L by the decisions doc.** Structured plan is the design;
   PR ships the full structured form, the drill log with schedule
   engine, the auditor-ready printable plan, and the reminder integration.
   The biggest LOC is the structured plan form (10 × 9 = 90 cells,
   though many cells share a single text input).

3. **Schedule engine generalizes nicely.** Three cadence patterns:
   - **Recurring fixed-interval** (fire: every 3 months from
     `last_completed_on`).
   - **Seasonal window** (tornado: 2 drills between March and November).
   - **Annual** (lockdown, shelter, others).
   These are three pure functions returning the next due date, given
   today + history. Lives in `src/lib/drillSchedule.js`. The PR #15
   scheduler shim calls these.

4. **Required-fields validation is the structured-plan equivalent of
   PR #17's clause linter.** A pure helper
   `getEmergencyPlanCompleteness(plan)` returns the missing
   `{emergencyType, planElement}` cells. The UI shows a
   "Emergency Plan Completeness: 76% (22/29 required)" badge — not
   blocking, just visible.

5. **Required vs optional cells.** Not every (emergency × element) cell
   is required. Rule 39 implies some combinations don't apply (e.g.
   "infant/toddler accommodation in lockdown" is meaningful; "infant/
   toddler accommodation in fire drill" arguably less so). PR #19 ships
   a required-vs-optional grid (matrix in
   `src/lib/emergencyPlan.js#REQUIRED_CELLS`) curated to match the rule
   text and Michigan-precedent training materials. Flagged for owner
   review.

---

## Step 2 — Inventory of what exists

**Nothing in code.** Greenfield per the audit. What exists that this PR
*touches:*

- `MODULE_KEYS.LICENSED_COMPLIANCE` (PR #14) — the gate.
- PR #15's reminder system — schedules per-drill due dates.
- `archived_at` soft-delete convention (PR #13) — applies to drill log
  entries (2-year retention).
- The sidebar's Compliance section (post-PR-14) — where the new nav
  entry lives.

---

## Step 3 — Implementation plan

### A. Migration design

**Migration 027** (post-PR-18's 026).

Two new tables: `emergency_plans` (one row per licensee) and `drill_logs`
(one row per drill performed).

#### A.1 `emergency_plans`

One row per `licensee_id`. The 10 × 9 structure is stored as a JSONB
blob (`plan_jsonb`) rather than 90 columns — pragmatic and matches the
`onboarding_state` precedent (migration 011).

```sql
create table public.emergency_plans (
  id              uuid primary key default gen_random_uuid(),
  licensee_id     uuid not null references auth.users(id) on delete cascade
                    unique,

  -- The 10 × 9 structured plan, plus the prompt-mandated specific fields.
  -- Shape:
  --   {
  --     "version": 1,
  --     "general": {
  --       "assembly_point": "...",
  --       "alternate_shelter_location": "...",
  --       "parent_contact_protocol": "...",
  --       "tornado_shelter_location": "...",
  --       "fire_route": "..."
  --     },
  --     "by_emergency": {
  --       "fire": { "evacuation": "...", "lockdown": "...", … 9 elements },
  --       "tornado": { … },
  --       "accident": { … },
  --       "water": { … },              // water elements set when applicable
  --       "water_applicable": true,    // separate boolean for "is water relevant?"
  --       "flood": { … },
  --       "power": { … },
  --       "weather": { … },
  --       "disaster": { … },
  --       "bomb_man_made": { … },
  --       "intruder_active_shooter": { … }
  --     }
  --   }
  plan_jsonb      jsonb not null default '{}'::jsonb,

  -- Completeness snapshot computed at save time for fast dashboard
  -- rendering. Derived from plan_jsonb + REQUIRED_CELLS catalog.
  completeness_percent integer not null default 0
    check (completeness_percent between 0 and 100),

  version         integer not null default 1,
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz,  -- soft delete (never expected; included for convention)
  created_at      timestamptz not null default now()
);
```

#### A.2 `drill_logs`

One row per drill performed. The 2-year retention runs from
`performed_at`.

```sql
create table public.drill_logs (
  id                       uuid primary key default gen_random_uuid(),
  licensee_id              uuid not null references auth.users(id) on delete cascade,
  drill_type               text not null check (drill_type in (
                             'fire', 'tornado', 'lockdown', 'shelter_in_place',
                             'reunification', 'other'
                           )),
  performed_at             timestamptz not null,
  duration_seconds         integer check (duration_seconds is null or duration_seconds > 0),
                                            -- per Rule 39: "evacuation duration"
                                            -- captured as seconds for accuracy.
  participating_children   integer,         -- a head count, not a per-child link
                                            -- (low-overhead audit signal).
  participating_staff      integer,
  notes                    text,
  conducted_by_user_id     uuid references auth.users(id) on delete set null,
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index idx_drill_logs_licensee_recent
  on public.drill_logs (licensee_id, performed_at desc)
  where archived_at is null;
```

**RLS:** standard provider-scoped (`licensee_id = auth.uid()`).

**No backfill.** Existing licensees start with empty plan + empty drill
log; the in-product editor / log handles the rest.

### B. App-code structure

#### B.1 Pure helpers (`src/lib/emergencyPlan.js`, new)

- `REQUIRED_CELLS` — a frozen matrix of `(emergencyType, planElement)`
  pairs that are required, with an `appliesIfWater` flag for water-only
  cells.
- `EMERGENCY_TYPE_LABELS` and `PLAN_ELEMENT_LABELS` — display strings.
- `getEmergencyPlanCompleteness(plan, providerContext)` →
  `{ percent, missingCells: [], requiredTotal, presentTotal }`.
- `validateEmergencyPlanCell(value)` → returns missing-content errors
  per cell (e.g. just whitespace doesn't count as filled).

#### B.2 Pure helpers (`src/lib/drillSchedule.js`, new)

- `nextFireDrillDue(lastPerformedOn, today)` → next ISO date.
- `nextTornadoDrillDue(historyOfYear, today)` → next ISO date inside the
  March–November window, or `null` if both required drills are already
  done.
- `nextAnnualDrillDue(type, lastPerformedOn, today)` → for lockdown,
  shelter, reunification, other.
- `getDrillScheduleSummary(history, today)` → returns per-type status:
  `{ type, lastPerformedOn, nextDueOn, severity }`.

#### B.3 Emergency plan editor (`src/pages/EmergencyPlanPage.jsx`, new)

- A guided form rendering the 10 × 9 matrix. Top section shows the
  prompt-mandated "general" fields (assembly point, alternate shelter,
  parent contact protocol, fire route, tornado shelter). Below: one
  collapsible card per emergency type, each containing the applicable
  plan-element textareas.
- "Save plan" persists to `emergency_plans.plan_jsonb`. Auto-saves draft
  on field blur with a debounce; an explicit "Save and publish" bumps
  `version`.
- Right-rail completeness badge ("Plan Completeness: 76%") with a
  "missing cells" drill-in.
- Printable view (`/emergency-plan/print`) — server-rendered or
  client-rendered HTML matched to letter-paper layout; the auditor-ready
  artifact.

#### B.4 Drill log surface (`src/pages/DrillLogPage.jsx`, new)

- Top: schedule status — one card per drill type with
  `last performed on / next due on / severity-tinted indicator`.
- Below: chronological drill log with `performed_at`, duration,
  participating counts, notes.
- "Record a drill" button opens a small form (type, datetime,
  duration_seconds, child/staff counts, notes).
- Filter by year + drill type. Archive retained but hidden by default
  (show-archived toggle, matching PR #13 pattern).

#### B.5 Reminder integration (PR #15)

Three new categories in `REMINDER_CATEGORIES`:
- `drill_fire` — `subject_type=null` (provider-level). Scheduler uses
  `nextFireDrillDue`.
- `drill_tornado` — provider-level. Scheduler uses
  `nextTornadoDrillDue`.
- `drill_other` — provider-level, one reminder per
  `{lockdown, shelter_in_place, reunification, other}` subtype using the
  annual cadence; encoded in subject_type or via subcategories. Flag for
  owner whether to keep these consolidated or split.

#### B.6 Dashboard widget

A "Compliance Today" small widget surfaces the next-due-drill alongside
the existing license-type-review and annual-training banners. Optional;
the reminder system already surfaces these via banners when due. The
widget exists in V1 as a permanent quick-view for the licensee.

### C. UI surfaces

- **Compliance → Emergency Plan** (sidebar nav, gated on
  LICENSED_COMPLIANCE). Long-form structured editor with completeness
  badge.
- **Compliance → Drills.** Schedule status + log + "record drill" form.
- **Print view.** Per-licensee static plan, suitable for posting in the
  home and for handing to an auditor.
- **Dashboard banner stack.** "Fire drill overdue / due in 7 days" etc.
  via PR #15.
- **Reminders settings.** Three new toggles (fire / tornado / other),
  each with configurable lead time.

### D. Module gating

Gate on `MODULE_KEYS.LICENSED_COMPLIANCE` (license_type IN family /
group). LEPs see nothing.

### E. Tests

- **Pure unit (`emergencyPlan.test.js`):** completeness math for an
  empty plan, partial plan, complete plan; water-not-applicable case.
- **Pure unit (`drillSchedule.test.js`):** all three schedule shapes
  with various history scenarios (recent-completed, never-completed,
  on-the-cusp-of-due).
- **Smoke (manual):** create a partial plan, complete required cells,
  watch completeness percent climb; record drills and observe schedule
  status transitions.
- RTL render tests deferred.

### F. Documentation

- `docs/runbook.md` — migration 027 entry template.
- `docs/tech_debt.md` — note the JSONB plan storage as a deliberate
  choice; if/when a column-per-cell schema becomes useful (e.g. per-cell
  audit trail), migrate later.
- `CLAUDE.md` — append: "Drill logs and emergency plans live in their
  own tables; drill log retention is 2 years per Rule 39 / R 400.1939
  and uses `archived_at` per house pattern."

### G. Rollout

1. Apply migration 027; verify tables + RLS via dashboard screenshot.
2. Deploy app; the licensee sees an empty plan + empty drill log.
3. **Communicate to Venessa:** "Compose your emergency plan in
   Compliance → Emergency Plan; record drills as you do them — fire
   every 3 months, tornado twice in season."

---

## Step 4 — Open questions

1. **The `REQUIRED_CELLS` matrix — who curates it and from what source?**
   Recommend curating from the rule text + Michigan training materials,
   committed as a frozen constant. **Flag for owner** to confirm the
   required-vs-optional matrix once drafted; the build is otherwise
   ready.

2. **JSONB vs 90 columns vs normalized child table?** Recommend **JSONB**
   for V1: a single row, single round-trip read, future evolution easy,
   matches `onboarding_state` precedent. A normalized
   `emergency_plan_cells` table is over-engineered. A column-per-cell is
   unwieldy. Flag for owner only if a column-per-cell audit trail
   becomes a requirement.

3. **"Other" drill type — keep as a single bucket or split?** The rule
   recognizes lockdown, shelter-in-place, reunification, and "others"
   (e.g. evacuation to alternate site). Recommend keeping the four
   common ones explicit and `'other'` as the catch-all with a free-text
   description.

4. **Should the structured plan support multi-language output for the
   print view?** Out of scope for V1. Michigan English-only.

5. **Drill log: per-child participation or head-count?** Per audit, the
   rule requires evidence the drill happened; per-child evidence is
   not mandated. Head-count is the lighter design. Flag for owner.

---

## Step 5 — Effort estimate

**L.** This is genuinely the largest of the six categories.
- Migration: two tables + JSONB shape (modest, but the schema is real).
- Plan editor: the biggest single-PR UI surface in the codebase (10
  collapsible cards × 9 textareas + general header fields + completeness
  + draft save + version bump + print view).
- Drill log: medium new page.
- Two new pure-helper modules + tests.
- PR #15 reminder integration: three new categories + schedulers.

---

## Step 6 — Out of scope (future PRs)

- **Per-child participation in drills** — head-count V1.
- **Multi-language plan output.**
- **Plan templates with state-specific pre-population** — V1 ships an
  empty form; a templated starter is a follow-up move.
- **PDF generation server-side** — V1 uses the browser's print dialog;
  a richer PDF export is a follow-up.
- **Plan attachment of photos / floor plans** — V1 is text; attachments
  could come later.
- **Cross-licensee plan sharing** — out of scope.

---

## Step 7 — Dependencies on prior PRs

- **PR #14 (license_type) — REQUIRED.** Surfaces gate on it.
- **PR #15 (reminders) — REQUIRED for due-date proactive notification.**
  Without it, the drill log surface alone shows schedule status (still
  visible).
- **PR #13 (archived_at convention) — pattern reference**, applies to
  drill logs.

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template),
`docs/pr-15-opt-in-reminder-system-scope.md` (sibling — provides the
reminder substrate).

*No source files modified. No migrations run. No branch other than
`docs/pr-15-21-scoping`.*
