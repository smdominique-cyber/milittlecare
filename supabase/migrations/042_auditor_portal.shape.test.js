// Auditor Portal Phase 1 — migration shape test.
//
// We can't run real Postgres in vitest, but we can statically verify
// that the migration carries the load-bearing shape:
//
//   - is_auditor_jwt() helper exists with the COALESCE-to-false body.
//   - The canonical SECURITY DEFINER revoke/grant trailer (CLAUDE.md
//     rule 4) is present.
//   - The auditor_sessions + auditor_session_access_log tables are
//     defined.
//   - The 72h cap CHECK constraint is present.
//   - The partial unique index for active sessions is present.
//   - The DO block that templates the universal "auditor jwt denied"
//     RESTRICTIVE policy across every public table is present.
//   - The handle_new_user trigger function was replaced to set
//     is_audit_account.
//   - profiles.is_audit_account and profiles.password_disabled_at
//     columns are added.
//
// The runtime-correctness checks (the policy actually lands on every
// table; the helper actually returns false outside auditor JWTs)
// happen at apply-time in Supabase SQL Editor per the verification
// queries embedded in the migration header.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL = readFileSync(join(__dirname, '042_auditor_portal.sql'), 'utf8')

describe('042 — is_auditor_jwt helper', () => {
  it('declares the helper with the COALESCE-to-false body', () => {
    expect(SQL).toMatch(/create or replace function public\.is_auditor_jwt\(\)/i)
    expect(SQL).toMatch(/auth\.jwt\(\)->'app_metadata'->>'role'/)
    expect(SQL).toMatch(/coalesce\([\s\S]*?,\s*false\s*\)/i)
  })

  it('uses STABLE + SECURITY DEFINER + set search_path = public, pg_catalog', () => {
    // All three properties appear within the function definition.
    const fnSection = SQL.match(/create or replace function public\.is_auditor_jwt[\s\S]*?\$\$;/i)
    expect(fnSection).not.toBeNull()
    expect(fnSection[0]).toMatch(/\bstable\b/i)
    expect(fnSection[0]).toMatch(/security definer/i)
    expect(fnSection[0]).toMatch(/search_path\s*=\s*public,\s*pg_catalog/i)
  })

  it('applies the canonical revoke/grant trailer per CLAUDE.md rule 4', () => {
    expect(SQL).toMatch(/revoke all\s+on function public\.is_auditor_jwt\(\)\s+from public/i)
    expect(SQL).toMatch(/revoke execute on function public\.is_auditor_jwt\(\)\s+from anon/i)
    expect(SQL).toMatch(/grant\s+execute on function public\.is_auditor_jwt\(\)\s+to authenticated/i)
  })
})

describe('042 — handle_new_user replacement', () => {
  it('replaces handle_new_user to populate is_audit_account from raw_app_meta_data', () => {
    expect(SQL).toMatch(/create or replace function public\.handle_new_user\(\)/i)
    // Body references is_audit_account and raw_app_meta_data.
    expect(SQL).toMatch(/is_audit_account/)
    expect(SQL).toMatch(/raw_app_meta_data\s*->>\s*'role'/)
  })
})

describe('042 — profiles column additions', () => {
  it('adds is_audit_account (boolean NOT NULL DEFAULT false)', () => {
    expect(SQL).toMatch(
      /alter table public\.profiles[\s\S]*?add column if not exists is_audit_account boolean not null default false/i
    )
  })
  it('adds password_disabled_at (timestamptz nullable)', () => {
    expect(SQL).toMatch(
      /alter table public\.profiles[\s\S]*?add column if not exists password_disabled_at timestamptz/i
    )
  })
})

