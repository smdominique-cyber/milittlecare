# MILittleCare: License-Status Prompt Spec

**Status:** Approved 2026-05-15 — ready for implementation. Decisions recorded in § 9.
**Goal:** Capture whether a provider is **license-exempt** or **licensed** at
the moment it first matters, so the MiRegistry tracker (and future
licensed-provider tooling) can activate for the right people.

This is **not a new feature** — it introduces no new concepts. It is a
single UI moment that writes a value into an existing column. Kept
deliberately short.

---

## 1. Context

PR #4 shipped the MiRegistry deadline tracker. Its module activates
(`src/lib/modules.js`) when:

```js
profile.miregistry_id || profile.is_license_exempt === true
```

`profiles.is_license_exempt` is a nullable boolean (migration
`004_provider_program_settings.sql`) with **no default — it is `null` until
something sets it.** Nothing in the app ever sets it. There is no screen, no
onboarding step, no field that asks the provider "are you license-exempt?"

Consequence: a license-exempt provider can sign up, add CDC Scholarship
funding sources for their kids, and **never discover the MiRegistry tracker
exists** — because the one flag that would activate it stays `null`. The
December 16 Annual Ongoing Training countdown, the overdue banner on the
Funding tab, the whole tracker — all invisible.

The regulatory stakes are real: missing the December 16 deadline **closes
the provider's CDC account**. They must reapply with MDHHS before they can
bill again (see `miregistry_tracker_spec.md` § 1). The tracker exists
specifically to prevent that — and right now it is undiscoverable by the
audience it was built for.

Confirmed in production on 2026-05-15: **all three** `profiles` rows have
`is_license_exempt = null`. The tracker is dormant for every live user.

The activation rule itself is correct — license status is a provider-level
attribute, not a per-child one. The gap is purely that **no UI surface
captures the value.** This spec closes that gap.

---

## 2. Data Model

**No schema changes.** `profiles.is_license_exempt` already exists:

- Type `boolean`, nullable, no default — added by
  `004_provider_program_settings.sql` (line 33). Confirmed against the
  production `profiles` column list on 2026-05-15.

Three meaningful states:

| Value | Meaning |
| --- | --- |
| `true` | License-exempt provider |
| `false` | Licensed provider |
| `null` | Unanswered — the current state of every provider |

This PR is **UI + state management only**: a modal that writes the field, a
settings affordance that edits it, and the fire/re-prompt logic. No
migration, no new table, no new column.

---

## 3. UI/UX — the prompt modal

### Fire condition

The modal fires when **all** of the following hold:

1. The provider has just created a **CDC Scholarship** funding source
   (`type === 'cdc_scholarship'`), and
2. `profile.is_license_exempt IS NULL`, and
3. `profile.role === 'licensee'` (see § 7 — staff never see this).

### Hook point

`src/components/funding/FundingSourceForm.jsx` is where a CDC funding source
is created (`.insert` into `funding_sources`, followed by an `onSaved`
callback). The modal is triggered from the **post-save success path**, after
the insert resolves, when the saved source's type is `cdc_scholarship`. The
form already fetches `is_license_exempt` (for the CDC 2016-hour cap rule),
so the value is on hand — no extra round-trip to decide whether to fire.

The fire-condition test itself lives in a **shared helper** —
`shouldFireLicenseStatusPrompt({ profile, savedSource })` in
`src/lib/licenseStatusPrompt.js` — so any future CDC-source-creation path
(bulk import, etc.) can reuse it without duplicating the logic (§ 9
decision 2).

### What it asks

One question, two real options plus an escape hatch. Per § 9 decision 3,
each radio label leads with plain language; the technical term is a
parenthetical confirmation:

- **"I care for children I'm related to or already know, registered with
  MDHHS"** *(license-exempt provider)* — radio, with helper text below.
- **"I hold a Michigan child care license from LARA"** *(licensed provider —
  Family or Group Child Care Home)* — radio, with helper text below.
- **"I'm not sure — ask me later"** — a secondary text link, not a radio.

### Behavior

- Choosing an option and confirming writes `is_license_exempt = true`
  (license-exempt) or `false` (licensed). On `true`, the MiRegistry module
  activates on the next module recompute — the provider sees the tracker
  appear in the Compliance sidebar section.
- "I'm not sure — ask me later" leaves `is_license_exempt` as `null`, closes
  the modal, and the provider will be asked again on their next CDC source
  creation (§ 4).
- **The modal cannot be silently dismissed.** No X-to-close, no
  click-outside, no Esc that leaves the question unanswered. The only ways
  out are: pick an option, or click "ask me later." This is intentional —
  the modal is rare (once per provider, ideally) and the value is high.

