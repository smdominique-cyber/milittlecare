// Tests for the Compliance Checklist visibility gate (Phase 3
// fix-forward). The load-bearing case is "loading → must NOT redirect"
// — that was the Phase 3 live-gate bug: ComplianceChecklistPage
// evaluated module + opt-in checks against the not-yet-loaded
// useActiveModules output and synchronously navigated away before the
// real data arrived.

import { describe, it, expect } from 'vitest'
import {
  resolveComplianceChecklistGate,
  isComplianceChecklistVisible,
  CHECKLIST_GATE,
} from './complianceChecklistVisibility'
import { MODULE_KEYS } from './modules'

function moduleSet(...keys) {
  return new Set(['core', ...keys])
}

function licensedHomeProfile(opts = {}) {
  return {
    id: 'p1',
    license_type: opts.license_type || 'group_home',
    program_settings: opts.program_settings || {},
  }
}

describe('resolveComplianceChecklistGate', () => {
  it('LOADING: returns "loading" while useActiveModules is loading (the Phase 3 bug)', () => {
    // First-render shape: loading=true, modules is the initial-render
    // {core} placeholder, profile is null. Before the fix, the page
    // evaluated this as "not licensed" and fired <Navigate /> — the bug.
    const result = resolveComplianceChecklistGate({
      loading: true,
      modules: moduleSet(),
      profile: null,
    })
    expect(result).toBe(CHECKLIST_GATE.LOADING)
  })

  it('LOADING: takes precedence even when modules already have LICENSED_COMPLIANCE', () => {
    // Belt-and-suspenders: even if the hook somehow has both
    // loading=true AND a populated modules Set, we still treat it as
    // loading. The hook's contract is "trust loading; everything else
    // may be a partial state."
    const result = resolveComplianceChecklistGate({
      loading: true,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({
        program_settings: { compliance_checklist_enabled: true },
      }),
    })
    expect(result).toBe(CHECKLIST_GATE.LOADING)
  })

  it('REDIRECT_DASHBOARD: LEP (no LICENSED_COMPLIANCE module)', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE),
      profile: { id: 'p1', license_type: 'license_exempt', program_settings: {} },
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_DASHBOARD)
  })

  it('REDIRECT_DASHBOARD: provider with no license_type yet', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(),  // core only
      profile: { id: 'p1', license_type: null, program_settings: {} },
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_DASHBOARD)
  })

  it('REDIRECT_DASHBOARD: modules Set is null (defensive)', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: null,
      profile: licensedHomeProfile(),
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_DASHBOARD)
  })

  it('REDIRECT_OPTIN: licensed home but flag not set', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({ program_settings: {} }),
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_OPTIN)
  })

  it('REDIRECT_OPTIN: licensed home with flag explicitly false', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({
        program_settings: { compliance_checklist_enabled: false },
      }),
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_OPTIN)
  })

  it('REDIRECT_OPTIN: licensed home with no program_settings on profile (the FamiliesPage SELECT bug — fixed in same PR)', () => {
    // The OTHER Phase 3 bug: FamiliesPage's licenseeProfile SELECT was
    // missing program_settings, so the tab gate always evaluated this
    // case → tab never appeared. The fix is the SELECT, but the helper
    // correctly classifies this as REDIRECT_OPTIN regardless.
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: { id: 'p1', license_type: 'group_home' /* no program_settings */ },
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_OPTIN)
  })

  it('REDIRECT_OPTIN: profile is null (post-load defensive)', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: null,
    })
    expect(result).toBe(CHECKLIST_GATE.REDIRECT_OPTIN)
  })

  it('ALLOWED: family_home + opted in', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({
        license_type: 'family_home',
        program_settings: { compliance_checklist_enabled: true },
      }),
    })
    expect(result).toBe(CHECKLIST_GATE.ALLOWED)
  })

  it('ALLOWED: group_home + opted in (the original live-gate test account)', () => {
    // The exact case that motivated the fix: a real group_home provider
    // with the opt-in flag set in their program_settings JSONB. Before
    // the fix this would have rendered the page; after the fix it
    // still does — but during loading the page now waits instead of
    // bouncing.
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({
        license_type: 'group_home',
        program_settings: { compliance_checklist_enabled: true },
      }),
    })
    expect(result).toBe(CHECKLIST_GATE.ALLOWED)
  })

  it('ALLOWED: extra unrelated program_settings keys are ignored', () => {
    const result = resolveComplianceChecklistGate({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({
        license_type: 'group_home',
        program_settings: {
          compliance_checklist_enabled: true,
          licensed_compliance: null,        // legacy/unused — must not interfere
          cdc: 'auto',
          cacfp: true,
        },
      }),
    })
    expect(result).toBe(CHECKLIST_GATE.ALLOWED)
  })

  it('defensive: missing args → loading-default (safe failure mode)', () => {
    // When the consumer hasn't supplied loading state, the helper
    // assumes loading. The page won't fire <Navigate />; the sidebar
    // item won't render. The two equivalent call sites — `()` and
    // `({})` — must behave identically; the implementation defaults
    // `loading = true` to make that so.
    expect(resolveComplianceChecklistGate()).toBe(CHECKLIST_GATE.LOADING)
    expect(resolveComplianceChecklistGate({})).toBe(CHECKLIST_GATE.LOADING)
    // Explicit `loading: false` with no modules → REDIRECT_DASHBOARD
    // (the consumer is telling us "I've finished loading; this is the
    // state").
    expect(resolveComplianceChecklistGate({ loading: false }))
      .toBe(CHECKLIST_GATE.REDIRECT_DASHBOARD)
  })
})

describe('isComplianceChecklistVisible', () => {
  it('true ONLY when gate = ALLOWED', () => {
    expect(isComplianceChecklistVisible({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile({
        program_settings: { compliance_checklist_enabled: true },
      }),
    })).toBe(true)
  })

  it('false during loading (Sidebar hides item until ready)', () => {
    expect(isComplianceChecklistVisible({
      loading: true,
      modules: moduleSet(),
      profile: null,
    })).toBe(false)
  })

  it('false for LEP', () => {
    expect(isComplianceChecklistVisible({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE),
      profile: { license_type: 'license_exempt', program_settings: { compliance_checklist_enabled: true } },
    })).toBe(false)
  })

  it('false when licensed but not opted in', () => {
    expect(isComplianceChecklistVisible({
      loading: false,
      modules: moduleSet(MODULE_KEYS.LICENSED_COMPLIANCE),
      profile: licensedHomeProfile(),  // no program_settings.compliance_checklist_enabled
    })).toBe(false)
  })
})
