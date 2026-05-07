import { useState } from 'react'
import { Download, Loader } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import * as XLSX from 'xlsx'

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTimeDisplay(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour24 = parseInt(h)
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24
  const ampm = hour24 >= 12 ? 'PM' : 'AM'
  return `${hour12}:${m} ${ampm}`
}

function calcHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0
  const [ih, im] = checkIn.split(':').map(Number)
  const [oh, om] = checkOut.split(':').map(Number)
  const mins = (oh * 60 + om) - (ih * 60 + im)
  return mins > 0 ? mins / 60 : 0
}

// Translate the checked_in_by value into something licensing-friendly
function certificationLabel(checkedInBy) {
  if (checkedInBy === 'parent') return 'Yes — recorded by parent'
  if (checkedInBy === 'provider') return 'Provider-recorded'
  return ''
}

/**
 * AttendanceExportButton — produces an Excel workbook of attendance records.
 *
 * Built to satisfy Michigan BEM 706 record-keeping requirements:
 * - Each child's actual begin and end time
 * - Daily certification by parent/substitute parent
 * - Provider name + business
 * - 4-year retention (system retains in DB indefinitely)
 *
 * Output sheets:
 * - Cover (provider info, date range, generated date, signature block)
 * - Summary (per-child totals + grand total + signature block)
 * - Detail (every record, including parent certification status + signature block)
 */
