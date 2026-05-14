# MILittleCare: Funding Source Data Model Spec

**Status:** Draft for first PR
**Goal:** Establish the foundational data model that makes every Tier 1 feature (I-Billing reconciliation, Tri-Share split billing, CDC enrollment agreements, multi-payer ledger, module activation) plug in cleanly without touching each other.

This is the **scaffolding PR**. It ships no user-facing CDC/Tri-Share features. It establishes the bones so every subsequent PR is "add a module" not "redesign the app."

---

## The Core Idea

A `Child` has a **stack** of `FundingSource` records, not a single funding type. Each funding source carries its own rules, billing cycle, authorization period, and reporting requirements. The app's UI and feature modules turn on or off based on which funding source types are active across the provider's children.

A child with one private-pay source looks normal. A child with one CDC source + one private-pay source generates two invoice line items (one to MDHHS via I-Billing, one to the family). The provider's nav bar grows or shrinks accordingly.

---

## Data Model

### 1. `Child` (existing entity, minor changes)

```typescript
Child {
  id: uuid
  family_id: uuid (FK)
  first_name: string
  last_name: string
  dob: date
  enrollment_start_date: date
  enrollment_end_date: date | null
  is_active: boolean
  
  // NEW (or migrated from existing rate fields):
  funding_sources: FundingSource[]  // 1-to-many relationship
  
  // DEPRECATED but kept one release for migration:
  // legacy_hourly_rate, legacy_weekly_rate, etc.
}
```

Constraint: every active Child must have at least one active FundingSource. Migration creates a `private_pay` source from any existing rate fields.

---

### 2. `FundingSource` (new entity)

Single table with discriminated union pattern. Type-specific fields live in a `details` JSON column (or, if you prefer normalized SQL, in joined tables — either works; I lean JSON for V1 speed).

```typescript
FundingSource {
  id: uuid
  child_id: uuid (FK)
  type: FundingSourceType  // enum, see below
  status: 'active' | 'paused' | 'ended'
  start_date: date
  end_date: date | null
  priority: integer  // when allocating attendance hours, lower = consumed first
  hours_cap_per_period: integer | null  // null = unlimited / governed by attendance
  notes: text | null
  details: jsonb  // type-specific, see schemas below
  created_at, updated_at
  archived_at: timestamp | null  // soft delete for 4-year retention
}

enum FundingSourceType {
  'private_pay',
  'cdc_scholarship',
  'tri_share',
  'gsrp',
  'head_start',
  'agency_other'
}
```

**Priority rule:** when multiple sources cover the same hours, the lowest priority number consumes attendance hours first. Typical setup: CDC = 1, Tri-Share = 1 (mutually exclusive in practice), Private Pay = 99. Hours beyond the state-authorized cap automatically spill to private pay.

**Retention:** funding sources are never hard-deleted. `archived_at` is set when a source ends and is past the 4-year retention window. Until then, the row stays queryable for audit.

---

### 3. Type-specific `details` schemas

#### `private_pay`

```typescript
PrivatePayDetails {
  rate_type: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'per_session'
  rate_amount: decimal
  late_fee_amount: decimal | null
  late_fee_grace_days: integer | null
  payer_contact_ids: uuid[]  // who in the family is responsible
  invoice_frequency: 'weekly' | 'biweekly' | 'monthly'
  invoice_due_day: integer  // 1-31 or 0-6 depending on frequency
}
```

#### `cdc_scholarship`

```typescript
CDCScholarshipDetails {
  // Authorization
  dhs_198_received_date: date
  authorization_start: date
  authorization_end: date
  approved_hours_per_period: integer  // bi-weekly approved hours (e.g. 120)
  family_contribution_amount: decimal  // per pay period
  
  // Billing basis (drives validation rules)
  billing_basis: 'enrollment' | 'attendance'
  // enrollment = licensed provider, requires Enrollment Agreement
  // attendance = license-exempt provider, requires daily time/attendance form
  
  // Multi-provider scenarios
  shared_with_other_provider: boolean
  shared_provider_notes: text | null
  
  // Document linkage
  enrollment_agreement_doc_id: uuid | null  // FK to Document table
  dhs_198_doc_id: uuid | null
  
  // Identifiers
  case_number: string | null  // MDHHS case number for parent
  provider_pin_required: boolean  // true if first CDC kid
  
  // Tracking
  absence_days_used_this_period: integer  // managed by attendance module
  excess_credit_balance: decimal  // running balance owed to family from overpayments
}
```

#### `tri_share`

