# MILittleCare: Onboarding Wizard Spec

**Status:** Approved for PR #7. Decisions recorded in § 9 (spec review
2026-05-17). Implementation in progress on `feature/onboarding-wizard`.
**Goal:** Capture a provider's 9 **structural-identity** fields once, at
first login, so every downstream feature activates the right modules and
shows the right tools without its own per-field discovery patch.

This spec mirrors the structure of `docs/miregistry_tracker_spec.md` and
`docs/cdc_pay_periods_spec.md`. It is deliberately tighter — the scope is
smaller and a chunk of the work is reusing fields and patterns that already
exist.

Strategic framing is in `docs/strategy.md` § "Onboarding as architecture
(not polish)". (That file currently lives at the mis-nested path
`docs/docs/strategy.md` — a pre-existing repo quirk, noted, out of scope
here.)

---

## 1. Context

### 1.1 The discoverability problem

MILittleCare's features turn themselves on and off based on what kind of
provider is using them — the module-activation principle in `CLAUDE.md`. A
private-pay-only provider never sees "CDC"; a license-exempt provider sees
the MiRegistry deadline tracker; a licensed provider does not.

That model only works if the system **knows** which kind of provider it is
serving. Today it mostly doesn't. The inputs `src/lib/modules.js` reads —
`is_license_exempt`, `miregistry_id`, `michigan_license_number`,
`program_settings.*` — are nullable and **nothing populates them at signup.**
Each one has, at best, its own ad-hoc discovery moment:

- **License status** — captured only by the PR #5 license-status prompt,
  which fires opportunistically when a provider happens to create a CDC
  funding source. Confirmed 2026-05-15: all three live `profiles` rows still
  have `is_license_exempt = null`.
- **MiRegistry ID** — captured only by the empty-state prompt *inside* the
  MiRegistry page, which a provider only reaches if the module is already
  active. Chicken-and-egg.
- **CDC / Tri-Share / GSRP participation** — inferred indirectly from the
  existence of `funding_sources` rows, or set via `program_settings`, which
  has no UI surface at all.
- **CACFP, kid count, typical care hours** — captured nowhere.

The result: a provider can sign up and use the product for weeks with the
system having no idea they are license-exempt, take CDC, or run a food
program — so the features built specifically for them stay invisible.

### 1.2 The structural-identity insight

There are **9 fields** that define what kind of provider this is. They
change rarely (most never, after setup) and they gate everything else:

| # | Field | Canonical home (today) | Applies to |
| --- | --- | --- | --- |
| 1 | License status (exempt vs licensed) | `profiles.is_license_exempt` | all |
| 2 | MiRegistry ID | `profiles.miregistry_id` | license-exempt |
| 3 | Michigan license number / provider ID | `profiles.michigan_license_number`, `michigan_provider_id` | licensed |
| 4 | CDC participation | `program_settings.cdc` | all |
| 5 | Tri-Share participation | `program_settings.tri_share` | all |
| 6 | GSRP participation | `program_settings.gsrp` | all |
| 7 | CACFP / food program participation | `program_settings.cacfp` (+ sponsor — no home yet) | all |
| 8 | Number of children currently enrolled (rough) | *no home yet* | all |
| 9 | Typical weekly care hours | *no home yet* | all |

### 1.3 Why onboarding is architecture, not polish

The PR #5 license-status prompt was the right call for the single most
urgent field, but it is a **workaround**: it patches one field's
discoverability by bolting a modal onto an unrelated event (CDC source
creation). Generalising that approach means 8 separate bolted-on prompts,
each firing on some unrelated trigger, each with its own re-prompt logic.
That is not a design — it is eight workarounds.

The structural fix is a **first-login onboarding wizard** that asks these
questions once, in plain language, writes the answers to their canonical
homes, and lets every current and future module read clean inputs. Per
`docs/strategy.md`, the wizard is also a customer-acquisition asset: a
competent first-run experience is what providers expect from professional
software.

This spec does **not** make onboarding a tutorial, a video, or a mandatory
wall. It is a skippable, conversational, one-question-per-screen capture of
the 8 fields, plus a persistent (not nagging) reminder to finish.

