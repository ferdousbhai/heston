import { Type } from 'typebox'

export const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'
export const ISO_DATE_REGEX = new RegExp(ISO_DATE_PATTERN)
export const IsoDateType = Type.String({ pattern: ISO_DATE_PATTERN })

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10)
}

/** Validate both the wire shape and the actual Gregorian calendar date. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/**
 * The closed set of renderings a page may use for one calendar date. Provenance
 * matching compares against these and nothing else: a wider net (bare day numbers,
 * two-digit years) matches unrelated dates on a page that lists many, and a narrower
 * one rejects sources that simply spell the month out.
 */
export function isoDateRenderings(date: string): string[] {
  if (!isValidIsoDate(date)) return []
  const [year, month, day] = date.split('-').map(Number)
  const monthName = MONTHS[month - 1]!
  const short = monthName.slice(0, 3)
  const padded = String(day).padStart(2, '0')
  const paddedMonth = String(month).padStart(2, '0')
  return [
    date,
    `${monthName} ${day}, ${year}`,
    `${monthName} ${day} ${year}`,
    `${short} ${day}, ${year}`,
    `${short} ${day} ${year}`,
    `${day} ${monthName} ${year}`,
    `${day} ${short} ${year}`,
    `${padded} ${monthName} ${year}`,
    `${month}/${day}/${year}`,
    `${paddedMonth}/${padded}/${year}`,
  ]
}

/**
 * A multi-day event renders as a range — "September 22-24, 2026", "August 31 - September 3,
 * 2026" — which no single rendering matches, and conferences are most of the catalyst
 * calendar. The month and day still have to be present, and the year has to follow close
 * enough to be plainly part of the same date rather than another one further down the page.
 */
const DATE_PROXIMITY_CHARS = 60

/** Case- and whitespace-insensitive: served HTML wraps and pads dates unpredictably. */
export function textMentionsIsoDate(text: string, date: string): boolean {
  if (!isValidIsoDate(date)) return false
  const haystack = text.replace(/\s+/g, ' ')
  const lowered = haystack.toLowerCase()
  if (isoDateRenderings(date).some((rendering) => lowered.includes(rendering.toLowerCase()))) {
    return true
  }
  const [year, month, day] = date.split('-').map(Number)
  const monthName = MONTHS[month - 1]!
  const spelled = spelledMonthDay(monthName, day)
  const nearbyYear = new RegExp(`\\b${year}\\b`)
  for (const match of haystack.matchAll(spelled)) {
    if (nearbyYear.test(haystack.slice(match.index, match.index + DATE_PROXIMITY_CHARS))) return true
  }
  return false
}

/** "September 9", "Sept. 9", "September 9th" — the month-day core every rendering shares. */
function spelledMonthDay(monthName: string, day: number): RegExp {
  // September is the one month reporting abbreviates to four letters as often as three.
  const forms = [monthName, ...(monthName.toLowerCase() === 'september' ? ['sept'] : []), monthName.slice(0, 3)]
  return new RegExp(`\\b(?:${forms.join('|')})\\.?\\s+0?${day}(?:st|nd|rd|th)?\\b`, 'gi')
}

/**
 * Reporting routinely prints an upcoming date without its year — "Sept. 9" for an event next
 * week — and demanding the year rejected real findings a live run read. Inside a horizon
 * shorter than a year a month-day names exactly one date, so when the claimed date falls
 * within [today, horizon] the year is redundant; a different year printed beside the mention
 * still refuses the match, so "September 9, 2025" cannot vouch for 2026-09-09.
 */
export function textMentionsDateWithinHorizon(
  text: string,
  date: string,
  today: string,
  horizon: string,
): boolean {
  if (textMentionsIsoDate(text, date)) return true
  if (!isValidIsoDate(date) || date < today || date > horizon) return false
  const haystack = text.replace(/\s+/g, ' ')
  const [, month, day] = date.split('-').map(Number)
  const anyYear = /\b(?:19|20)\d{2}\b/
  for (const match of haystack.matchAll(spelledMonthDay(MONTHS[month! - 1]!, day!))) {
    if (!anyYear.test(haystack.slice(match.index, match.index + DATE_PROXIMITY_CHARS))) return true
  }
  return false
}