```typescript
TriShareDetails {
  variant: 'tri_share' | 'care_share'
  
  // Three-way split (sums to 100)
  employer_share_percent: decimal  // ~33.3 for both variants
  state_share_percent: decimal     // ~33.3 for tri_share, 0 for care_share
  employee_share_percent: decimal  // ~33.3 for tri_share, ~66.7 for care_share
  
  // Parties
  employer_name: string
  employer_billing_contact_email: string
  hub_id: uuid  // FK to TriShareHub directory table
  
  // Authorization
  authorization_start: date
  authorization_end: date
  approved_hours_per_week: integer | null
  
  // Provider eligibility verification
  great_start_star_rating_at_enrollment: integer  // must be 3+
}
```

#### `gsrp` (stub for V2, schema reserved)

```typescript
GSRPDetails {
  isd_partner: string
  program_type: 'half_day' | 'full_day' | 'school_day' | 'school_year' | 'blend_head_start'
  authorization_start: date
  authorization_end: date
  reserved_for_v2: true
}
```

#### `agency_other`

```typescript
AgencyOtherDetails {
  agency_name: string
  agency_contact_email: string | null
  rate_amount: decimal
  rate_basis: 'hourly' | 'daily' | 'weekly' | 'flat_per_period'
  authorization_start: date
  authorization_end: date | null
}
```

---

### 4. `Provider.program_settings` (new field on existing Provider/User)

```typescript
Provider {
  // ... existing fields
  
  // Module overrides — null means "auto-determine from active funding sources"
  program_settings: {
    cdc: 'auto' | 'force_on' | 'force_off'
    tri_share: 'auto' | 'force_on' | 'force_off'
    gsrp: 'auto' | 'force_on' | 'force_off'
    cacfp: boolean  // provider-level, not kid-driven; default false
    license_exempt_compliance: boolean  // default null, set on onboarding
    licensed_compliance: boolean
  }
  
  // Provider-level CDC/Michigan-specific fields (move from elsewhere if needed)
  michigan_license_number: string | null
  michigan_provider_id: string | null  // CDC Provider ID
  miregistry_id: string | null
  great_start_star_rating: integer | null  // 0-5
  is_license_exempt: boolean
  annual_training_completion_date: date | null  // for Dec 16 tracker
}
```

---

### 5. `BillingPeriod` (new entity)

Different funding types have different period schedules. Model this explicitly so we never have to hard-code "every two weeks starting from..." anywhere.

```typescript
BillingPeriod {
  id: uuid
  provider_id: uuid
  funding_type: FundingSourceType
  
  period_number: integer | null  // for CDC, matches MiLEAP's published pay period #
  start_date: date
  end_date: date
  reporting_deadline: date  // when the provider must have billed
  
  status: 'upcoming' | 'open' | 'submitted' | 'paid' | 'reconciled'
  submitted_at: timestamp | null
  expected_payment_date: date | null
  actual_payment_date: date | null
  actual_payment_amount: decimal | null
}
```

CDC periods seed from the official MiLEAP payment schedule (publish annually; we hardcode the 2026 schedule for V1).

---

### 6. `InvoiceLine` (modification to existing Invoice/InvoiceLine)

Every line gets a `funding_source_id` reference. This is the single change that makes multi-payer billing fall out naturally.

```typescript
InvoiceLine {
  id: uuid
  invoice_id: uuid
  child_id: uuid
  funding_source_id: uuid  // NEW — null only for legacy data
  
  description: string
  hours: decimal | null
  rate: decimal | null
  amount: decimal
  
  // For state-payable lines:
  billing_period_id: uuid | null
  reported_to_state_at: timestamp | null
}
```

A provider running an invoice cycle for a CDC kid with overflow private hours generates *two invoices*: one to MDHHS (a state billing record, exported to I-Billing), one to the family (a normal invoice with the family contribution + overflow hours).

---

## Module Activation Logic

This is the function that drives what the UI shows. Pure function of provider state.

