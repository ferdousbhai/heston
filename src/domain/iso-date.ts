import { Type } from 'typebox'
import { z } from 'zod'

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

/**
 * The one zod spelling of a calendar date. `isValidIsoDate` tests the wire pattern before the
 * calendar, so a schema using this needs no `.regex()` of its own.
 */
export const IsoDateSchema = z.string().refine(isValidIsoDate, 'Use a real YYYY-MM-DD date')

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
function isoDateRenderings(date: string): string[] {
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

/**
 * One rendering as a whole date rather than a substring of one. A bare `includes` let
 * "11/5/2026" vouch for 1/5/2026, "21 September 2026" for 1 September 2026, and
 * "2026-01-050" for 2026-01-05: a date is not bound by a longer number that happens to end or
 * begin with it. A letter or slash before the rendering, or a digit after it, is that longer
 * number or word.
 */
function renderingPattern(rendering: string): RegExp {
  const escaped = rendering.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![0-9A-Za-z/])${escaped}(?![0-9])`, 'i')
}

/** Case- and whitespace-insensitive: served HTML wraps and pads dates unpredictably. */
export function textMentionsIsoDate(text: string, date: string): boolean {
  if (!isValidIsoDate(date)) return false
  const haystack = text.replace(/\s+/g, ' ')
  if (isoDateRenderings(date).some((rendering) => renderingPattern(rendering).test(haystack))) {
    return true
  }
  const [year, month, day] = date.split('-').map(Number)
  const monthName = MONTHS[month - 1]!
  const spelled = spelledMonthDay(monthName, day)
  for (const match of haystack.matchAll(spelled)) {
    // The year that binds is the first one printed after the mention — the date's own year, or
    // a range's closing year. A later year in the window belongs to another date: "September 9,
    // 2025; the 2026 date is not yet set" does not vouch for 2026-09-09.
    const printed = PRINTED_YEAR.exec(haystack.slice(match.index, match.index + DATE_PROXIMITY_CHARS))
    if (printed && Number(printed[0]) === year) return true
  }
  return false
}

/** A four-digit year as reporting prints one; the horizon matcher uses the same shape. */
const PRINTED_YEAR = /\b(?:19|20)\d{2}\b/

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
 * within [today, horizon] the year is redundant. A different year printed beside the mention,
 * on either side, still refuses the match: "September 9, 2025" and "In 2025, on September 9"
 * are both about another year and cannot vouch for 2026-09-09.
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
  const [year, month, day] = date.split('-').map(Number)
  const printedYears = new RegExp(PRINTED_YEAR.source, 'g')
  for (const match of haystack.matchAll(spelledMonthDay(MONTHS[month! - 1]!, day!))) {
    if (PRINTED_YEAR.test(haystack.slice(match.index, match.index + DATE_PROXIMITY_CHARS))) continue
    const before = haystack.slice(Math.max(0, match.index - DATE_PROXIMITY_CHARS), match.index)
    if ([...before.matchAll(printedYears)].some(([printed]) => Number(printed) !== year)) continue
    return true
  }
  return false
}
