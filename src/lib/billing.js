// ─── Billing logic ─────────────────────────────────────────────
//
// Pure functions for computing invoice periods and amounts based on a family's
// billing configuration. No supabase calls, no side effects — just math.
//
// Family billing fields used:
//   billing_type: 'weekly' | 'hourly'  (legacy field — distinguishes flat-rate vs hourly)
//   weekly_rate: numeric
//   billing_frequency: 'weekly' | 'biweekly' | 'monthly' | 'custom'
//   billing_frequency_weeks: integer (only for 'custom')
//   billing_cycle_start_day: 0–6 (0=Sun, 1=Mon, ..., 6=Sat)
//   billing_cycle_anchor_date: 'YYYY-MM-DD' or null
//   billing_monthly_mode: 'calendar' | 'four_weeks'
//   billing_partial_week_mode: 'full_rate' | 'prorate'

// ─── Date helpers ──────────────────────────────────────

export function ymd(d) {
  // Format a Date as YYYY-MM-DD, local time
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseYMD(s) {
  // Parse YYYY-MM-DD as local date (not UTC)
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

export function diffDays(later, earlier) {
  // Whole-day difference; ignores time portion
  const a = new Date(later.getFullYear(), later.getMonth(), later.getDate())
  const b = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())
  return Math.round((a - b) / (1000 * 60 * 60 * 24))
}

export function startOfWeek(date, startDay = 1) {
  // Return the Date that is the start of the cycle week containing `date`
  // startDay: 0=Sun ... 6=Sat
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (d.getDay() - startDay + 7) % 7
  d.setDate(d.getDate() - offset)
  return d
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

// ─── Frequency normalization ───────────────────────────

export function getCycleWeeks(family) {
  // Returns the number of weeks per billing cycle
  // For monthly, returns null (because months vary)
  switch (family.billing_frequency) {
    case 'weekly':   return 1
    case 'biweekly': return 2
    case 'custom':   return family.billing_frequency_weeks || 1
    case 'monthly':
      return family.billing_monthly_mode === 'four_weeks' ? 4 : null  // null means "compute from calendar"
    default:         return 1  // legacy fallback
  }
}

// ─── Compute the period covered by the NEXT invoice ────

/**
 * Given a family and a "today" date, compute the next invoice period.
 *
 * The logic finds the cycle whose period_start is the most recent cycle boundary
 * that is BEFORE OR EQUAL TO today, then returns the period covering that cycle.
 *
 * If `lastInvoicePeriodEnd` is provided (the period_end of the most recent invoice
 * for this family), the returned period will start the day AFTER that, so we don't
 * double-bill or skip days.
 *
 * Returns { start_date, end_date, weeks, weeks_label, prorated_days, isDue }
 * - start_date / end_date: 'YYYY-MM-DD'
 * - weeks: numeric (e.g., 1, 2, 4, ~4.43)
 * - weeks_label: human-readable ("1 week", "2 weeks", "Nov 2026", etc.)
 * - prorated_days: if partial cycle, number of days; else null
 * - isDue: true if the cycle period_start <= today
 */
export function getNextInvoicePeriod(family, today, lastInvoicePeriodEnd = null) {
  const freq = family.billing_frequency || 'weekly'
  const partialMode = family.billing_partial_week_mode || 'full_rate'

  // Anchor: where the cycle math starts. Priority:
  //   1. The day after the last invoice (if provided)
  //   2. The family's anchor date (if set)
  //   3. The most recent cycle-start-day on/before today
  let cycleStart
  if (lastInvoicePeriodEnd) {
    cycleStart = addDays(parseYMD(lastInvoicePeriodEnd), 1)
  } else if (family.billing_cycle_anchor_date) {
    cycleStart = parseYMD(family.billing_cycle_anchor_date)
  } else {
    // Default: most recent cycle-start day on or before today
    if (freq === 'monthly') {
      cycleStart = startOfMonth(today)
    } else {
      cycleStart = startOfWeek(today, family.billing_cycle_start_day ?? 1)
    }
  }

  // For non-weekly cycles, advance cycleStart forward in cycles until we find
  // the cycle that *contains* today (or is the current "due" cycle).
  // This handles the case where the anchor is far in the past.
  let cycleEnd
  let weeks
  let weeksLabel
  let proratedDays = null

  if (freq === 'weekly' || freq === 'biweekly' || freq === 'custom') {
    const cycleWeeks = getCycleWeeks(family)
    // Advance cycleStart in `cycleWeeks` jumps until cycleStart + cycleWeeks > today
    while (true) {
      const tentativeEnd = addDays(cycleStart, cycleWeeks * 7 - 1)
      if (tentativeEnd >= today) {
        cycleEnd = tentativeEnd
        break
      }
      cycleStart = addDays(cycleStart, cycleWeeks * 7)
    }
    weeks = cycleWeeks
    weeksLabel = cycleWeeks === 1 ? '1 week' : `${cycleWeeks} weeks`

    // Prorating: if this is the FIRST invoice for the family AND they're not aligned
    // to a full cycle, we may want to prorate. But that's an edge case and we'll
    // handle it explicitly only when partial_week_mode='prorate'.
    // For now, full_rate behaviour returns the full cycle; prorate would need extra
    // anchor info to know "started on day X of cycle." We'll trust the anchor_date
    // to mean "first day of care."
    if (partialMode === 'prorate' && lastInvoicePeriodEnd === null && family.billing_cycle_anchor_date) {
      // First invoice — if anchor isn't aligned to cycleStart, the first cycle is partial
      const anchor = parseYMD(family.billing_cycle_anchor_date)
      if (diffDays(anchor, cycleStart) > 0) {
        // Anchor is mid-cycle: charge from anchor → cycleEnd
        cycleStart = anchor
        proratedDays = diffDays(cycleEnd, cycleStart) + 1
        weeks = proratedDays / 7
        weeksLabel = `${proratedDays} day${proratedDays === 1 ? '' : 's'} (prorated)`
      }
    }
  } else if (freq === 'monthly') {
    if (family.billing_monthly_mode === 'four_weeks') {
      // 28-day cycles starting from anchor
      const cycleDays = 28
      while (true) {
        const tentativeEnd = addDays(cycleStart, cycleDays - 1)
        if (tentativeEnd >= today) {
          cycleEnd = tentativeEnd
          break
        }
        cycleStart = addDays(cycleStart, cycleDays)
      }
      weeks = 4
      weeksLabel = '4 weeks'
    } else {
      // Calendar month
      cycleStart = startOfMonth(today)
      cycleEnd = endOfMonth(today)
      const days = diffDays(cycleEnd, cycleStart) + 1
      weeks = days / 7  // e.g., ~4.29 for Feb, ~4.43 for 31-day months
      const monthName = today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      weeksLabel = monthName
    }
  }

  const isDue = cycleStart <= today

  return {
    start_date: ymd(cycleStart),
    end_date: ymd(cycleEnd),
    weeks,
    weeks_label: weeksLabel,
    prorated_days: proratedDays,
    isDue,
  }
}

// ─── Decide whether to generate an invoice now ────

/**
 * Returns whether a new invoice should be generated for this family right now,
 * AND what that invoice's period would be.
 *
 * Rules:
 * - If no prior invoice for this family: generate one for the cycle containing today
 *   (or starting at the anchor date, if anchor is in the future).
 * - If a prior invoice exists: generate one for the cycle AFTER the last invoice's
 *   period_end, but only if that cycle's start <= today.
 *
 * Returns { shouldGenerate, period }
 */
export function shouldGenerateNextInvoice(family, today, lastInvoicePeriodEnd = null) {
  const period = getNextInvoicePeriod(family, today, lastInvoicePeriodEnd)
  // If the next cycle starts in the future, don't generate yet
  const cycleStart = parseYMD(period.start_date)
  if (cycleStart > today) {
    return { shouldGenerate: false, period }
  }
  return { shouldGenerate: true, period }
}

// ─── Compute invoice amount ────

/**
 * Returns the dollar amount for an invoice given the family's weekly rate
 * and the period's weeks count.
 */
export function computeInvoiceAmount(weeklyRate, weeks) {
  const rate = parseFloat(weeklyRate) || 0
  return Math.round(rate * weeks * 100) / 100  // round to nearest cent
}

// ─── Build the line item description ────

export function buildLineItemDescription(family, period) {
  const freq = family.billing_frequency || 'weekly'
  const dateRange = `${formatDateShort(period.start_date)} – ${formatDateShort(period.end_date)}`

  if (freq === 'monthly' && family.billing_monthly_mode === 'calendar') {
    return `Tuition — ${period.weeks_label} (${dateRange})`
  }
  if (period.prorated_days) {
    return `Tuition — ${period.weeks_label} ${dateRange}`
  }
  return `Tuition — ${period.weeks_label} (${dateRange})`
}

function formatDateShort(ymdStr) {
  const d = parseYMD(ymdStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Display helpers for UI previews ────

export function describeFrequency(family) {
  const freq = family.billing_frequency || 'weekly'
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const startDay = dayNames[family.billing_cycle_start_day ?? 1]
  switch (freq) {
    case 'weekly':   return `Weekly, cycle starts ${startDay}`
    case 'biweekly': return `Bi-weekly (every 2 weeks), cycle starts ${startDay}`
    case 'monthly':
      return family.billing_monthly_mode === 'four_weeks'
        ? 'Monthly (every 4 weeks)'
        : 'Monthly (calendar month)'
    case 'custom':
      return `Every ${family.billing_frequency_weeks || 1} weeks, cycle starts ${startDay}`
    default:         return 'Weekly'
  }
}
