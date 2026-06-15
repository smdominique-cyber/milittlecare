// PR #14 — License-type review banner.
//
// Surfaces a non-dismissible banner on the dashboard whenever the provider
// still owes a license_type answer:
//
//   * license_type IS NULL                 — never set (new provider, or a
//     pre-PR-#14 row whose backfill stayed null because the legacy signals
//     were ambiguous).
//   * license_type_review_needed = true    — the backfill flagged this row
//     for human disambiguation (most commonly: a licensed provider whose
//     provider_type was never set, so the backfill could not determine
//     family vs group home).
//
// On mount, when the banner is warranted, it ALSO auto-opens the existing
// LicenseStatusPromptModal so the answer can be captured in one motion.
// "Ask me later" on the modal closes the modal but the banner remains
// visible — the answer is genuinely required for compliance gating.
//
// Self-loading: the parent (DashboardPage) just renders this with `userId`.
// On a successful save the banner re-fetches its own state and unmounts
// when the row is resolved.

import { useEffect, useState, useCallback } from 'react'
import { AlertCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { needsLicenseTypeReview } from '@/lib/licenseStatusPrompt'
import LicenseStatusPromptModal from '@/components/funding/LicenseStatusPromptModal'

export default function LicenseTypeReviewBanner({ userId }) {
  const [profile, setProfile] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  const load = useCallback(async () => {
    if (!userId) return
    const { data } = await supabase
      .from('profiles')
      .select('license_type, license_type_review_needed')
      .eq('id', userId)
      .maybeSingle()
    setProfile(data || null)
    setLoaded(true)
  }, [userId])

  useEffect(() => { load() }, [load])

  const needsReview = loaded && needsLicenseTypeReview(profile)

  // Auto-open the modal once per mount when the banner is warranted.
  useEffect(() => {
    if (needsReview) setModalOpen(true)
    // Intentionally no dependency on modalOpen — we only want to open once
    // on mount/initial load, not re-open if the user closes it.
  }, [needsReview])

  const handleModalClose = async () => {
    setModalOpen(false)
    // Re-fetch in case "ask me later" closed without saving, OR the modal's
    // own save path completed — either way the banner reflects ground truth.
    await load()
  }

  if (!needsReview) return null

  return (
    <>
      <div
        role="alert"
        style={{
          background: 'var(--clr-warn-pale, #fdf3d8)',
          border: '1px solid var(--clr-warn-mid, #e8d196)',
          color: 'var(--clr-warn-ink, #8a6a1a)',
          borderRadius: 'var(--radius-lg)',
          padding: 14,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <AlertCircle size={20} style={{ flexShrink: 0 }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: '0.9375rem',
            marginBottom: 2,
          }}>
            Please confirm your license type
          </div>
          <div style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-mid)',
            lineHeight: 1.4,
          }}>
            We need to know whether you’re a Family Child Care Home, Group
            Child Care Home, or license-exempt provider before we can show
            the right compliance tools.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          style={{
            background: 'var(--clr-sage-dark)',
            color: 'white',
            border: 'none',
            padding: '8px 16px',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-body)',
          }}
        >
          Set license type
        </button>
      </div>

      {modalOpen && (
        <LicenseStatusPromptModal onClose={handleModalClose} />
      )}
    </>
  )
}
