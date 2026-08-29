import { describe, expect, it } from 'vitest'

import { newYorkClock } from '../src/domain/market-clock'

describe('dynamic Dan time context', () => {
  it('uses New York wall time across daylight saving time', () => {
    expect(newYorkClock(new Date('2026-08-14T14:05:06.000Z'))).toMatchObject({
      localDate: '2026-08-14', localTime: '10:05:06', timeZone: 'America/New_York', weekday: 'Friday',
    })
    expect(newYorkClock(new Date('2026-01-14T14:05:06.000Z')).localTime).toBe('09:05:06')
  })
})
