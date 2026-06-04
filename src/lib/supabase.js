import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Copy .env.example to .env.local and fill in your project URL and anon key.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
})

// 2026-06-04 — Dev / preview-only console handle.
//
// The Phase Y1 verification gate (and future RLS / boundary tests)
// requires invoking auth-gated RPCs as the AUTHENTICATED user from
// the browser devtools console — there is no UI for it in Y1.
// This exposes the already-authenticated client globally ONLY on
// non-production hostnames. Provably absent on milittlecare.com.
//
// ── Guard choice ─────────────────────────────────────────────────
// Hostname check, NOT import.meta.env.DEV / .MODE / VERCEL_ENV.
// Reasoning:
//   - `import.meta.env.DEV` is FALSE on Vercel preview builds
//     (preview runs `vite build`, same command as production).
//   - `import.meta.env.MODE` is `'production'` on both Vercel
//     preview AND production — same root cause.
//   - `VERCEL_ENV` / `VITE_VERCEL_ENV` would work but requires
//     Vercel to be configured to surface it into the Vite client
//     bundle (an extra config dependency).
//   - Hostname is the most robust + auditable signal: anyone can
//     look at the address bar and confirm whether the handle is
//     exposed.
//
// ── Evaluation on each surface ───────────────────────────────────
//   - Local dev (`vite dev`)      → host='localhost' / '127.0.0.1' / .local → ATTACHES
//   - Vercel preview deployment   → host='<branch>-milittlecare.vercel.app' → ATTACHES
//   - Production (milittlecare.com or www.milittlecare.com)        → ABSENT
//
// If the production domain ever changes, update this allowlist.
// The denylist style (only known production hosts excluded) is
// intentional — it fails OPEN on preview / local (the handle
// appears, useful for testing) and CLOSED on production (the
// handle is absent unless the hostname is recognized as non-prod).
if (typeof window !== 'undefined') {
  const host = window.location.hostname
  const isProductionHost =
    host === 'milittlecare.com' ||
    host === 'www.milittlecare.com'
  if (!isProductionHost) {
    // The same authenticated client the app uses. Calls like
    // `window.supabase.rpc('consent_esign_complete', {...})` run
    // under the current signed-in user's session.
    window.supabase = supabase
  }
}