describe('042 — auditor_sessions table', () => {
  it('declares auditor_user_id (FK auth.users, ON DELETE SET NULL)', () => {
    expect(SQL).toMatch(/auditor_user_id\s+uuid\s+references auth\.users\(id\) on delete set null/i)
  })

  it('declares email_at_creation NOT NULL', () => {
    expect(SQL).toMatch(/email_at_creation\s+text\s+not null/i)
  })

  it('does NOT carry signing_key_version as an actual COLUMN (HMAC layer deleted; comments mentioning the dropped column are fine)', () => {
    // Strip SQL line comments first so a reference inside `-- ...` doesn't
    // false-positive. Then assert no column declaration remains.
    const codeOnly = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
    expect(codeOnly).not.toMatch(/signing_key_version\s+smallint/i)
    expect(codeOnly).not.toMatch(/signing_key_version\s+integer/i)
  })

  it('enforces the 72h cap CHECK constraint', () => {
    expect(SQL).toMatch(/auditor_sessions_expiry_window/i)
    expect(SQL).toMatch(/expires_at\s*<=\s*starts_at\s*\+\s*interval\s+'72 hours'/i)
  })

  it('declares the partial unique index for active sessions', () => {
    expect(SQL).toMatch(/create unique index if not exists auditor_sessions_active_unique_idx/i)
    expect(SQL).toMatch(/where revoked_at is null and expires_at > now\(\)/i)
  })

  it('enables RLS and creates the provider-scoped SELECT/INSERT/UPDATE policies', () => {
    expect(SQL).toMatch(/alter table public\.auditor_sessions enable row level security/i)
    expect(SQL).toMatch(/create policy "Providers select own auditor sessions"\s+on public\.auditor_sessions for select\s+using\s*\(\s*auth\.uid\(\)\s*=\s*provider_id\s*\)/i)
    expect(SQL).toMatch(/create policy "Providers insert own auditor sessions"/i)
    expect(SQL).toMatch(/create policy "Providers update own auditor sessions"/i)
    // No DELETE policy.
    expect(SQL).not.toMatch(/create policy[\s\S]*?on public\.auditor_sessions for delete/i)
  })
})

describe('042 — auditor_session_access_log table', () => {
  it('creates the table with the event_kind CHECK whitelist incl. password_rotated', () => {
    expect(SQL).toMatch(/create table if not exists public\.auditor_session_access_log/i)
    expect(SQL).toMatch(/'password_rotated'/)
    expect(SQL).toMatch(/'session_created'/)
    expect(SQL).toMatch(/'session_revoked'/)
    expect(SQL).toMatch(/'denied'/)
    expect(SQL).toMatch(/'read'/)
  })

  it('provider-scoped SELECT only — no INSERT/UPDATE/DELETE policy', () => {
    expect(SQL).toMatch(/create policy "Providers select own session access log"\s+on public\.auditor_session_access_log for select/i)
    expect(SQL).not.toMatch(/on public\.auditor_session_access_log for insert/i)
    expect(SQL).not.toMatch(/on public\.auditor_session_access_log for update/i)
    expect(SQL).not.toMatch(/on public\.auditor_session_access_log for delete/i)
  })
})

describe('042 — THE SEAL (universal auditor-deny templated across every public table)', () => {
  it('contains the DO block that iterates public BASE TABLES', () => {
    expect(SQL).toMatch(/do \$\$/i)
    expect(SQL).toMatch(/from information_schema\.tables/i)
    expect(SQL).toMatch(/where table_schema\s*=\s*'public'/i)
    expect(SQL).toMatch(/and table_type\s*=\s*'BASE TABLE'/i)
  })

  it('the body creates the RESTRICTIVE policy named "auditor jwt denied" on each table', () => {
    expect(SQL).toMatch(/'create policy "auditor jwt denied"/i)
    expect(SQL).toMatch(/as restrictive/i)
    expect(SQL).toMatch(/using \(not public\.is_auditor_jwt\(\)\)/i)
    expect(SQL).toMatch(/with check \(not public\.is_auditor_jwt\(\)\)/i)
  })

  it('enables RLS on each iterated table (idempotent)', () => {
    expect(SQL).toMatch(/'alter table public\.%I enable row level security'/i)
  })

  it('drops the policy before recreating it (idempotent re-apply)', () => {
    expect(SQL).toMatch(/'drop policy if exists "auditor jwt denied" on public\.%I'/i)
  })

  it('uses format() to parameterize the table name (safe identifier interpolation)', () => {
    expect(SQL).toMatch(/execute format\(/i)
  })
})

describe('042 — verification queries embedded in header', () => {
  it('embeds the one-line seal-coverage check', () => {
    expect(SQL).toMatch(/select tablename from pg_policies/i)
    expect(SQL).toMatch(/where policyname = 'auditor jwt denied'/i)
  })

  it('embeds the "any table missing the deny?" inverse check', () => {
    expect(SQL).toMatch(/from pg_tables[\s\S]*?and not exists/i)
  })
})
