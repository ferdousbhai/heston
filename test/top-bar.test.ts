import { describe, expect, it } from 'vitest'

import { elapsedLabel } from '../src/components/top-bar'

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