### Layout (ASCII mock)

```
┌─ One quick question ───────────────────────────────────────────┐
│                                                                  │
│  You just added a CDC Scholarship funding source. To show you    │
│  the right tools — including Michigan training deadlines that    │
│  affect your CDC payments — tell us how your child care works.   │
│                                                                  │
│  ( ) I care for children I'm related to or already know,         │
│      registered with MDHHS   (license-exempt provider)           │
│      Not licensed by the State of Michigan. This is the          │
│      most common setup for in-home CDC providers.                │
│                                                                  │
│  ( ) I hold a Michigan child care license from LARA              │
│      (licensed provider — Family or Group Child Care Home)       │
│      Most centers and some larger home programs are licensed.    │
│                                                                  │
│              [ Save ]      I'm not sure — ask me later           │
└──────────────────────────────────────────────────────────────────┘
```

`[ Save ]` is disabled until a radio is selected. The helper text shown
here is the final copy from § 6.

---

## 4. Re-prompt Logic

The fire check is simply `is_license_exempt IS NULL`, re-evaluated at each
CDC-source-creation event. No counter, no "dismissed" flag — `null` is the
entire state.

| Situation | Re-prompt? |
| --- | --- |
| `is_license_exempt` null, provider creates **another** CDC Scholarship source | **Yes** |
| `is_license_exempt` null, provider **opens an existing** CDC source's detail/edit modal | **No** — too intrusive |
| `is_license_exempt` is `true` or `false` | **Never** (auto) — only the § 5 settings control changes it |

The "opens existing source" exclusion matters: the modal is tied to the
*creation* event, not to merely viewing CDC data.

---

## 5. Where the Provider Can Change It Later

**Finding:** there is currently **no general provider/account settings
surface that edits `profiles` fields.** `MiRegistryPage` edits
`profiles.miregistry_id`, but it is module-gated — a provider who answered
"licensed" (with no `miregistry_id`) would not see `MiRegistryPage` at all,
so it cannot host the toggle (they could never get back to it).

**Recommendation:** add the edit affordance to **`BusinessInfoPage`**
(`/business-info`) — the always-visible, licensee-only de-facto settings
page. It currently writes only to `business_*` tables, not `profiles`, so
this introduces the first `profiles` write on that page — a minor new
pattern, **not a new page**.

Minimal addition: a single labeled control that shows the current answer
and lets the provider switch it, **folded into an existing `BusinessInfoPage`
tab** (§ 9 decision 1) — not a new tab. The exact tab is chosen with Seth
before implementation, after reviewing the current tab structure together.

Changing the value here re-runs module activation — see § 7 for
consequences.

---

## 6. Copy Review

Draft copy below — same review-before-implement cadence as
`TrainingEntryForm`. Mark up before implementation.

- **Modal heading:** "One quick question about your child care setup"
- **Body:** "You just added a CDC Scholarship funding source. To show you
  the right tools — including Michigan training deadlines that affect your
  CDC payments — we need to know how your child care operates."
- **Option A label:** "I care for children I'm related to or already know,
  registered with MDHHS" — followed by the parenthetical *(license-exempt
  provider)*.
  - helper: "Not licensed by the State of Michigan. This is the most common
    setup for in-home CDC providers."
- **Option B label:** "I hold a Michigan child care license from LARA" —
  followed by the parenthetical *(licensed provider — Family or Group Child
  Care Home)*.
  - helper: "Most centers and some larger home programs are licensed."
- **Escape CTA:** "I'm not sure — ask me later"
- **Save confirmation (license-exempt):** "Got it. We've turned on your
  MiRegistry training tracker — find it under Compliance in the sidebar."
- **Save confirmation (licensed):** "Got it — thanks. That helps us show
  you the right tools."
- **Settings control label (§ 5):** "Provider type" with the same two
  options and a one-line "Why we ask" helper.

---

## 7. Edge Cases

**Provider answers, then realizes it was wrong.** They flip it via the § 5
settings control. Changing `is_license_exempt` re-evaluates module
activation:

- `false → true`: MiRegistry module activates.
- `true → false`: MiRegistry module deactivates **only if no
  `miregistry_id` is set** — if a `miregistry_id` exists, the module stays
  active via the other activation branch.
- **Training entries are never deleted.** `miregistry_training_entries` rows
  are soft-delete-only and owned by the user; they persist and reappear if
  the module reactivates later. No data loss either way.

Both directions show a confirmation dialog that spells out the module
consequence (§ 9 decision 4):

