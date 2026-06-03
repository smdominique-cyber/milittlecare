// PR consent-attachments Part 1 — the privacy boundary.
//
// Authoritative spec: docs/pr-consent-attachments-scope.md §3 + §8
// (decision 3 — the parent-read mechanism). This Edge Function is
// the ONLY path by which a parent obtains a signed URL for a
// consent-attachment scan. The bucket's storage RLS is owner-only
// (provider-only, gated by first-folder-segment = auth.uid()), so
// a parent cannot read directly. This function — running with
// service-role — performs an explicit join check in code:
//
//   parent's JWT → auth.uid()
//   attachment_id → consent_attachments → (target_type, target_id, storage_path)
//   target → child_id (via three resolution paths; any other path = deny)
//   parent_family_links (active, parent_id=auth.uid(), family_id=child.family_id)
//
// Only on full success does the function mint a 15-minute signed
// URL. The parent metadata SELECT policy on consent_attachments
// (migration 029) is the parallel guard at the metadata layer;
// both must deny in the verification gate's cross-tenant test.
//
// 403-vs-404 collapse: the function returns 404 for BOTH "doesn't
// exist" AND "you aren't authorized to learn that it exists."
// Rationale (per the scope doc's anti-enumeration note): UUIDs are
// 128-bit random and brute-force enumeration is impractical, but
// collapsing the status codes costs nothing AND removes the
// differential-response side channel where a malicious caller
// could probe attachment-id existence by attending to status
// codes. 401 is reserved for "no/invalid JWT"; 400 for malformed
// requests; 405 for non-POST methods.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

export const config = { runtime: 'edge' }

const SIGNED_URL_TTL_SECONDS = 15 * 60   // matches funding-docs convention

// -----------------------------------------------------------------------------
// Supabase REST helpers (service-role)
// -----------------------------------------------------------------------------