---

## 2. Data Model

### 2.1 Fields that already have a home

Seven of the nine write to columns that already exist (`profiles` from
migrations `001`/`004`, `program_settings` JSON from `004`). The wizard is a
**writer into existing columns**, not a new system of record:

| Wizard answer | Write target |
| --- | --- |
| License status | `profiles.is_license_exempt` (`true` / `false`) |
| MiRegistry ID | `profiles.miregistry_id` (text) |
| Michigan license # / provider ID | `profiles.michigan_license_number`, `michigan_provider_id` |
| CDC participation | `program_settings.cdc` (`'force_on'` / absent — see § 5) |
| Tri-Share participation | `program_settings.tri_share` (`'force_on'` / absent) |
| GSRP participation | `program_settings.gsrp` (`'force_on'` / absent) |
| CACFP participation | `program_settings.cacfp` (boolean) |

### 2.2 Fields with no home yet

Three pieces of data the wizard collects have nowhere to land today:

- **CACFP sponsor name** — when CACFP is "handled by a sponsor."
- **Number of children currently enrolled** — a rough figure for capacity
  context.
- **Typical weekly care hours** — a rough schedule shape.

These are **soft context**, not yet read by any feature. Per § 9
decision 11, for V1 they are stored inside the `program_settings` JSON
(or the new `onboarding_state` blob, § 2.3) rather than promoted to
first-class `profiles` columns. Promote to typed columns only when a real
feature needs to query/filter on them — premature columns invite the
out-of-band-schema problem in `docs/tech_debt.md`.

### 2.3 New: onboarding completion state

The wizard needs to know whether it has run, where the provider stopped,
and which questions were skipped. This spec uses **one new JSONB column**,
not a table.

```sql
-- migration 011_onboarding_state.sql  (011 assumes PR #6's 010 lands first;
-- otherwise the next free sequential number)
alter table public.profiles
  add column if not exists onboarding_state jsonb not null default '{}'::jsonb;
```

Shape of the blob (illustrative — not a contract; the wizard owns it):

```jsonc
{
  "version": 1,            // schema version, for future migrations of the blob
  "completed_at": null,    // ISO timestamp when the provider reached the end
  "dismissed_at": null,    // ISO timestamp of the last "finish later"
  "last_step": "cdc",      // resume point — the step key to land on
  "skipped": ["miregistry_id"],  // step keys the provider explicitly skipped
  "gate_answers": { "cdc": "yes", "tri_share": "never_heard" }
                           // raw CDC / Tri-Share / GSRP answers — see below
}
```

Why a JSONB blob and not columns or a table:

- It is **wizard bookkeeping**, never queried by other features — exactly
  the shape JSON is for. `program_settings` set the precedent.
- A `default '{}'` means every existing provider (Venessa + 2 others) is
  automatically "not yet onboarded" and gets the wizard on next login — a
  desirable backfill of structural identity, with no data migration.
- A table would be over-modelled for one row per provider.

The **answers themselves never live only in the blob** — they write through
to their canonical columns (§ 2.1) the moment they are confirmed, so a
half-finished wizard still yields partial, correct module activation.

One deliberate exception, `gate_answers`: the three participation gates
(CDC, Tri-Share, GSRP) also record their **raw answer** in
`onboarding_state.gate_answers`. A gate "no" leaves the canonical
`program_settings` key *absent* (§ 5.2) — the correct module-activation
signal — but absent is indistinguishable from "never asked". `gate_answers`
is the wizard's own bookkeeping so it can repaint those screens on resume
and Back-navigation (§ 3.4); it also keeps Tri-Share's "never heard of it"
distinct from a plain "no" (§ 9 decision 9). `modules.js` never reads it —
it remains wizard-only state, consistent with the blob's purpose.

`profiles.onboarding_state` is RLS-covered by the existing `profiles`
policies (a provider reads/writes only their own row) — no new policy.

---

## 3. UI / UX

### 3.1 Shape of the wizard