- **License-exempt → licensed:** "Switching to licensed will hide the
  MiRegistry tracker. Your N logged trainings will be kept (not deleted) but
  they won't appear in the sidebar until you switch back or add a MiRegistry
  ID. Continue?"
- **Licensed → license-exempt:** "Switching to license-exempt will turn on
  the MiRegistry tracker. You'll see it in the Compliance section of the
  sidebar."

**Provider dismisses the modal, then archives the funding source.** The next
CDC source creation should still re-prompt — `is_license_exempt` is still
`null`, so the question is still unanswered. The fire logic keys on the
null flag, **not** on whether any CDC source exists, so this falls out
correctly with no special case. (Matches the stated lean.)

**Staff users must never see this modal.** A user invited through
`staff_invitations` gets their own `profiles` row with a non-`licensee`
`role`. License status is a licensee-level question. The fire condition
includes `role === 'licensee'` (via the existing `useRole` hook). Staff
generally shouldn't be creating CDC funding sources anyway, but the role
gate makes the modal correct regardless of who reaches the form.

**Provider repeatedly picks "ask me later."** Acceptable — `null` is a
valid resting state; the app simply keeps the MiRegistry module off and
re-asks on the next CDC source creation. A gentle nudge for the provider
who never answers is deferred to V2 — see § 9 decision 5.

---

## 8. Phasing

### V1 — this PR

- A shared fire-condition helper — `shouldFireLicenseStatusPrompt({ profile,
  savedSource })` in `src/lib/licenseStatusPrompt.js`, unit-tested with
  Vitest — so any CDC-source-creation path can reuse it (§ 9 decision 2).
- The prompt modal on first (and re-prompted) CDC Scholarship source
  creation, per § 3–4.
- The `BusinessInfoPage` edit affordance, per § 5 — folded into an existing
  tab, placement chosen with Seth before implementation (§ 9 decision 1).
- Module activation continues to read `is_license_exempt` exactly as today.
  **No change to `src/lib/modules.js`.**

### V2 — future, separate PR

- When a provider picks **"licensed,"** that `is_license_exempt = false`
  value becomes the trigger to activate a **licensed-provider
  continuing-education tracking** module (LARA rules — different from
  MiRegistry). That module does not exist yet; see
  `docs/tech_debt.md` § "Staff training tracking for licensed providers is
  unmodeled" and `miregistry_tracker_spec.md` § 3.4 (Model B). This PR just
  makes sure the value is captured so the future module has its trigger.

---

## 9. Decisions Recorded

Resolved in spec review on 2026-05-15:

1. **Settings affordance placement.** Fold the license-status control into
   an **existing `BusinessInfoPage` tab** — not a new tab. The natural
   placement is picked with Seth before implementation, by reviewing the
   current `BusinessInfoPage` tab structure together — not chosen blind.

2. **Shared fire-condition helper.** V1 hooks only the `FundingSourceForm`
   save path, but the fire-condition logic is extracted into a shared
   helper — `shouldFireLicenseStatusPrompt({ profile, savedSource })` in
   `src/lib/licenseStatusPrompt.js` — so future CDC-source-creation paths
   (bulk import, etc.) reuse it without duplicating logic. Small refactor
   taken now.

3. **Option labels lead with plain language.** Keep the term
   "license-exempt," but each radio label leads with the plain-language
   description and carries the technical term as a parenthetical
   confirmation. Final labels: "I care for children I'm related to or
   already know, registered with MDHHS" *(license-exempt provider)* / "I
   hold a Michigan child care license from LARA" *(licensed provider —
   Family or Group Child Care Home)*. Helper text below each option is
   unchanged from the § 6 draft.

4. **Switch-confirmation copy spells out the module consequence.** Both
   directions show a confirmation dialog — final wording in § 7.
   License-exempt → licensed names the N kept-but-hidden training entries;
   licensed → license-exempt names the tracker turning on.

5. **Permanent-`null` risk deferred to V2.** No dashboard nudge in V1. If
   real usage shows providers parking in `null` via "ask me later," add a
   one-time gentle dashboard banner then. Captured in `docs/tech_debt.md`
   § "License status indefinitely null."

6. **Stay silent about future licensed-provider tooling.** The "licensed"
   confirmation copy is "Got it — thanks. That helps us show you the right
   tools." — it does not promise unbuilt features.

7. **Role gate.** The modal fires only for `profile.role === 'licensee'`,
   via the existing `useRole` hook. **Before implementation:** read the
   `useRole` hook, confirm `'licensee'` is the exact role string, and list
   the full set of `profiles.role` values used across the codebase so the
   strict-equality gate provably excludes staff. If anything varies from
   `'licensee'`, surface it rather than locking it in blind.
