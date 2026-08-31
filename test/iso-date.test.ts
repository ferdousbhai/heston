import { describe, expect, it } from 'vitest'
import { Compile } from 'typebox/compile'

import { IsoDateType, isValidIsoDate } from '../src/domain/iso-date'

describe('ISO date contract', () => {
  it.each([
    '2024-02-29',
    '2026-08-30',
  ])('accepts the real calendar date %s', (value) => {
    expect(isValidIsoDate(value)).toBe(true)
  })

  it.each([
    '2026-02-29',
    '2026-04-31',
    '2026-8-30',
    'not-a-date',
  ])('rejects the malformed or impossible date %s', (value) => {
    expect(isValidIsoDate(value)).toBe(false)
  })

  it('advertises the wire shape while semantic validation checks the calendar', () => {
    const validator = Compile(IsoDateType)

    expect(validator.Check('2026-02-30')).toBe(true)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
  })
})
