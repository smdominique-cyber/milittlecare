# PR #8.5c Review — Provider CDC Billing Settings

**Branch:** `feature/provider-cdc-billing-settings-pr-8-5c`
**Migration:** `supabase/migrations/018_provider_cdc_billing_settings.sql`

## Build session status

Migration written from Seth's discovery handoff (2026-05-20). **`profiles` has 28 columns**, under the threshold; the migration extends `profiles` rather than creating a `provider_cdc_settings` sibling table.

Three originally-proposed columns from the PR #8.5c addendum are dropped — they overlap with columns that already exist:

| Proposed | Existing column | Resolution |
|---|---|---|
| `annual_ongoing_training_completed_date` | `annual_training_completion_date` (migration 004) | Reuse. The column was originally marked deprecated by PR #4 for the *license-exempt CDC LEPPT* use case; PR #8.5c re-purposes it for the *LEP annual ongoing training* tracker — same Dec 16 deadline mechanic, different programmatic concept. The helper `getAnnualTrainingDeadlineState(completedDate, today)` is parameter-named generically; callers pass `profile.annual_training_completion_date`. The deprecation note in `miregistry_tracker_spec.md` § 2.3 / `tech_debt.md` § Planned deprecations should be updated to reflect this un-deprecation. |
| `rate_tier` (on profile) | `miregistry_current_level` (migration 009) — `'level_1'` / `'level_2'` | Reuse for provider-level rate tier reads. PR #8.5b's `rate_tier_at_issue` on `funding_sources` is still separately captured — that's a **snapshot at authorization issue time**, distinct from the provider's *current* tier. Both legitimately exist. |
| (new column `michigan_provider_id`) | `michigan_provider_id` exists today | The original spec phrasing confused the LEP "Bridges Provider ID" with the licensed-provider ID. Both legitimately exist; `bridges_provider_id` is the new LEP column added here. |

Net new columns added to `profiles` in this migration: **10** (4 CDC billing + 6 PR #12 ack-settings folded in per discovery doc recommendation). PR #12's migration 020 no longer touches `profiles`; the 6 columns it previously added there move here.

### Items unblocked and written in this commit

- `src/lib/cdcProviderCompliance.js` — two pure compliance-countdown helpers:
  - `getAnnualTrainingDeadlineState(completedDate, today)` — spec § Step 5. Severity ladder mirrors the pseudocode (`info` > 45 → `warning` 16–30 → `urgent` 7–15 → `critical` 0–6 → `expired` past Dec 16). Documents the spec's "reset on Jan 1" behaviour in the JSDoc — a richer "you missed last year" state would need MDHHS-side integration.
  - `getFingerprintReprintState(fingerprintDate, providerType, today)` — spec § Step 6. Gated to `lep_unrelated` providers; reminder at >4.5 years, urgent at >5 years. Returns null for fresh fingerprints, providers of any other type, or missing data.
- `src/lib/cdcProviderCompliance.test.js` — 29 deterministic Vitest cases covering boundary days on both ladders, the provider-type gate, the completed-this-year short-circuit, year-rollover behaviour, and the singular/plural label form on the 1-day-remaining critical case.
- Constants exposed for review:
  - `ANNUAL_TRAINING_DEADLINE_MONTH = 12`, `ANNUAL_TRAINING_DEADLINE_DAY = 16`.
  - `FINGERPRINT_REMINDER_DAYS = 1643` (4.5 × 365.25, floored), `FINGERPRINT_URGENT_DAYS = 1826` (5 × 365.25, floored). Approximations acceptable for UI gating — the regulatory threshold is "every five years" with no defined precision.

### Items parked, awaiting the dashboard column-count check

| Item | Blocker |
|---|---|
| Location decision: extend `profiles` vs. new `provider_cdc_settings` table | Need column count from `information_schema.columns` |
| The migration body (column adds OR table create with RLS) | Depends on location decision |
| `bridges_provider_id` format CHECK constraint (`^\d{7}$`) | Depends on which table it lives on |
| `src/pages/CdcBillingSettingsPage.jsx` — settings form | Depends on where to read/write fields |
| Dashboard CTA wiring (`profile.onboarding_state.gate_answers.cdc === 'yes'` + null-field check) | Depends on where the fields live |
| Annual training countdown banner — surface `getAnnualTrainingDeadlineState` on dashboard | Helper exists; surface waits for migration |
| Fingerprint reprint countdown banner — surface `getFingerprintReprintState` on dashboard | Helper exists; surface waits for migration |
| Conditional `care_location` enum behaviour (LEP-Related → home OR child_home; LEP-Unrelated → child_home only; Licensed → facility_address) | Form lives where the migration lives |

## Spec § PR #8.5c — required review entries

### Location decision

*Pending — dashboard query required. The decision query:*

```sql
SELECT COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles';
```

*Threshold:* extend `profiles` if `< 30`, create `provider_cdc_settings` if `≥ 30`. Will be filled in when result lands. Estimate from prior session: 22–28, right at the threshold.

### Any provider records with missing data after deploy

*Pending — post-migration query against `profiles` (or the new table) for null `bridges_provider_id` etc., to size the "Complete CDC billing setup" CTA exposure.*

### UX choices on warning-banner severity thresholds

Spec § Step 5 pseudocode defines five severity tiers for the annual training banner:

| Days remaining | Severity | Spec colour cue |
|---|---|---|
| > 45 | (no banner) | — |
| 31–45 | `info` | grey/blue |
| 16–30 | `warning` | yellow |
| 7–15 | `urgent` | orange |
| 0–6 | `critical` | red |
| < 0 | `expired` | red |

`getAnnualTrainingDeadlineState` implements this ladder verbatim, with one disambiguation in the label copy: the 1-day case reads "due in 1 day —" (singular) instead of "1 days". Tests cover the boundary cases at 45, 30, 15, 6, 1, and 0 days.

The acceptance criteria also mention escalating display ("gray Nov 1, yellow Nov 15, orange Dec 1, red Dec 10+") — those colours map to the severities returned here. Banner component itself is parked with the rest of 8.5c's UI surfaces.

### Constants and approximations carried forward

- **Year length = 365.25 days** for the fingerprint window. Spec said "more than 4.5 years old" / "more than 5 years old" without precision; 365.25 averages over leap years. The regulatory threshold is operational, not exact-day; if MDHHS publishes a calendar-day rule we can tighten.
- **`provider_type` enum** spec'd as `lep_related`, `lep_unrelated`, `licensed_family`, `licensed_group`, `licensed_center`. The fingerprint helper guards on `lep_unrelated` only (set-based check makes it easy to expand if a future MDHHS rule extends the requirement to another type).

## Architectural notes carried forward from pre-build readout

### Helpers shipped without migration

The two helpers are pure functions with no DB dependency. Surfaced ahead of the migration so they can be tested in isolation and reviewed without scrolling through a SQL diff. When the migration lands the dashboard banners import them directly.

### CTA wiring intent (locked once migration decides location)

Per spec § Step 4 + the `gate_answers` location confirmed in the pre-build readout:

```javascript
const cdcSettingsIncomplete =
  profile?.onboarding_state?.gate_answers?.cdc === 'yes' &&
  (profile.bridges_provider_id == null ||
   profile.provider_type == null ||
   profile.care_location == null)
```

The field reads change from `profile.X` to `profileCdcSettings.X` if the new-table path is chosen — a one-line refactor at form time, but locked once the migration decides.