```typescript
function getActiveModules(provider: Provider): Set<ModuleKey> {
  const modules = new Set<ModuleKey>(['core'])
  
  // Auto-activate based on active funding sources across active children
  const activeFundingTypes = new Set(
    provider.children
      .filter(c => c.is_active)
      .flatMap(c => c.funding_sources)
      .filter(s => s.status === 'active')
      .map(s => s.type)
  )
  
  if (activeFundingTypes.has('cdc_scholarship')) modules.add('cdc')
  if (activeFundingTypes.has('tri_share')) modules.add('tri_share')
  if (activeFundingTypes.has('gsrp')) modules.add('gsrp')
  if (activeFundingTypes.has('agency_other')) modules.add('agency_billing')
  
  // Apply explicit overrides
  for (const [key, setting] of Object.entries(provider.program_settings)) {
    if (setting === 'force_on') modules.add(key as ModuleKey)
    if (setting === 'force_off') modules.delete(key as ModuleKey)
  }
  
  // Provider-level triggers
  if (provider.miregistry_id) modules.add('miregistry_tracker')
  if (provider.michigan_license_number) modules.add('licensed_compliance')
  if (provider.is_license_exempt) modules.add('license_exempt_compliance')
  if (provider.program_settings.cacfp) modules.add('cacfp')
  
  return modules
}
```

UI consumers (nav bar, dashboard, settings page) call this and conditionally render. Nothing else.

---

## Migration Plan

