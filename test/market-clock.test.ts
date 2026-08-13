import { describe, expect, it } from 'vitest'

import { newYorkClock } from '../src/domain/market-clock'
import { buildExpiryAwareness } from '../src/server/brokerage-context'

describe('dynamic Dan time context', () => {
  it('uses New York wall time across daylight saving time', () => {
    expect(newYorkClock(new Date('2026-08-14T14:05:06.000Z'))).toMatchObject({
      localDate: '2026-08-14', localTime: '10:05:06', timeZone: 'America/New_York', weekday: 'Friday',
    })
    expect(newYorkClock(new Date('2026-01-14T14:05:06.000Z')).localTime).toBe('09:05:06')
  })

  it('surfaces near expiry without making it an execution veto', () => {
    const risks = buildExpiryAwareness([{
      direction: 'Long', instrumentType: 'Equity Option', quantity: 2,
      symbol: 'SPY   260814C00600000', underlying: 'SPY',
    }], new Date('2026-08-14T14:00:00.000Z'))
    expect(risks).toEqual([expect.objectContaining({
      daysUntilExpiry: 0, symbol: 'SPY   260814C00600000', urgency: 'expiry-day',
    })])
  })
})
