import { describe, expect, it } from 'vitest'

import { elapsedLabel, marketStatusLabel } from '../src/components/top-bar'

const NOW = Date.parse('2026-09-01T14:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('last updated label', () => {
  it('reads as a reader would say it, at every scale', () => {
    expect(elapsedLabel(ago(0), NOW)).toBe('just now')
    expect(elapsedLabel(ago(44_000), NOW)).toBe('just now')
    // Past the "just now" window but not yet a whole minute: still a minute to a reader.
    expect(elapsedLabel(ago(50_000), NOW)).toBe('1 min ago')
    expect(elapsedLabel(ago(9 * 60_000), NOW)).toBe('9 min ago')
    expect(elapsedLabel(ago(59 * 60_000), NOW)).toBe('59 min ago')
    expect(elapsedLabel(ago(60 * 60_000), NOW)).toBe('1 hr ago')
    expect(elapsedLabel(ago(23 * 60 * 60_000), NOW)).toBe('23 hr ago')
    expect(elapsedLabel(ago(24 * 60 * 60_000), NOW)).toBe('1 day ago')
    expect(elapsedLabel(ago(3 * 24 * 60 * 60_000), NOW)).toBe('3 days ago')
  })

  it('never counts backwards, and refuses a timestamp it cannot read', () => {
    // A provider clock slightly ahead of the browser's must not render as the future.
    expect(elapsedLabel(new Date(NOW + 30_000).toISOString(), NOW)).toBe('just now')
    expect(elapsedLabel('not-a-date', NOW)).toBeUndefined()
  })
})

describe('market status', () => {
  const opensAt = '2026-09-01T13:30:00.000Z'

  it('counts down only through pre-market, and says the state otherwise', () => {
    expect(marketStatusLabel('open', opensAt, NOW)).toEqual({ label: 'Open', tone: 'open' })
    expect(marketStatusLabel('pre', opensAt, Date.parse('2026-09-01T11:00:00.000Z')))
      .toEqual({ label: 'Opens in 2h 30m', tone: 'waiting' })
    expect(marketStatusLabel('pre', opensAt, Date.parse('2026-09-01T13:12:00.000Z')))
      .toEqual({ label: 'Opens in 18m', tone: 'waiting' })
    // After hours and holidays read the same to a reader: the bell is not ringing.
    expect(marketStatusLabel('after', opensAt, NOW)).toEqual({ label: 'Closed', tone: 'closed' })
    expect(marketStatusLabel('closed', undefined, NOW)).toEqual({ label: 'Closed', tone: 'closed' })
    expect(marketStatusLabel('unknown', undefined, NOW)).toEqual({ label: 'Closed', tone: 'closed' })
  })

  it('refuses to count down to a bell it cannot name or that already rang', () => {
    expect(marketStatusLabel('pre', undefined, NOW)).toEqual({ label: 'Pre-market', tone: 'waiting' })
    expect(marketStatusLabel('pre', opensAt, Date.parse('2026-09-01T13:31:00.000Z')))
      .toEqual({ label: 'Pre-market', tone: 'waiting' })
  })
})