- **One question per screen.** No form wall. Each screen: a plain-language
  question, 2–4 answer options (or a short input), a one-line "why we're
  asking", and Back / (Skip) / Continue.
- **Conversational copy.** "Do you take payment from a state child care
  program?" — not "Do you participate in CDC?". The program name appears
  *after* the plain-language framing, as confirmation.
- **Progress is visible** ("Question 3 of 8") but de-emphasised — this is a
  conversation, not a progress bar to grind.
- **Conditional flow** (§ 9 decision 8): the license-status answer
  branches the next question — license-exempt → MiRegistry ID; licensed
  → Michigan license / provider ID. CDC / Tri-Share / CACFP / capacity
  questions are common.
- **Every screen is skippable** (§ 9 decision 6): "Skip this question"
  advances without writing; "Finish later" exits the whole wizard.
  Nothing is mandatory.

### 3.2 Question screen (ASCII mock)

```
┌──────────────────────────────────────────────────────────────────┐
│  Setting up MILittleCare                       Question 1 of 8    │
│                                                                    │
│  First — how does your child care operate?                        │
│                                                                    │
│  ( ) I care for children I'm related to or already know,           │
│      registered with MDHHS                                         │
│      The most common setup for in-home providers. Not licensed     │
│      by the State of Michigan. (license-exempt)                    │
│                                                                    │
│  ( ) I hold a Michigan child care license from LARA                │
│      Family or Group Child Care Home. (licensed)                   │
│                                                                    │
│  Why we ask: this decides which training and compliance tools      │
│  we turn on for you — they're different for each.                  │
│                                                                    │
│  [ Skip this question ]                       [ Back ] [ Continue ]│
│                                                                    │
│  ──────────────────────────────────────────────────────────────   │
│  Finish later — you can pick this up from your dashboard anytime.  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 Final screen + persistent reminder

The last screen summarises what was turned on ("Based on your answers, we've
set up: CDC tools, the MiRegistry training tracker") and links to the
dashboard. It sets `onboarding_state.completed_at`.

If the provider exits early ("Finish later"), `dismissed_at` is stamped and
the **dashboard shows a persistent card** until `completed_at` is set:

```
┌─ Finish setting up MILittleCare ─────────────────────────────────┐
│  You're 3 of 8 questions in. Finishing lets us turn on the right  │
│  tools for your program.                          [ Finish setup ]│
└────────────────────────────────────────────────────────────────────┘
```

- The card is **persistent, not modal** — it sits on the dashboard, never
  blocks. It disappears only when the wizard is completed (§ 9 decision 7).
- "Finish setup" reopens the wizard at `onboarding_state.last_step`.
- Separately, a lighter set of dashboard **next-step prompts** keys off
  *missing answers* ("Add your MiRegistry ID to track your December 16
  deadline") — distinct from the wizard-completion card (§ 9 decision 7).
  V1 may ship just one generic next-step prompt; the richer per-field
  set is a small follow-on.

### 3.4 Skip / resume behaviour

- Answers persist per-screen as they are confirmed (§ 9 decision 2) —
  leaving and returning never loses entered data.
- Re-entry lands on `last_step`. The provider can use Back to revisit and
  change any earlier answer; changing an answer re-writes its canonical
  column and re-runs module activation (§ 5).
- A skipped question is recorded in `skipped[]` and simply not asked again
  on resume; it can still be answered later via the relevant settings
  surface (the BusinessInfoPage "Licensing" tab from PR #5, etc.).

### 3.5 Inline help

Per `CLAUDE.md` § Documentation Conventions rule 1, every screen carries its
own "why we ask" line (shown in the mock). No separate help doc. Copy is
reviewed in a later cadence — this spec stops at the design-decision level.

---

## 4. Trigger Conditions

### 4.1 When the wizard fires

The wizard auto-opens when **all** hold:

1. The user is authenticated and **past the paywall gate** (§ 9 decision
   12). The `/onboarding` route is mounted **inside `PaywallGate` but
   outside `DashboardLayout`** — a full-screen flow with no sidebar
   chrome, so a provider mid-wizard never sees navigation for modules
   they have not yet decided to activate. The original spec did not pin
   this; it is settled here.
2. `useRole().isLicensee` is true — licensee only (§ 9 decision 4).
3. `profiles.onboarding_state.completed_at` is null.
4. `onboarding_state.dismissed_at` is null **for this session** — once a
   provider clicks "Finish later", the wizard does not auto-reopen for the
   rest of that session; it auto-opens again on the next fresh login until
   completed (§ 9 decision 7: auto-reopen once per fresh login session,
   no more).

When (3) holds but the wizard is not auto-showing (dismissed this session),
the § 3.3 dashboard card is the standing entry point.

### 4.2 What "completed" means

`completed_at` is set when the provider **reaches the final screen** — every
question either answered or explicitly skipped. "Completed" therefore means
*the wizard ran to the end*, **not** *every field is populated*. A provider
who skips three questions still completes the wizard; the dashboard
completion card clears; the lighter next-step prompts (§ 3.3) pick up the
still-missing fields. Keeping these two notions separate is deliberate — see
§ 9 decision 7.

### 4.3 Existing providers

`onboarding_state` defaults to `'{}'` (no `completed_at`), so the three live
providers and anyone who signed up before PR #7 are treated as not-yet-
onboarded and get the wizard on next login. This is intended: it backfills
their structural identity. Because the wizard is skippable, it is not
disruptive.

### 4.4 When the wizard does NOT fire

- Staff / non-licensee roles — never (§ 9 decisions 4 and 5).
- Parent-portal users — never (separate auth surface entirely).
- A provider who completed it — never again automatically. It remains
  reachable for re-review only if a settings entry point is added — a V2
  item per § 7.2, not required here.
- It does **not** re-fire because a structural field was later cleared
  (e.g. `is_license_exempt` reset to null) — see § 9 decision 3.

---

## 5. Module Activation

### 5.1 The wizard feeds `modules.js`; it does not change it

`getActiveModules()` already computes the active module set from `profile`
and `funding_sources`. The wizard's job is purely to **populate the inputs**
that function reads. **No change to `src/lib/modules.js` logic is required**
by this PR — a notable contrast with PR #4, which had to add an activation
branch.

Mapping from wizard answers to activation inputs:

| Wizard answer | Effect on `getActiveModules` inputs |
| --- | --- |
| License-exempt = true | `is_license_exempt = true` → activates `miregistry_tracker` + `license_exempt_compliance` |
| Licensed = true | `is_license_exempt = false`; `michigan_license_number` set → activates `licensed_compliance` |
| MiRegistry ID entered | `miregistry_id` set → reinforces `miregistry_tracker` |
| CDC = yes | `program_settings.cdc = 'force_on'` → activates `cdc` |
| Tri-Share = yes | `program_settings.tri_share = 'force_on'` → activates `tri_share` |
| GSRP = yes | `program_settings.gsrp = 'force_on'` → activates `gsrp` |
| CACFP = yes | `program_settings.cacfp = true` → activates `cacfp` |

### 5.2 `force_on` vs `auto` (§ 9 decision 13)

`program_settings.{cdc,tri_share,gsrp}` accept `'auto' | 'force_on' |
'force_off'`. A brand-new provider says "yes, I take CDC" in the wizard
*before* they have created any `cdc_scholarship` funding source — so under
`'auto'`, the CDC module would still be off and they could not find the CDC
tooling needed to add that first source.

Per § 9 decision 13, a wizard **"yes"** sets `'force_on'` (module on now,
so the provider can reach the feature); a wizard **"no"** leaves the key
**absent** (i.e. `'auto'`), **never** `'force_off'`. `'force_off'` would
suppress the module even after the provider later adds a real funding
source of that type — wrong. `'auto'` lets reality (an actual funding
source) still turn the module on.

### 5.3 Relationship to per-feature activation

The existing funding-source-driven activation (a `cdc_scholarship` source
turns on `cdc`) **stays** — it is the source of truth once real data
exists. The wizard's `force_on` is an **early on-ramp** for the gap between
"provider says they do CDC" and "provider has entered a funding source". The
two coexist without conflict: both only ever *add* to the module set for a
declared-yes provider.

---

## 6. Subsuming the License-Status Prompt (PR #5)

PR #5 ships a modal that fires on CDC funding-source creation when
`is_license_exempt IS NULL`, plus a "Licensing" tab on `BusinessInfoPage`
for editing the value later. The onboarding wizard captures the **same
field, earlier and in context**.

### 6.1 V1 — coexist, do not delete

Per § 9 decision 10, in PR #7's V1 the wizard and the PR #5 modal
**coexist**. They do not conflict — both gate on `is_license_exempt IS
NULL`:

- A provider who **completes** the wizard answers the license-status
  question there; `is_license_exempt` is no longer null; the PR #5 modal
  never fires. The wizard has effectively subsumed it.
- A provider who **skips** that wizard question (or skips the whole wizard)
  still has `is_license_exempt = null`. The PR #5 modal remains the **safety
  net**, catching them at the next moment the field actually matters (CDC
  source creation). This is the correct fallback, not dead code.

So in V1 the wizard is the *primary* capture and the PR #5 modal degrades
gracefully into a *fallback for skippers*. Nothing about PR #5 needs to be
removed for PR #7 to ship.

### 6.2 The "Licensing" tab stays permanently

The PR #5 `BusinessInfoPage` "Licensing" tab is **not** a workaround — it is
the permanent settings home for license status (and the future home for
`miregistry_id` / `michigan_license_number` edit surfaces). The wizard is
first-capture; the tab is forever-edit. Both stay.

### 6.3 V2 — deprecation decision deferred

Whether to eventually retire the PR #5 *modal* depends on data: if telemetry
after the wizard ships shows the wizard reliably captures license status
(few providers reach CDC-source-creation still null), the modal can be
removed as redundant. If skip rates are high, it stays as cheap insurance
(~3 files, harmless). Per § 9 decision 10, the modal is **kept until
post-launch telemetry exists**; deprecation is revisited in a V2 review.

`docs/strategy.md` already directs that `funding_source_spec.md` and
`license_status_prompt_spec.md` be annotated to name the wizard as the
canonical capture point once built; PR #7 should make those one-line doc
edits in the same PR (per `CLAUDE.md` § Documentation Conventions rule 3).

---

## 7. Phasing

### 7.1 V1 — this PR (PR #7)

1. Migration `011_onboarding_state.sql` — adds `profiles.onboarding_state
   jsonb not null default '{}'`. Runbook entry per the Migration
   Application Procedure.
2. A pure helper module — `src/lib/onboarding.js` — for the derived logic:
   which step is next given current answers, whether the wizard is
   complete, which structural fields are still missing. Vitest-tested, the
   way `modules.js` / `cdcPayPeriods.js` are.
3. The wizard surface — a dedicated `/onboarding` route (§ 9 decision 1)
   with one component per question screen, conditional flow, skip/resume.
4. Write-through: each confirmed answer writes its canonical column (§ 2.1)
   and the wizard updates `onboarding_state`.
5. Dashboard persistent completion card + at least one generic next-step
   prompt (§ 3.3).
6. Trigger wiring: auto-open on login for not-yet-onboarded licensees
   (§ 4).
7. Inline help on every screen (§ 3.5).
8. Doc edits: this spec, the runbook entry, one-line annotations to
   `funding_source_spec.md` and `license_status_prompt_spec.md` (§ 6.3),
   and a `tech_debt.md` entry for anything deferred.

V1 does **not** change `src/lib/modules.js` and does **not** remove the
PR #5 modal (§ 6).

### 7.2 V2 — future PRs

- **Richer per-field dashboard next-step prompts** — one targeted nudge per
  still-missing structural field, rather than one generic card.
- **Promote soft-context fields to typed columns** — kid count, care hours,
  CACFP sponsor — once a capacity / scheduling / food-program feature
  actually consumes them (§ 2.2, § 9 decision 11).
- **License-status modal deprecation** — decided on telemetry (§ 6.3).
- **A staff "welcome" surface** — if invited staff turn out to need any
  first-run orientation, a minimal non-structural version (§ 9 decision 5).
- **Re-review entry point** — let a provider re-open the wizard from
  settings to revise structural identity in one place.

V1 explicitly is **not**: a feature tutorial, a video walkthrough, a
checklist of everything-to-do, or a mandatory wall.

---

## 8. State Modernization Survival

Assessed against `docs/strategy.md` § "State modernization hedge" and the
`cdc_pay_periods_spec.md` § 6 pattern.

### Durable — survives modernization

- **The captured structural identity itself.** License status, program
  participation, MiRegistry / license IDs, capacity — this is provider
  configuration for MILittleCare's own intelligence layer. A modernized
  I-Billing changes none of it; the wizard keeps feeding module activation,
  compliance scoring, and audit-packet scoping regardless of what the
  state's portal looks like.
- **The onboarding flow as a product asset.** A competent first-run
  experience is positioning, not workflow mimicry — entirely independent of
  state systems.

### Not state-mimicry at all

The wizard collects nothing the state's portal owns and replicates no state
workflow. It does not enroll anyone in CDC, submit anything to MDHHS, or
mirror a MiLogin/I-Billing screen. There is no surface here that a
modernized state portal could obsolete.

### Verdict

**100% of V1 is durable.** The wizard is intelligence-layer configuration
capture — the part of the product `docs/strategy.md` says to invest in. The
only forward caution is the usual one: if a *future* version drifted toward
"let us file your state paperwork for you," that part would be state-
mimicry. This spec's wizard does not.

---

## 9. Decisions Recorded (2026-05-17)

Resolved in spec review on 2026-05-17. All 14 questions raised in the
draft § 9 were resolved; the recommendations carried.

1. **Dedicated `/onboarding` route.** Approved. The wizard is a real route,
   not a modal overlay. A multi-screen flow benefits from a real URL —
   resumable, deep-linkable from the dashboard "Finish setup" card, browser
   Back/Forward works, and far easier to test than a modal nested inside
   `DashboardLayout`. The modal pattern (PR #5) fits a single question, not
   eight.

2. **Per-answer persistence.** Approved. Each answer is written through to
   its canonical column the moment it is confirmed, not staged for an
   all-or-nothing commit at the end. A half-finished wizard then still
   yields correct partial module activation, and resume is trivial. Staging
   would lose all value when a provider drops off — and for a skippable
   wizard, many will.

3. **No re-fire when a structural field is cleared.** Approved. Completion
   is tracked by `onboarding_state.completed_at`, independent of field
   values; nulling a structural field later (e.g. `is_license_exempt`) does
   not re-run the wizard. The PR #5 modal already catches that specific
   case, and field-level re-capture belongs to the relevant settings
   surface, not a full 8-question replay.

4. **Role gate — licensee only.** Approved. The wizard is gated on
   `useRole().isLicensee` (role derived from `staff_memberships`, not
   `profiles.role` — same finding as `license_status_prompt_spec.md`
   § 9.7). Structural identity is a business-level attribute; `adult_staff`
   / `assistant` / `view_only` never see the wizard.

5. **No staff wizard.** Approved. Invited staff get no onboarding wizard in
   V1; they enter through the `staff-invite` accept flow and do not
   configure business identity. A minimal non-structural "welcome" surface
   for staff remains a possible V2 item, out of scope here.

6. **Skip granularity — both global and per-question.** Approved. A global
   "Finish later" exits the wizard; a per-screen "Skip this question"
   advances without writing. Per-question skip is necessary because some
   questions genuinely do not apply yet — e.g. a brand-new license-exempt
   provider not yet registered with MiRegistry has no ID to enter.

7. **Completion clears on the final screen; auto-reopen once per session.**
   Approved. Reaching the final wizard screen (every question answered
   **or** explicitly skipped) sets `completed_at` and clears the dashboard
   completion card. "Wizard completed" and "profile fully populated" stay
   deliberately distinct states — the completion card tracks the former,
   the per-field next-step prompts (§ 3.3) track the latter. For a provider
   who repeatedly dismisses without completing, the wizard auto-reopens
   once per fresh login session, no more.

8. **Conditional branching on the license-status answer.** Approved.
   License-exempt → ask MiRegistry ID; licensed → ask Michigan license
   number / provider ID. The remaining questions (CDC, Tri-Share, CACFP,
   capacity, hours) are common to both paths, so no provider is asked about
   fields that cannot apply to them.

9. **Three Tri-Share options.** Approved. The wizard offers "yes / no /
   never heard of it". "Never heard of it" maps to the **same stored state
   as "no"** (`program_settings.tri_share` absent / `'auto'`), but the
   "never heard of it" choice itself is recorded in `onboarding_state` as a
   product-analytics signal and a future hook for a "what is Tri-Share?"
   explainer. The explainer is not built in V1.

10. **CACFP sponsor as free text; PR #5 modal kept until telemetry.**
    Approved. The CACFP sponsor name is captured as **free text** in
    `program_settings` (or `onboarding_state`) for V1 — there is no CACFP
    sponsor directory in the system and a structured FK is not justified
    yet. The PR #5 license-status modal is kept until post-launch telemetry
    shows the wizard reliably captures license status; deprecation is
    revisited in a V2 review (§ 6.3).

11. **Kid count and care hours as soft context, in coarse buckets.**
    Approved. These answers are stored in `program_settings` (or
    `onboarding_state`) as soft context for V1; no typed `profiles` columns
    are created until a capacity / scheduling feature consumes them
    (premature columns are the out-of-band-schema pattern `tech_debt.md`
    warns against). The answers use coarse buckets (e.g. "1–3, 4–6, 7–12,
    12+") so the data is honest about being approximate.

12. **Onboarding runs after the paywall gate.** Approved. The wizard lives
    inside the protected dashboard, behind `PaywallGate`. A provider locked
    out for non-payment does not need structural setup yet; a trialing or
    active provider does. This is the simplest placement and consistent
    with how trial/paywall timing interacts with "first login".

13. **Wizard "yes" sets `force_on`; "no" leaves the key absent.** Approved.
    A wizard "yes" sets `program_settings.<program> = 'force_on'`; a wizard
    "no" leaves the key absent (`'auto'`), never `'force_off'`. Per § 5.2,
    `force_on` gives the provider the on-ramp to the feature before any
    funding source exists, while `'auto'` for "no" preserves the ability of
    a real future funding source to turn the module on.

14. **GSRP is a wizard question.** Approved. A GSRP yes/no question is
    included for parity with CDC, Tri-Share, and CACFP — `program_settings.gsrp`
    exists and `modules.js` gates a GSRP module. The strategic framing named
    the other three but not GSRP; the review resolved the ambiguity in
    favour of inclusion.

---

## Appendix — fields, homes, and module effects (summary)

| Field | Wizard asks | Writes to | Activates |
| --- | --- | --- | --- |
| License status | screen 1 | `is_license_exempt` | `miregistry_tracker` / `license_exempt_compliance` or `licensed_compliance` |
| MiRegistry ID | screen 2a (exempt) | `miregistry_id` | `miregistry_tracker` |
| MI license / provider ID | screen 2b (licensed) | `michigan_license_number`, `michigan_provider_id` | `licensed_compliance` |
| CDC participation | screen 3 | `program_settings.cdc` | `cdc` |
| Tri-Share participation | screen 4 | `program_settings.tri_share` | `tri_share` |
| GSRP participation | screen 5 | `program_settings.gsrp` | `gsrp` |
| CACFP participation | screen 6 | `program_settings.cacfp` (+ sponsor text) | `cacfp` |
| Children enrolled (rough) | screen 7 | `program_settings` / `onboarding_state` | — (context only) |
| Typical care hours | screen 8 | `program_settings` / `onboarding_state` | — (context only) |

Nine question screens in the catalog; the license-status branch (screen 2a
vs 2b) means any one provider sees eight.