async function supabaseRequest(path, method = 'GET', body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`
  const resp = await fetch(url, {
    method,
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return resp
}

async function verifyAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const resp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  })
  if (!resp.ok) return null
  return await resp.json()
}

/**
 * Resolves a consent_attachments row to the underlying child_id via
 * the three resolution paths from the scope doc §8 step 3:
 *
 *   - target_type='acknowledgment', ack.subject_type='child'
 *       → child_id = ack.subject_id
 *   - target_type='acknowledgment',
 *     ack.subject_type='medication_authorization'
 *       → child_id = medication_authorizations.child_id
 *       (looked up via ack.subject_id → med_auth.id)
 *   - target_type='medication_authorization'
 *       → child_id = medication_authorizations.child_id
 *       (looked up via attachment.target_id → med_auth.id)
 *
 * Any other ack.subject_type (caregiver / family / provider / null)
 * → returns null (deny). The acknowledgment AND
 * medication_authorization rows must each be non-archived; archived
 * consents don't surface their attachments.
 *
 * Returns the resolved child_id (uuid string) or null if the chain
 * doesn't resolve (deny path).
 */
async function resolveChildIdFromAttachment(attachment) {
  if (!attachment) return null
  const { target_type, target_id } = attachment

  if (target_type === 'acknowledgment') {
    const ackResp = await supabaseRequest(
      `acknowledgments?id=eq.${encodeURIComponent(target_id)}&select=id,subject_type,subject_id,archived_at&limit=1`,
      'GET'
    )
    const rows = await ackResp.json().catch(() => null)
    const ack = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    if (!ack || ack.archived_at) return null

    if (ack.subject_type === 'child') {
      return ack.subject_id || null
    }
    if (ack.subject_type === 'medication_authorization') {
      const medResp = await supabaseRequest(
        `medication_authorizations?id=eq.${encodeURIComponent(ack.subject_id)}&select=id,child_id,archived_at&limit=1`,
        'GET'
      )
      const medRows = await medResp.json().catch(() => null)
      const med = Array.isArray(medRows) && medRows.length > 0 ? medRows[0] : null
      if (!med || med.archived_at) return null
      return med.child_id || null
    }
    // Any other subject_type (caregiver, family, provider, NULL) — deny.
    return null
  }

  if (target_type === 'medication_authorization') {
    const medResp = await supabaseRequest(
      `medication_authorizations?id=eq.${encodeURIComponent(target_id)}&select=id,child_id,archived_at&limit=1`,
      'GET'
    )
    const medRows = await medResp.json().catch(() => null)
    const med = Array.isArray(medRows) && medRows.length > 0 ? medRows[0] : null
    if (!med || med.archived_at) return null
    return med.child_id || null
  }

  // Unknown target_type — the table CHECK should have rejected this
  // at insert time, but be defensive at the read boundary too.
  return null
}

/**
 * Checks the parent has an active link to the resolved child's
 * family. Returns true iff parent_family_links has an active row
 * tying parent_id=auth.uid() to a family that contains child_id.
 * This is THE cross-tenant boundary check.
 */
async function parentIsLinkedToChild({ parentUserId, childId }) {
  // Resolve child → family_id.
  const childResp = await supabaseRequest(
    `children?id=eq.${encodeURIComponent(childId)}&select=id,family_id&limit=1`,
    'GET'
  )
  const childRows = await childResp.json().catch(() => null)
  const child = Array.isArray(childRows) && childRows.length > 0 ? childRows[0] : null
  if (!child || !child.family_id) return false

  // Look for an active parent_family_link.
  const linkResp = await supabaseRequest(
    `parent_family_links?parent_id=eq.${encodeURIComponent(parentUserId)}&family_id=eq.${encodeURIComponent(child.family_id)}&status=eq.active&select=parent_id&limit=1`,
    'GET'
  )
  const linkRows = await linkResp.json().catch(() => null)
  return Array.isArray(linkRows) && linkRows.length > 0
}

/**
 * Validates that a storage_path matches the expected shape
 * `<providerUuid>/<targetUuid>/<uuid>.<ext>` — the path that the
 * upload helper (`src/lib/consentAttachments.js` →
 * `buildScopedStoragePath`) always produces. Closes the theoretical
 * path-traversal vector flagged by the Part 1 audit: a malicious
 * provider COULD in principle insert a `consent_attachments` row
 * with `storage_path` containing `../` or other traversal segments
 * that, after URL normalization in `mintSignedUrl`, would target a
 * different bucket. The shape check here makes that impossible.
 *
 * Three lowercased-hex UUID segments separated by `/`, then a
 * lowercase 3-4 char alpha extension. No `..`, no leading `/`, no
 * mixed-case, no extra segments.
 */
const STORAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]{2,5}$/

function isValidStoragePath(storagePath) {
  if (typeof storagePath !== 'string') return false
  return STORAGE_PATH_RE.test(storagePath)
}

/**
 * Mints a 15-min signed URL via the Supabase Storage REST API.
 * Returns the absolute URL or null on error.
 *
 * The storage_path is shape-validated before being interpolated
 * into the URL (defense-in-depth against the theoretical
 * path-traversal vector — a row whose storage_path contains `..`
 * or extra segments is rejected here, even though the upload
 * helper never produces such paths). Caller treats null as 404.
 */
async function mintSignedUrl(storagePath) {
  if (!isValidStoragePath(storagePath)) return null
  // Each segment is already shape-validated as hex/extension —
  // safe to interpolate, but encode anyway for belt-and-suspenders.
  const safePath = storagePath.split('/').map(encodeURIComponent).join('/')
  const resp = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/sign/consent-attachments/${safePath}`,
    {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    }
  )
  if (!resp.ok) return null
  const body = await resp.json().catch(() => null)
  // Supabase Storage returns { signedURL: "/object/sign/..." } —
  // a relative path. Prepend the storage base.
  if (!body || !body.signedURL) return null
  return `${process.env.SUPABASE_URL}/storage/v1${body.signedURL}`
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

