// ─── Billing logic ─────────────────────────────────────────────
//
// Pure functions for computing invoice periods and amounts based on a family's
// billing configuration. No supabase calls, no side effects — just math.

// ─── Date helpers ──────────────────────────────────────

export function ymd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseYMD(s) {
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
  const a = new Date(later.getFullYear(), later.getMonth(), later.getDate())
  const b = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())
  return Math.round((a - b) / (1000 * 60 * 60 * 24))
}

export function startOfWeek(date, startDay = 1) {
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

// Find the most recent occurrence of `weekday` on or before `date`
function backUpToWeekday(date, weekday) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (d.getDay() - weekday + 7) % 7
  d.setDate(d.getDate() - offset)
  return d
}

// ─── Frequency normalization ───────────────────────────

export function getCycleWeeks(family) {
  switch (family.billing_frequency) {
    case 'weekly':   return 1
    case 'biweekly': return 2
    case 'custom':   return family.billing_frequency_weeks || 1
    case 'monthly':
      return family.billing_monthly_mode === 'four_weeks' ? 4 : null
    default:         return 1
  }
}

// ─── Compute the period covered by the NEXT invoice ────

/**
 * Returns { start_date, end_date, weeks, weeks_label, prorated_days, isDue }
 *
 * Honors:
 * - billing_cycle_start_day: 0–6, what day of week cycles begin (for weekly/biweekly/custom)
 * - billing_cycle_end_day: 0–6, OPTIONAL override of the cycle end day. If set,
 *   the period_end is rolled back to the most recent occurrence of that weekday
 *   that falls within the full 7×weeks cycle. If null, period_end = start + 7×weeks - 1.
 * - billing_cycle_anchor_date: optional explicit cycle anchor
 * - billing_monthly_mode: 'calendar' or 'four_weeks'
 * - billing_partial_week_mode: 'full_rate' or 'prorate'
 */
