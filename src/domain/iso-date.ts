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
