import { describe, expect, it } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { citationAudit } from '../src/server/research-citation-audit'
import { unsupportedAi } from './fake-ai'
import { unsupportedDatabase } from './fake-d1'

function auditEnv(): AppEnv {
  const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
  // The audit reads only the gateway URL and the two secrets bound below.
  const env: AppEnv = {
    AI: {
      ...unsupportedAi(),
      // SAFETY: this path calls only the documented getUrl method.
      gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
    },
    AI_GATEWAY_TOKEN: secret('gateway-token'),
    DB: unsupportedDatabase(),
    XAI_API_KEY: secret('xai-key'),
  }
  return env
}

function idea(symbol: string, url: string) {
  return {
    symbol,
    direction: 'bullish' as const,
    headline: `${symbol} prints on 24 September`,
    description: 'The company presents at its investor day.',
    risk: 'The date slips.',
    play: null,
    sources: [{ label: 'Events', url }],
  }
}

type Verdicts = { verdicts: { index: number; supported: boolean; reason: string }[] }

function fetcherFor(page: string, verdicts: Verdicts) {
  // SAFETY: the closure answers the two request shapes this audit makes and nothing else,
  // so it satisfies the fetch contract the function under test actually exercises.
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://gateway.example')) {
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(verdicts) }] }],
      }), { status: 200 })
    }
    return new Response(page, { status: 200 })
  }) as typeof fetch
}

describe('daily brief citation audit', () => {
  const request = { marketDate: '2026-08-31', runId: 'run-1' }

  it('keeps an idea its own source states', async () => {
    const ideas = [idea('SPCX', 'https://example.com/events')]
    const audit = await citationAudit().audit(
      auditEnv(),
      { ...request, ideas },
      fetcherFor('<p>Investor day on September 24, 2026.</p>', {
        verdicts: [{ index: 0, supported: true, reason: 'the page states the date' }],
      }),
    )

    expect(audit.status).toBe('audited')
    expect(audit.ideas).toHaveLength(1)
    expect(audit.rejected).toEqual([])
  })

  it('drops an idea the cited page does not state, and says which', async () => {
    const ideas = [idea('SPCX', 'https://example.com/events')]
    const audit = await citationAudit().audit(
      auditEnv(),
      { ...request, ideas },
      fetcherFor('<p>Upcoming events will be announced.</p>', {
        verdicts: [{ index: 0, supported: false, reason: 'the page names no date' }],
      }),
    )

    expect(audit.ideas).toEqual([])
    expect(audit.rejected).toEqual(['SPCX: the page names no date'])
  })

  it('publishes every idea when the auditor itself cannot run', async () => {
    const ideas = [idea('SPCX', 'https://example.com/events')]
    // SAFETY: same two-shape contract as above, with the gateway leg failing.
    const failing = (async (input: RequestInfo | URL) => (
      String(input).startsWith('https://gateway.example')
        ? new Response('upstream is down', { status: 503 })
        : new Response('<p>anything</p>', { status: 200 })
    )) as typeof fetch

    const audit = await citationAudit().audit(auditEnv(), { ...request, ideas }, failing)

    // A missing auditor is not evidence against an idea; the gap is recorded, not inferred.
    expect(audit.status).toBe('unavailable')
    expect(audit.ideas).toHaveLength(1)
  })
})
