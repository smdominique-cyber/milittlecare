import { supabase } from '@/lib/supabase'

/**
 * Send a state-change notification to the appropriate recipients (provider or parent).
 * Fire-and-forget — failures are logged but don't block the calling flow.
 *
 * @param {string} changeType - one of: allergy_updated, emergency_contact_updated, guardian_added,
 *                              guardian_removed, pickup_authorized, contact_updated, hours_changed,
 *                              closure_added, rate_updated, payment_due_day_changed
 * @param {string} familyId
 * @param {object} data - template-specific data (childName, allergies, etc.)
 * @param {string} childId - optional, for child-specific changes
 */
export async function notifyStateChange(changeType, familyId, data = {}, childId = null) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { sent: false, error: 'no_session' }

    const resp = await fetch('/api/notify-state-change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        change_type: changeType,
        family_id: familyId,
        child_id: childId,
        data,
      }),
    })
    return await resp.json()
  } catch (err) {
    console.warn('Notification failed:', err.message)
    return { sent: false, error: err.message }
  }
}
