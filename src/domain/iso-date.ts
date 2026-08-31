import { Type } from 'typebox'

export const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'
export const ISO_DATE_REGEX = new RegExp(ISO_DATE_PATTERN)
export const IsoDateType = Type.String({ pattern: ISO_DATE_PATTERN })

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
  const spelled = new RegExp(`\\b(?:${monthName}|${monthName.slice(0, 3)})\\.?\\s+0?${day}\\b`, 'gi')
  const nearbyYear = new RegExp(`\\b${year}\\b`)
  for (const match of haystack.matchAll(spelled)) {
    if (nearbyYear.test(haystack.slice(match.index, match.index + DATE_PROXIMITY_CHARS))) return true
  }
  return false
}