For the existing production database (Venessa's data + any other beta users):

1. **Add new tables:** `funding_sources`, `billing_periods`, `tri_share_hubs` (seed with 12 known hubs).
2. **Add columns:** new fields on `children` (none required immediately), `providers` (`program_settings`, Michigan ID fields).
3. **Backfill:** for each active `Child`, create one `FundingSource` of type `private_pay`, copying the existing rate fields into `details`. Set `start_date` = child's `enrollment_start_date`. Set `priority = 99`.
4. **Update billing engine:** existing invoice generation reads from `funding_sources[0]` for now. No behavior change for current users.
5. **Deprecate but keep** the old rate fields on `Child` for one release cycle. Mark `@deprecated` in TypeScript.
6. **Ship UI:** new "Funding" tab on the child profile shows the funding source stack. Default view for private-pay-only providers stays identical to today.

Migration must be reversible. Write the down-migration before merging.

---

## Out of Scope for This PR

Explicitly not building yet:

- The actual CDC billing engine (I-Billing CSV generation, 10-day absence cap enforcement, 2,016-hour cap)
- Tri-Share three-way invoice generation
- MDHHS-4025 form generation
- Enrollment Agreement generator
- MiRegistry deadline countdown widget
- CDC handbook AI assistant
- Family Contribution ledger UI

Every one of those becomes its own PR once this foundation lands. They all read from `FundingSource.type === 'cdc_scholarship'` (or whichever) and operate within their module's namespace.

---

## In Scope for This PR

What actually ships:

1. New database tables and migrations (`funding_sources`, `billing_periods`, `tri_share_hubs`).
2. New columns on `providers` and `children`.
3. Backfill migration for existing data (create private_pay sources for all active kids).
4. `FundingSource` CRUD API endpoints (list, create, update, archive).
5. `getActiveModules(provider)` utility function with unit tests.
6. New "Funding" section on the child profile page — UI to add/edit/remove funding sources, with type-specific forms (start with `private_pay` and `cdc_scholarship`; stub the others).
7. Nav bar reads from `getActiveModules` and conditionally shows section links.
8. Dashboard "Today" widget reads from `getActiveModules` and pulls one urgent item per active module (placeholders for the modules we haven't built yet).
9. Settings page: "Programs" section showing the auto-detected modules with override toggles.

---

## Acceptance Criteria

Before merging, all of these must be true:

- [ ] A brand-new provider account signs up and sees a clean "private pay only" experience. Word "CDC" appears nowhere in the UI.
- [ ] Adding a CDC funding source to one child causes the CDC nav section to appear within one page reload, with placeholder content.
- [ ] Removing the last active CDC funding source causes the CDC nav section to disappear (settings retained).
- [ ] Venessa's existing data migrates cleanly: every active kid has exactly one private_pay funding source matching her current rate setup.
- [ ] An invoice generated post-migration is identical to one generated pre-migration for the same period.
- [ ] All existing tests pass. New tests cover `getActiveModules` with at least 8 scenarios (private-only, CDC-only, mixed, paused sources, overrides, etc.).
- [ ] The down-migration restores the database to pre-PR state.

---

## Tests to Write

Minimum test suite for this PR:

**`getActiveModules` unit tests**
- Private-pay-only provider → `{core}`
- One active CDC kid → `{core, cdc, license_exempt_compliance OR licensed_compliance}`
- One CDC kid + one private kid → `{core, cdc, ...}`
- One CDC kid with status='paused' + provider override force_off → `{core}`
- One Tri-Share kid → `{core, tri_share}`
- Mixed CDC + Tri-Share + private + GSRP → all four modules visible
- Provider with miregistry_id set but no Michigan kids → `{core, miregistry_tracker}`
- Provider with `program_settings.cdc = 'force_on'` but no CDC kids → CDC module visible

**Migration tests**
- Existing child with hourly rate $5 → one funding_source row, type=private_pay, rate_amount=5
- Existing child with weekly rate → same, with rate_type='weekly'
- Existing child with no rate set → one funding_source row with rate_amount=0 and a TODO flag

**API tests**
- POST /api/children/:id/funding_sources with type=cdc → returns 201 with valid CDC schema
- POST same with invalid billing_basis → 400 with clear message
- PATCH funding_source to status=ended → does not delete; sets end_date and status
- DELETE → soft-delete only; row remains queryable via includeArchived flag

---

## Naming Conventions

For consistency across the next 6 months of building:

- `FundingSource` not `Funding` or `PaymentSource` (we're modeling who funds, not who pays)
- `funding_source_id` everywhere as FK column name
- Type values are lowercase snake_case: `cdc_scholarship`, `tri_share`, `private_pay`
- UI strings use the program's preferred name: "CDC Scholarship" (not "subsidy" — MiLEAP renamed it), "MI Tri-Share", "Private Pay"
- Module keys in code: `cdc`, `tri_share`, `gsrp`, `miregistry_tracker`, etc. — short, lowercase

---

## Risks and Mitigations

**Risk: Venessa's existing data migrates wrong.** Mitigation: write the migration against a copy of her production DB first. Have her review the resulting funding source view before flipping the switch.

**Risk: Scope creep — someone wants to build "just one CDC feature" on top of this PR.** Mitigation: don't. Ship the scaffolding alone. The next PR can be the I-Billing reconciliation engine, but it's a separate PR with a separate review.

**Risk: The JSON `details` column hurts queryability for CDC-specific reports later.** Mitigation: Postgres jsonb with GIN indexes handles this well. If we hit a wall, the migration to normalized per-type tables is mechanical and additive.

**Risk: Naming "private_pay" excludes future cash/check/Venmo payment-method distinctions.** Mitigation: funding source = who funds; payment method = how they pay. Payment method already lives on the Invoice/Payment record, not here. Don't conflate.

---

## Roadmap (post-scaffolding)

The scaffolding PR shipped. Subsequent PRs are independent and slot
in as modules. Roadmap reordered 2026-05-15 to prioritize CDC features
based on Venessa's usage signal and the broader Michigan market shape.

**Shipped:**

- Funding source scaffolding (data model + module activation)
- Funding document vault (DHS-198 + Enrollment Agreement uploads with
  audit retention)
- License Exempt CDC Scholarship handbook + reference docs in
  `docs/reference/`
- MiRegistry deadline tracker (annual deadline countdown + Level 1/2
  status + entries log)

**Next, in priority order:**

1. **CDC pay period catalog + payment schedule display** (~1 week).
   Surfaces the published MiLEAP pay period schedule so providers see
   "what's the current pay period? when's the next one?" without
   leaving MILittleCare. Foundation for the reconciliation work below.
2. **Attendance foundation** (~1-2 weeks). Data model for daily
   attendance per child — prerequisite for CDC I-Billing
   reconciliation since license-exempt providers bill on actual
   attended hours, not enrolled hours.
3. **CDC I-Billing reconciliation view** (~2-3 weeks). Per-kid hour
   totals per pay period, 10-day absence cap pre-applied, formatted
   for I-Billing entry. Reads from
   `funding_sources.type='cdc_scholarship'`,
   `billing_periods.funding_type='cdc_scholarship'`, and the new
   attendance data.
4. **TBD based on Venessa's usage signal.** Prioritize based on real
   friction Venessa surfaces during the CDC features above. Likely
   candidates: CDC handbook AI assistant, expanded reporting, billing
   automation.

**Deferred:**

- **Tri-Share three-way invoice generator.** Revisit when a Tri-Share
  hub or a Tri-Share-eligible provider creates real demand. Rationale:
  CDC Scholarship reaches ~98k Michigan kids; Tri-Share reaches
  ~1-2k. Venessa is CDC-primary with zero Tri-Share families. Building
  CDC features next directly serves her and the larger market. The
  Tri-Share data model already exists in `funding_sources` (the
  scaffolding included the `tri_share` enum value, hub linkage, and
  three-way split fields), and the Tri-Share docs and references stay
  in `docs/reference/` for when the program does become relevant.

Each "Next" item is independent. Each can be reviewed and shipped in
days, not weeks.
