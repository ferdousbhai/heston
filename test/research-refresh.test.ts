import { describe, expect, it } from 'vitest'

import {
  RESEARCH_REFRESH_INTERVAL_MS,
  researchRefreshOpen,
  researchRefreshOpensAt,
} from '../src/domain/research-refresh'

const PUBLISHED_AT = '2026-09-02T13:45:00.000Z'

describe('the research refresh interval', () => {
  it('opens exactly one interval after the last brief, and before that not at all', () => {
    const opens = researchRefreshOpensAt(PUBLISHED_AT)
    expect(opens.getTime() - Date.parse(PUBLISHED_AT)).toBe(RESEARCH_REFRESH_INTERVAL_MS)
    expect(researchRefreshOpen(PUBLISHED_AT, new Date(opens.getTime() - 1))).toBe(false)
    expect(researchRefreshOpen(PUBLISHED_AT, opens)).toBe(true)
  })

  it('is open when nothing has ever been published', () => {
    expect(researchRefreshOpen(undefined, new Date(PUBLISHED_AT))).toBe(true)
  })

  it('refuses to reason about a published instant that is not one', () => {
    // A stored brief with an unreadable instant is a broken row, not an open window.
    expect(() => researchRefreshOpen('yesterday-ish', new Date(PUBLISHED_AT))).toThrow('invalid-published-at')
  })
})