export function getNextInvoicePeriod(family, today, lastInvoicePeriodEnd = null) {
  const freq = family.billing_frequency || 'weekly'
  const partialMode = family.billing_partial_week_mode || 'full_rate'
  const endDayOverride = (family.billing_cycle_end_day !== null && family.billing_cycle_end_day !== undefined)
    ? family.billing_cycle_end_day
    : null

  // Anchor: where the cycle math starts
  let cycleStart
  if (lastInvoicePeriodEnd) {
    cycleStart = addDays(parseYMD(lastInvoicePeriodEnd), 1)
  } else if (family.billing_cycle_anchor_date) {
    cycleStart = parseYMD(family.billing_cycle_anchor_date)
  } else {
    if (freq === 'monthly') {
      cycleStart = startOfMonth(today)
    } else {
      cycleStart = startOfWeek(today, family.billing_cycle_start_day ?? 1)
    }
  }

  let cycleEnd
  let weeks
  let weeksLabel
  let proratedDays = null

  if (freq === 'weekly' || freq === 'biweekly' || freq === 'custom') {
    const cycleWeeks = getCycleWeeks(family)
    // Advance cycleStart in cycleWeeks×7 jumps until cycleEnd >= today
    // eslint-disable-next-line no-constant-condition -- walk-cycles-until-break idiom
    while (true) {
      const fullCycleEnd = addDays(cycleStart, cycleWeeks * 7 - 1)
      // Apply end-day override: roll back to the most recent occurrence of end_day
      // within the cycle. If the override falls outside the cycle, just use full end.
      let candidateEnd
      if (endDayOverride !== null) {
        const rolled = backUpToWeekday(fullCycleEnd, endDayOverride)
        // Only honor the override if rolling back doesn't push us before cycleStart
        candidateEnd = (rolled >= cycleStart) ? rolled : fullCycleEnd
      } else {
        candidateEnd = fullCycleEnd
      }

      if (candidateEnd >= today) {
        cycleEnd = candidateEnd
        break
      }
      cycleStart = addDays(cycleStart, cycleWeeks * 7)
    }
    weeks = cycleWeeks
    weeksLabel = cycleWeeks === 1 ? '1 week' : `${cycleWeeks} weeks`

    if (partialMode === 'prorate' && lastInvoicePeriodEnd === null && family.billing_cycle_anchor_date) {
      const anchor = parseYMD(family.billing_cycle_anchor_date)
      if (diffDays(anchor, cycleStart) > 0) {
        cycleStart = anchor
        proratedDays = diffDays(cycleEnd, cycleStart) + 1
        weeks = proratedDays / 7
        weeksLabel = `${proratedDays} day${proratedDays === 1 ? '' : 's'} (prorated)`
      }
    }
  } else if (freq === 'monthly') {
    if (family.billing_monthly_mode === 'four_weeks') {
      const cycleDays = 28
      // eslint-disable-next-line no-constant-condition -- walk-cycles-until-break idiom
      while (true) {
        const fullEnd = addDays(cycleStart, cycleDays - 1)
        let candidateEnd
        if (endDayOverride !== null) {
          const rolled = backUpToWeekday(fullEnd, endDayOverride)
          candidateEnd = (rolled >= cycleStart) ? rolled : fullEnd
        } else {
          candidateEnd = fullEnd
        }
        if (candidateEnd >= today) {
          cycleEnd = candidateEnd
          break
        }
        cycleStart = addDays(cycleStart, cycleDays)
      }
      weeks = 4
      weeksLabel = '4 weeks'
    } else {
      // Calendar month — end day override doesn't really apply here
      cycleStart = startOfMonth(today)
      cycleEnd = endOfMonth(today)
      const days = diffDays(cycleEnd, cycleStart) + 1
      weeks = days / 7
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

export function shouldGenerateNextInvoice(family, today, lastInvoicePeriodEnd = null) {
  const period = getNextInvoicePeriod(family, today, lastInvoicePeriodEnd)
  const cycleStart = parseYMD(period.start_date)
  if (cycleStart > today) {
    return { shouldGenerate: false, period }
  }
  return { shouldGenerate: true, period }
}

export function computeInvoiceAmount(weeklyRate, weeks) {
  const rate = parseFloat(weeklyRate) || 0
  return Math.round(rate * weeks * 100) / 100
}

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
  const endDay = (family.billing_cycle_end_day !== null && family.billing_cycle_end_day !== undefined)
    ? dayNames[family.billing_cycle_end_day]
    : null
  const endSuffix = endDay ? `, ends ${endDay}` : ''
  switch (freq) {
    case 'weekly':   return `Weekly, cycle starts ${startDay}${endSuffix}`
    case 'biweekly': return `Bi-weekly (every 2 weeks), starts ${startDay}${endSuffix}`
    case 'monthly':
      return family.billing_monthly_mode === 'four_weeks'
        ? `Monthly (every 4 weeks)${endSuffix}`
        : 'Monthly (calendar month)'
    case 'custom':
      return `Every ${family.billing_frequency_weeks || 1} weeks, starts ${startDay}${endSuffix}`
    default:         return 'Weekly'
  }
}

// ─── Compute invoice due date based on provider's policy ────

/**
 * Compute when an invoice should be due based on provider settings + cycle dates.
 *
 * @param policies - business_policies row (may have default_invoice_due_offset_days, default_invoice_due_anchor)
 * @param period - { start_date, end_date } from getNextInvoicePeriod
 * @param generateDate - JS Date when invoice is being generated (today)
 * @returns 'YYYY-MM-DD' due date string
 */
export function computeDueDate(policies, period, generateDate) {
  const offsetDays = (policies?.default_invoice_due_offset_days != null)
    ? policies.default_invoice_due_offset_days
    : 7
  const anchor = policies?.default_invoice_due_anchor || 'generate_date'

  let baseDate
  if (anchor === 'period_start') {
    baseDate = parseYMD(period.start_date)
  } else if (anchor === 'period_end') {
    baseDate = parseYMD(period.end_date)
  } else {
    // 'generate_date' or any unknown value → today
    baseDate = new Date(generateDate.getFullYear(), generateDate.getMonth(), generateDate.getDate())
  }

  return ymd(addDays(baseDate, offsetDays))
}