export default function AttendanceExportButton({ licenseeId, businessName, providerName }) {
  const [open, setOpen] = useState(false)
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return ymd(d)
  })
  const [endDate, setEndDate] = useState(() => ymd(new Date()))
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(null)

  const doExport = async () => {
    setExporting(true)
    setError(null)
    try {
      const [attendanceResp, childrenResp, familiesResp] = await Promise.all([
        supabase
          .from('attendance')
          .select('*')
          .eq('user_id', licenseeId)
          .gte('date', startDate)
          .lte('date', endDate)
          .order('date', { ascending: true }),
        supabase
          .from('children')
          .select('id, first_name, last_name, family_id, date_of_birth')
          .eq('user_id', licenseeId),
        supabase
          .from('families')
          .select('id, family_name')
          .eq('user_id', licenseeId),
      ])

      if (attendanceResp.error) throw attendanceResp.error
      if (childrenResp.error) throw childrenResp.error
      if (familiesResp.error) throw familiesResp.error

      const attendance = attendanceResp.data || []
      const children = childrenResp.data || []
      const families = familiesResp.data || []

      const childMap = Object.fromEntries(children.map(c => [c.id, c]))
      const familyMap = Object.fromEntries(families.map(f => [f.id, f]))

      // ─── Build detail rows ─────────────────────────────
      const detailRows = attendance.map(a => {
        const child = childMap[a.child_id]
        const family = child ? familyMap[child.family_id] : null
        const hours = calcHours(a.check_in, a.check_out)
        return {
          'Date': a.date,
          'Day': new Date(a.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
          'Child': child ? `${child.first_name} ${child.last_name || ''}`.trim() : '(unknown)',
          'Family': family?.family_name || '(unknown)',
          'Status': a.status || 'present',
          'Check In': a.check_in ? formatTimeDisplay(a.check_in) : '',
          'Check Out': a.check_out ? formatTimeDisplay(a.check_out) : '',
          'Hours': hours > 0 ? Math.round(hours * 100) / 100 : '',
          'Certified by Parent': certificationLabel(a.checked_in_by),
          'Dropped Off By': a.checked_in_by || '',
          'Picked Up By': a.checked_out_by || '',
        }
      })

      // ─── Build summary rows (per child totals) ────────
      const summaryByChild = {}
      attendance.forEach(a => {
        const child = childMap[a.child_id]
        if (!child) return
        const key = child.id
        if (!summaryByChild[key]) {
          const family = familyMap[child.family_id]
          summaryByChild[key] = {
            'Child': `${child.first_name} ${child.last_name || ''}`.trim(),
            'Family': family?.family_name || '(unknown)',
            'Days Present': 0,
            'Days Absent': 0,
            'Total Hours': 0,
          }
        }
        const status = a.status || 'present'
        if (status === 'absent') {
          summaryByChild[key]['Days Absent']++
        } else {
          if (a.check_in) summaryByChild[key]['Days Present']++
          summaryByChild[key]['Total Hours'] += calcHours(a.check_in, a.check_out)
        }
      })
      const summaryRows = Object.values(summaryByChild).map(r => ({
        ...r,
        'Total Hours': Math.round(r['Total Hours'] * 100) / 100,
      }))

      const totalsRow = {
        'Child': 'TOTAL',
        'Family': '',
        'Days Present': summaryRows.reduce((s, r) => s + r['Days Present'], 0),
        'Days Absent': summaryRows.reduce((s, r) => s + r['Days Absent'], 0),
        'Total Hours': Math.round(summaryRows.reduce((s, r) => s + r['Total Hours'], 0) * 100) / 100,
      }
      summaryRows.push(totalsRow)

      // ─── Build cover sheet ────────────────────────────
      const coverRows = [
        { Field: 'Attendance Report', Value: '' },
        { Field: '', Value: '' },
        { Field: 'Provider', Value: providerName || '' },
        { Field: 'Business', Value: businessName || '' },
        { Field: '', Value: '' },
        { Field: 'Period Start', Value: startDate },
        { Field: 'Period End', Value: endDate },
        { Field: 'Total Records', Value: attendance.length },
        { Field: '', Value: '' },
        { Field: 'Generated', Value: new Date().toLocaleString() },
        { Field: 'Generated By', Value: 'MI Little Care' },
        { Field: '', Value: '' },
        { Field: '', Value: '' },
        { Field: 'Compliance Notes', Value: '' },
        { Field: '', Value: 'Records satisfy Michigan BEM 706 record-keeping requirements:' },
        { Field: '', Value: 'each child\'s actual begin/end times, retained for at least 4 years.' },
        { Field: '', Value: 'Parent/substitute parent certification (where applicable)' },
        { Field: '', Value: 'is shown in the Detail sheet.' },
      ]

      // ─── Signature block — appended to bottom of every sheet ────
      const signatureBlock = [
        { col1: '', col2: '' },
        { col1: '', col2: '' },
        { col1: 'Provider Certification', col2: '' },
        { col1: 'I certify the above attendance records are accurate and complete.', col2: '' },
        { col1: '', col2: '' },
        { col1: 'Provider Signature: ____________________________________', col2: '' },
        { col1: 'Date: __________________', col2: '' },
        { col1: '', col2: '' },
        { col1: '', col2: '' },
        { col1: 'Parent/Substitute Parent Certification', col2: '' },
        { col1: 'I certify the attendance times for my child(ren) are accurate.', col2: '' },
        { col1: '', col2: '' },
        { col1: 'Parent Signature: ______________________________________', col2: '' },
        { col1: 'Print Name: ___________________________________________', col2: '' },
        { col1: 'Date: __________________', col2: '' },
      ]

      // ─── Build workbook ────────────────────────────────
      const workbook = XLSX.utils.book_new()

      // Cover sheet — coverRows + signature block
      const coverSheetData = [
        ...coverRows.map(r => ({ Field: r.Field, Value: r.Value })),
      ]
      const coverSheet = XLSX.utils.json_to_sheet(coverSheetData, { skipHeader: true })
      // Append signature block manually to bottom
      XLSX.utils.sheet_add_aoa(coverSheet, [
        [],
        [],
        ['Provider Certification'],
        ['I certify the above attendance records are accurate and complete.'],
        [],
        ['Provider Signature: ____________________________________'],
        ['Date: __________________'],
        [],
        [],
        ['Parent/Substitute Parent Certification'],
        ['I certify the attendance times for my child(ren) are accurate.'],
        [],
        ['Parent Signature: ______________________________________'],
        ['Print Name: ___________________________________________'],
        ['Date: __________________'],
      ], { origin: -1 })
      coverSheet['!cols'] = [{ wch: 22 }, { wch: 60 }]
      XLSX.utils.book_append_sheet(workbook, coverSheet, 'Cover')

      // Summary sheet
      const summarySheet = XLSX.utils.json_to_sheet(summaryRows)
      XLSX.utils.sheet_add_aoa(summarySheet, [
        [],
        [],
        ['Provider Signature: ____________________________________', '', '', '', 'Date: __________________'],
        [],
        ['Parent Signature: ______________________________________', '', '', '', 'Date: __________________'],
      ], { origin: -1 })
      summarySheet['!cols'] = [{ wch: 24 }, { wch: 24 }, { wch: 14 }, { wch: 13 }, { wch: 22 }]
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')

      // Detail sheet
      const detailSheet = XLSX.utils.json_to_sheet(detailRows)
      XLSX.utils.sheet_add_aoa(detailSheet, [
        [],
        [],
        ['Provider Signature: ____________________________________', '', '', '', '', '', '', '', 'Date: __________________'],
        [],
        ['Parent Signature: ______________________________________', '', '', '', '', '', '', '', 'Date: __________________'],
      ], { origin: -1 })
      detailSheet['!cols'] = [
        { wch: 12 }, { wch: 6 }, { wch: 24 }, { wch: 24 },
        { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 8 },
        { wch: 22 }, { wch: 14 }, { wch: 14 },
      ]
      XLSX.utils.book_append_sheet(workbook, detailSheet, 'Detail')

      // ─── Download ─────────────────────────────────────
      const filename = `attendance-${startDate}-to-${endDate}.xlsx`
      XLSX.writeFile(workbook, filename)

      setOpen(false)
    } catch (err) {
      setError(err.message || 'Export failed')
    }
    setExporting(false)
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setError(null) }}
        style={{
          background: 'var(--clr-sage-dark)',
          color: 'white',
          border: 'none',
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.8125rem',
          fontWeight: 500,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-body)',
        }}
      >
        <Download size={14} /> Export attendance
      </button>

      {open && (
        <div
          onClick={() => !exporting && setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 20, 17, 0.55)',
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
              width: '100%',
              maxWidth: 460,
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            }}
          >
            <h3 style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.125rem',
              margin: 0,
              marginBottom: 12,
              color: 'var(--clr-ink)',
            }}>
              Export attendance
            </h3>

            <p style={{
              fontSize: '0.875rem',
              color: 'var(--clr-ink-mid)',
              marginTop: 0,
              marginBottom: 16,
              lineHeight: 1.5,
            }}>
              Generates an Excel workbook with summary, detail, and signature lines for parent certification. Built to satisfy Michigan BEM 706 record-keeping requirements.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--clr-ink)', marginBottom: 4 }}>
                  Start date
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={exporting}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid var(--clr-warm-mid)',
                    borderRadius: 'var(--radius-md)',
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.875rem',
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--clr-ink)', marginBottom: 4 }}>
                  End date
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={exporting}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid var(--clr-warm-mid)',
                    borderRadius: 'var(--radius-md)',
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.875rem',
                  }}
                />
              </div>
            </div>

            {error && (
              <div style={{
                padding: '8px 12px',
                background: 'var(--clr-error-pale)',
                color: 'var(--clr-error)',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.8125rem',
                marginBottom: 12,
              }}>
                ⚠ {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setOpen(false)}
                disabled={exporting}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--clr-warm-mid)',
                  color: 'var(--clr-ink-mid)',
                  padding: '10px 16px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.875rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={doExport}
                disabled={exporting || !startDate || !endDate || startDate > endDate}
                style={{
                  background: 'var(--clr-sage-dark)',
                  color: 'white',
                  border: 'none',
                  padding: '10px 20px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {exporting ? <><Loader size={14} className="spin" /> Exporting…</> : <><Download size={14} /> Export</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
