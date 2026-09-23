import { afterEach, describe, expect, it, vi } from 'vitest'

import { CATALYST_HORIZON_DAYS } from '../src/domain/catalyst'
import { runExaCatalystSearch } from '../src/server/catalyst-research-exa'

const NOW = new Date('2026-09-01T13:00:00.000Z')
const exaKey: SecretsStoreSecret = { get: async () => 'exa-key' }
const env = { EXA_API_KEY: exaKey }

/** The event fields Exa is asked to synthesize, as a test writes them. */
type ExaEventFixture = {
  date: string
  description?: string
  kind: string
  sourceUrl: string
  timing?: string
  title: string
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function page(date: string): string {
  return `Bloom Energy said the investor day is scheduled for ${date} at its headquarters.`
}

function exaResponse(events: readonly ExaEventFixture[]) {
  return Response.json({
    output: { content: { events } },
    results: [{
      text: page('2026-10-14'),
      title: 'Bloom investor day',
      url: 'https://ir.bloomenergy.com/events',
    }],
  })
}

function stubExa(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const investorDay = {
  date: '2026-10-14',
  description: 'Bloom hosts analysts and issues multi-year targets.',
  kind: 'investor-event',
  sourceUrl: 'https://ir.bloomenergy.com/events',
  timing: 'intraday',
  title: 'Bloom Energy investor day',
}

describe('exa catalyst search', () => {
  it('records a dated event its cited page states, and asks Exa for one bounded search', async () => {
    const fetchMock = stubExa(exaResponse([investorDay]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy Corporation', NOW)

    expect(run.catalysts).toEqual([{
      confidence: 'estimated',
      date: '2026-10-14',
      description: 'Bloom hosts analysts and issues multi-year targets.',
      id: 'exa:BE:investor-event:2026-10-14',
      kind: 'investor-event',
      source: 'Exa search · ir.bloomenergy.com',
      sourceUrl: 'https://ir.bloomenergy.com/events',
      symbol: 'BE',
      timing: 'intraday',
      title: 'Bloom Energy investor day',
      updatedAt: NOW.toISOString(),
    }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.headers).toMatchObject({ 'x-api-key': 'exa-key' })
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ numResults: 8, type: 'auto' })
    // An IR calendar is neither news nor recently published, so neither filter is sent.
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('startPublishedDate')
    expect(Object.keys(body.outputSchema.properties.events.items.properties)).not.toContain('confidence')
    expect(body.query).toContain('Bloom Energy Corporation (BE)')
    expect(body.query).toContain(`over the next ${CATALYST_HORIZON_DAYS} days`)
    expect(body.outputSchema.required).toEqual(['events'])
  })

  it('keeps a date its source page words without the year, inside the horizon', async () => {
    // Live reporting writes "Sept. 1" for 2026-09-01; inside the horizon that names one date.
    stubExa(Response.json({
      output: { content: { events: [{ ...investorDay, date: '2026-09-01' }] } },
      results: [{ text: 'Bloom will hold its call on Sept. 1.', url: 'https://ir.bloomenergy.com/events' }],
    }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW))
      .resolves.toMatchObject({ catalysts: [{ date: '2026-09-01' }] })
  })

  it('drops an event its source page does not state', async () => {
    stubExa(exaResponse([{ ...investorDay, date: '2026-11-20' }]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts).toEqual([])
    expect(run.rejected).toEqual(['event 1: 2026-11-20 is not bound to its source page'])
  })

  it('never lets the grounding Exa returns bind a date its page text does not state', async () => {
    // Grounding is the same model vouching for its own answer, however confident it says it is.
    stubExa(Response.json({
      output: {
        content: { events: [{ ...investorDay, date: '2026-11-20' }] },
        grounding: [{
          citations: [{ url: 'https://ir.bloomenergy.com/events' }],
          confidence: 'high',
          field: 'events[0].date',
        }],
      },
      results: [{ text: page('2026-10-14'), url: 'https://ir.bloomenergy.com/events' }],
    }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).resolves.toEqual({
      catalysts: [],
      rejected: ['event 1: 2026-11-20 is not bound to its source page'],
    })
  })

  it('drops an event from a page this run never read, a past date, and a duplicate', async () => {
    stubExa(exaResponse([
      { ...investorDay, sourceUrl: 'https://elsewhere.example/rumor' },
      { ...investorDay, date: '2026-08-14' },
      investorDay,
      investorDay,
      { ...investorDay, kind: 'not-a-kind' },
    ]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts.map((catalyst) => catalyst.id)).toEqual(['exa:BE:investor-event:2026-10-14'])
    expect(run.rejected).toEqual([
      'event 1: source was not read this run',
      'event 2: date is outside the 180-day horizon',
      'event 4: duplicates exa:BE:investor-event:2026-10-14',
      expect.stringContaining('event 5:'),
    ])
  })

  it('drops an event outside the horizon the product carries', async () => {
    stubExa(exaResponse([{ ...investorDay, date: '2026-08-14' }]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts).toEqual([])
    expect(run.rejected).toEqual(['event 1: date is outside the 180-day horizon'])
  })

  it('binds and stores the canonical address, and refuses one no citation may carry', async () => {
    stubExa(Response.json({
      output: {
        content: {
          events: [
            { ...investorDay, sourceUrl: 'https://ir.bloomenergy.com/events?utm_source=exa#calendar' },
            { ...investorDay, date: '2026-10-15', sourceUrl: 'http://ir.bloomenergy.com/events' },
            { ...investorDay, date: '2026-10-16', sourceUrl: `https://ir.bloomenergy.com/${'a'.repeat(2_000)}` },
          ],
        },
      },
      results: [{ text: page('2026-10-14'), url: 'https://ir.bloomenergy.com/events' }],
    }))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts.map((catalyst) => catalyst.sourceUrl)).toEqual(['https://ir.bloomenergy.com/events'])
    expect(run.rejected).toEqual([
      'event 2: source is not a citable https page address',
      'event 3: source is not a citable https page address',
    ])
  })

  it('reports a search that synthesized nothing instead of inventing an event', async () => {
    stubExa(Response.json({ results: [] }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).resolves.toEqual({
      catalysts: [],
      rejected: ['Exa returned no structured events'],
    })
  })

  it('fails loudly when Exa refuses the request', async () => {
    stubExa(new Response('', { status: 429 }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).rejects.toThrow('ExaSearchFailed:429')
  })
})
