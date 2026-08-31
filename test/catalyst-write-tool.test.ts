import { describe, expect, it, vi } from 'vitest'

import { createCatalystWriteTool } from '../src/server/catalyst-write-tool'
import { type RetainedPage } from '../src/server/research-agent-tools'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'

const NOW = new Date('2026-08-31T18:00:00.000Z')
const PAGE_URL = 'https://investors.example.com/events'

function retainedPages(markdown: string): Map<string, RetainedPage> {
  return new Map([[PAGE_URL, { markdown, readAt: NOW.toISOString() }]])
}

function environment() {
  const bound: unknown[][] = []
  const batch = vi.fn(async () => [])
  const env = {
    DB: {
      ...unsupportedDatabase(),
      batch,
      prepare: () => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          bound.push(values)
          return unsupportedStatement()
        },
      }),
    },
  }
  return { batch, bound, env }
}

const call = {
  date: '2026-09-15',
  kind: 'investor-event' as const,
  sourceUrl: PAGE_URL,
  symbol: 'NVDA',
  timing: 'unknown' as const,
  title: 'NVIDIA investor day',
}

describe('record_catalyst', () => {
  it('writes a catalyst whose date is on the page the agent read', async () => {
    const { batch, bound, env } = environment()
    const tool = createCatalystWriteTool(env, 'dan', {
      now: NOW,
      retained: retainedPages('NVIDIA will hold an investor day on September 15, 2026.'),
    })

    const result = await tool.execute('call-1', call, new AbortController().signal, () => {})

    expect(JSON.stringify(result)).toContain('"recorded":true')
    expect(batch).toHaveBeenCalledOnce()
    // The id names the producer, which is what the store's CHECK requires and what makes the
    // row traceable to something that can refresh or retract it.
    expect(bound[0]?.[0]).toBe('dan:NVDA:investor-event:2026-09-15')
    expect(bound[0]?.[1]).toBe('dan')
  })

  it('refuses a date the page never mentions', async () => {
    const { batch, env } = environment()
    const tool = createCatalystWriteTool(env, 'dan', {
      now: NOW,
      retained: retainedPages('NVIDIA will hold an investor day next quarter.'),
    })

    const result = await tool.execute('call-1', call, new AbortController().signal, () => {})

    expect(JSON.stringify(result)).toContain('does not appear on that page')
    expect(batch).not.toHaveBeenCalled()
  })

  it('refuses a source the run never read', async () => {
    const { batch, env } = environment()
    const tool = createCatalystWriteTool(env, 'dan', { now: NOW, retained: new Map() })

    const result = await tool.execute('call-1', call, new AbortController().signal, () => {})

    expect(JSON.stringify(result)).toContain('read_page')
    expect(batch).not.toHaveBeenCalled()
  })

  it('refuses an event beyond the horizon it would never be re-verified within', async () => {
    const { batch, env } = environment()
    const tool = createCatalystWriteTool(env, 'dan', {
      now: NOW,
      retained: retainedPages('The meeting is scheduled for September 15, 2027.'),
    })

    const result = await tool.execute(
      'call-1',
      { ...call, date: '2027-09-15' },
      new AbortController().signal,
      () => {},
    )

    expect(JSON.stringify(result)).toContain('horizon')
    expect(batch).not.toHaveBeenCalled()
  })
})
