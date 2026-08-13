import { describe, expect, it } from 'vitest'

import { shouldRunDailyResearch } from '../src/server/research'

describe('daily research schedule', () => {
  it('runs at 09:30 New York time during daylight saving time', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-13T14:30:00.000Z'))).toBe(false)
  })

  it('runs at 09:30 New York time during standard time', () => {
    expect(shouldRunDailyResearch(new Date('2026-12-14T14:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-12-14T13:30:00.000Z'))).toBe(false)
  })

  it('does not generate weekend issues', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-15T13:30:00.000Z'))).toBe(false)
  })
})
