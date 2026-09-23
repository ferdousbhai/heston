import { describe, expect, it } from 'vitest'

import { elapsedLabel, liveFeedSourceLabel, marketClockLabel, marketStatusLabel } from '../src/components/top-bar'

const NOW = Date.parse('2026-09-01T14:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('quote source', () => {
  it('names live dxLink versus the stored print', () => {
    expect(liveFeedSourceLabel('live')).toEqual({
      label: 'Live',
      title: 'Live quotes from the dxLink feed',
    })
    expect(liveFeedSourceLabel('snapshot')).toEqual({
      label: 'Snapshot',
      title: 'Last stored print; live feed is off',
    })
  })
})

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
  const closesAt = '2026-09-01T20:00:00.000Z'
  const clock = (instant: number) => marketClockLabel(instant)

  it('names the session, the New York clock, and the wait to the next bell', () => {
    expect(marketStatusLabel('open', opensAt, NOW, closesAt)).toEqual({
      detail: `Open\n${clock(NOW)}\nCloses in 6h`,
      tone: 'open',
    })
    const pre = Date.parse('2026-09-01T11:00:00.000Z')
    expect(marketStatusLabel('pre', opensAt, pre)).toEqual({
      detail: `Pre-market\n${clock(pre)}\nOpens in 2h 30m`,
      tone: 'waiting',
    })
    const soon = Date.parse('2026-09-01T13:12:00.000Z')
    expect(marketStatusLabel('pre', opensAt, soon)).toEqual({
      detail: `Pre-market\n${clock(soon)}\nOpens in 18m`,
      tone: 'waiting',
    })
    const evening = Date.parse('2026-09-01T21:00:00.000Z')
    expect(marketStatusLabel('after', '2026-09-02T13:30:00.000Z', evening)).toEqual({
      detail: `After hours\n${clock(evening)}\nOpens in 16h 30m`,
      tone: 'closed',
    })
    const weekend = Date.parse('2026-09-05T15:00:00.000Z')
    expect(marketStatusLabel('closed', '2026-09-08T13:30:00.000Z', weekend)).toEqual({
      detail: `Closed\n${clock(weekend)}\nOpens in 2d 22h`,
      tone: 'closed',
    })
  })

  it('reads an unnamed session as unknown, muted, with no countdown to a bell it cannot place', () => {
    expect(marketStatusLabel('unknown', undefined, NOW)).toEqual({
      detail: `Session unknown\n${clock(NOW)}`,
      tone: 'unknown',
    })
    expect(marketStatusLabel('unknown', opensAt, Date.parse('2026-09-01T11:00:00.000Z'), closesAt)).toEqual({
      detail: `Session unknown\n${clock(Date.parse('2026-09-01T11:00:00.000Z'))}`,
      tone: 'unknown',
    })
  })

  it('refuses to count down to a bell it cannot name or that already rang', () => {
    expect(marketStatusLabel('pre', undefined, NOW)).toEqual({
      detail: `Pre-market\n${clock(NOW)}`,
      tone: 'waiting',
    })
    const afterBell = Date.parse('2026-09-01T13:31:00.000Z')
    expect(marketStatusLabel('pre', opensAt, afterBell)).toEqual({
      detail: `Pre-market\n${clock(afterBell)}`,
      tone: 'waiting',
    })
    expect(marketStatusLabel('closed', undefined, NOW)).toEqual({
      detail: `Closed\n${clock(NOW)}`,
      tone: 'closed',
    })
    expect(marketStatusLabel('open', opensAt, NOW, '2026-09-01T13:00:00.000Z')).toEqual({
      detail: `Open\n${clock(NOW)}`,
      tone: 'open',
    })
  })
})
