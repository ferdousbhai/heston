import { describe, expect, it } from 'vitest'

import {
  bindCatalystCandidates,
  type ResearchCatalystCandidate,
} from '../src/server/research-catalyst-output'
import { type RetainedPage } from '../src/server/research-agent-tools'

const NOW = new Date('2026-08-31T18:00:00.000Z')
const PAGE_URL = 'https://investors.example.com/events'
const SOURCES = [{ sourceUrl: PAGE_URL }]

function candidate(overrides: Partial<ResearchCatalystCandidate> = {}): ResearchCatalystCandidate {
  return {
    date: '2026-09-15',
    description: null,
    kind: 'investor-event',
    sourceIndex: 0,
    symbol: 'NVDA',
    timing: 'unknown',
    title: 'NVIDIA investor day',
    ...overrides,
  }
}

function retained(markdown: string): Map<string, RetainedPage> {
  return new Map([[PAGE_URL, { markdown, readAt: NOW.toISOString() }]])
}

describe('structured catalyst output binding', () => {
  it('creates an estimated application-owned row from a page containing the exact date', () => {
    const result = bindCatalystCandidates(
      [candidate()],
      SOURCES,
      retained('NVIDIA will hold an investor day on September 15, 2026.'),
      NOW,
    )

    expect(result.rejected).toEqual([])
    expect(result.catalysts).toEqual([{
      confidence: 'estimated',
      date: '2026-09-15',
      description: null,
      id: 'daily-research:NVDA:investor-event:2026-09-15',
      kind: 'investor-event',
      source: 'Daily research · investors.example.com',
      sourceUrl: PAGE_URL,
      symbol: 'NVDA',
      timing: 'unknown',
      title: 'NVIDIA investor day',
      updatedAt: NOW.toISOString(),
    }])
  })

  it('refuses an unread source or a date absent from the retained page', () => {
    expect(bindCatalystCandidates([candidate()], SOURCES, new Map(), NOW).rejected)
      .toEqual(['catalyst 1: source was not read this run'])
    expect(bindCatalystCandidates(
      [candidate()],
      SOURCES,
      retained('NVIDIA will hold an investor day next quarter.'),
      NOW,
    ).rejected).toEqual(['catalyst 1: 2026-09-15 does not appear on its source page'])
  })

  it('refuses out-of-horizon and duplicate updates instead of silently collapsing them', () => {
    expect(bindCatalystCandidates(
      [candidate({ date: '2027-09-15' })],
      SOURCES,
      retained('The investor day is September 15, 2027.'),
      NOW,
    ).rejected[0]).toContain('180-day horizon')

    expect(bindCatalystCandidates(
      [candidate(), candidate()],
      SOURCES,
      retained('The investor day is September 15, 2026.'),
      NOW,
    ).rejected).toEqual([
      'catalyst 2: duplicates daily-research:NVDA:investor-event:2026-09-15',
    ])
  })
})