const NOT_FOUND_BODY = JSON.stringify({ error: 'Not found' })
const NOT_FOUND_RESPONSE_INIT = { status: 404, headers: { 'Content-Type': 'application/json' } }

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // (1) JWT → auth.uid()
    const parent = await verifyAuth(req.headers.get('authorization'))
    if (!parent || !parent.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (2) Parse + validate request shape.
    let attachment_id
    try {
      const body = await req.json()
      attachment_id = body && body.attachment_id
    } catch {
      return new Response(JSON.stringify({ error: 'Malformed request body' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (!attachment_id || typeof attachment_id !== 'string') {
      return new Response(JSON.stringify({ error: 'attachment_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (3) Resolve the attachment row (active only). 404 if absent —
    // do NOT 200 + null; the response shape distinguishes auth from
    // existence.
    const attResp = await supabaseRequest(
      `consent_attachments?id=eq.${encodeURIComponent(attachment_id)}&archived_at=is.null&select=id,target_type,target_id,storage_path&limit=1`,
      'GET'
    )
    const attRows = await attResp.json().catch(() => null)
    const attachment = Array.isArray(attRows) && attRows.length > 0 ? attRows[0] : null
    if (!attachment) {
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (4) Resolve the attachment → underlying child_id via the
    // three resolution paths from the scope doc §8 step 3.
    const childId = await resolveChildIdFromAttachment(attachment)
    if (!childId) {
      // Underlying consent unresolvable, archived, or with a
      // non-child subject_type (caregiver/family/provider/NULL).
      // Anti-enumeration: 404 same as the existence-deny case.
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (5) THE CROSS-TENANT BOUNDARY — parent_family_links check.
    // A parent NOT actively linked to the resolved child's family
    // is denied. The scope doc's verification gate (Test 4) proves
    // this with a real second parent on a different family.
    const linked = await parentIsLinkedToChild({
      parentUserId: parent.id,
      childId,
    })
    if (!linked) {
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (6) Mint the signed URL — only reaches this line after every
    // check above passed.
    const signedUrl = await mintSignedUrl(attachment.storage_path)
    if (!signedUrl) {
      return new Response(JSON.stringify({ error: 'Could not mint signed URL' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({
        signedUrl,
        expires_in_seconds: SIGNED_URL_TTL_SECONDS,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    // Defensive — any unhandled error returns 500 with a generic
    // message. Do NOT echo the error message (it could leak query
    // details).
    console.error('consent-attachment-url: unhandled error', err)
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}

// -----------------------------------------------------------------------------
// Exports for unit testing
// -----------------------------------------------------------------------------
//
// The handler runs against real auth + a real Supabase project; it
// can't be unit-tested cleanly in vitest (no JWT issuer, no service
// role available locally without secrets). But the pure resolution
// logic — "given an attachment row shape, which subject branch
// should we follow" — IS testable in isolation. Exported here so a
// sibling .test.js can exercise it without needing to mount the
// whole Edge runtime.
//
// resolveChildIdFromAttachment is async (touches Supabase REST) so
// it isn't pure — wrapping it for tests requires a Supabase mock,
// which the Edge runtime makes awkward. Tests instead exercise the
// JS-pure branch-decision function below.
export const _internals_for_test = {
  /**
   * Pure mirror of the JS branching in
   * resolveChildIdFromAttachment — given an attachment row + the
   * already-fetched ack row + the already-fetched med_auth row,
   * return the resolved child_id or null. The async function above
   * is the same logic glued to Supabase queries.
   */
  isValidStoragePath,
  resolveChildIdSync({ attachment, ack, medAuth }) {
    if (!attachment) return null
    const { target_type } = attachment

    if (target_type === 'acknowledgment') {
      if (!ack || ack.archived_at) return null
      if (ack.subject_type === 'child') return ack.subject_id || null
      if (ack.subject_type === 'medication_authorization') {
        if (!medAuth || medAuth.archived_at) return null
        return medAuth.child_id || null
      }
      return null
    }

    if (target_type === 'medication_authorization') {
      if (!medAuth || medAuth.archived_at) return null
      return medAuth.child_id || null
    }

    return null
  },
}
