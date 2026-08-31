import { describe, expect, it } from 'vitest'

import { nextDailyResearchRun, shouldStartDailyResearch } from '../src/domain/research-schedule'

describe('daily research schedule', () => {
  it('resolves the next weekday run in New York time', () => {
    expect(nextDailyResearchRun(new Date('2026-08-29T12:00:00.000Z')).toISOString())
      .toBe('2026-08-31T13:30:00.000Z')
    expect(nextDailyResearchRun(new Date('2026-08-31T12:00:00.000Z')).toISOString())
      .toBe('2026-08-31T13:30:00.000Z')
    expect(nextDailyResearchRun(new Date('2026-08-31T13:31:00.000Z')).toISOString())
      .toBe('2026-09-01T13:30:00.000Z')
  })

  it('follows daylight-saving changes without changing the New York wall time', () => {
    const winterRun = nextDailyResearchRun(new Date('2026-12-12T12:00:00.000Z'))
    expect(winterRun.toISOString()).toBe('2026-12-14T14:30:00.000Z')
    expect(shouldStartDailyResearch(winterRun)).toBe(true)
  })
})
