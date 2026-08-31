import { z } from 'zod'

import { type ResearchBrief } from '../domain/market'
import { aiGatewayHeaders, grokGatewayBaseUrl } from './ai-gateway'
import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import { GROK_MODEL } from './pi-runtime'
import { assertCompletedProviderResponse, providerOutputText } from './research-agent'
import { defineSeam, type SeamValue } from './seam'
import { readStoredSecret } from './secrets'

/*
 * Nothing else checks that a brief's citation supports the claim attached to it. The model
 * that wrote the claim cannot vouch for it — asking it to re-read its own sources is the
 * unenforceable self-check this pipeline already learned to distrust — so each cited page is
 * fetched here and read by a second model that is given the retrieved text and nothing else.
 * It has no web access, so it can only judge what a page actually says; it cannot confirm a
 * claim from its own knowledge, which is the failure this exists to catch.
 *
 * An idea whose own sources do not state its claims is dropped. When the audit itself cannot
 * run the brief still publishes, because a missing auditor is not evidence against an idea —
 * that degradation is recorded rather than hidden.
 */

// A cited page is a public article or filing: fifteen seconds is longer than one needs and
// two megabytes past the largest observed, while one unresponsive host must not stall the
// 09:30 job. Six thousand characters is enough of a page for a date, a number or a claim to
// appear in context and keeps a whole brief's evidence inside one model request.
const FETCH_TIMEOUT_MS = 15_000
const FETCH_MAX_BYTES = 2_000_000
const PAGE_EXCERPT_CHARS = 6_000
const MAX_AUDIT_OUTPUT_TOKENS = 2_000
const MAX_RESPONSE_BYTES = 400_000

const VerdictSchema = z.object({
  index: z.number().int().nonnegative(),
  supported: z.boolean(),
  reason: z.string().min(1).max(300),
})

export type CitationAudit = {
  ideas: ResearchBrief['ideas']
  rejected: string[]
  status: 'audited' | 'unavailable'
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readPage(url: string, fetcher: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(url, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      return undefined
    }
    const html = await readBoundedText(response)
    return visibleText(html).slice(0, PAGE_EXCERPT_CHARS)
  } catch {
    return undefined
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done || value === undefined) break
    parts.push(value)
    size += value.length
    if (size >= FETCH_MAX_BYTES) {
      await reader.cancel()
      break
    }
  }
  return new TextDecoder().decode(Buffer.concat(parts, Math.min(size, FETCH_MAX_BYTES)))
}

/** Ask a reader that has only the retrieved text whether each idea's own sources state it. */
async function runCitationAudit(
  env: AppEnv,
  request: { ideas: ResearchBrief['ideas']; marketDate: string; runId: string },
  fetcher: typeof fetch = fetch,
): Promise<CitationAudit> {
  if (!request.ideas.length) return { ideas: request.ideas, rejected: [], status: 'audited' }
  const pages = new Map<string, string>()
  for (const idea of request.ideas) {
    for (const source of idea.sources) {
      if (pages.has(source.url)) continue
      const text = await readPage(source.url, fetcher)
      if (text) pages.set(source.url, text)
    }
  }
  const claims = request.ideas.map((idea, index) => ({
    index,
    claim: `${idea.headline}. ${idea.description} Risk: ${idea.risk}`,
    symbol: idea.symbol,
    sources: idea.sources.map((source) => ({
      url: source.url,
      text: pages.get(source.url) ?? '(page could not be retrieved)',
    })),
  }))
  let verdicts: z.infer<typeof VerdictSchema>[]
  try {
    const [apiKey, gatewayToken, gatewayBaseUrl] = await Promise.all([
      readStoredSecret(env.XAI_API_KEY, 'XAI_API_KEY'),
      readStoredSecret(env.AI_GATEWAY_TOKEN, 'AI_GATEWAY_TOKEN'),
      grokGatewayBaseUrl(env),
    ])
    const response = await fetcher(`${gatewayBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...aiGatewayHeaders(gatewayToken, {
          app: 'spice', feature: 'daily-research-citation-audit', market_date: request.marketDate,
          run_id: request.runId,
        }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROK_MODEL.id,
        input: [{
          role: 'user',
          content: `Each item below is a claim and the text of the pages it cites. Judge only from that text: does a cited page state what the claim asserts? Judge nothing from your own knowledge — a claim you believe is true but the pages do not state is unsupported. Return one verdict per index as JSON: {"verdicts":[{"index":0,"supported":true,"reason":"..."}]}\n\n${JSON.stringify(claims)}`,
        }],
        max_output_tokens: MAX_AUDIT_OUTPUT_TOKENS,
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`DailyResearchCitationAudit:${response.status}`)
    }
    const payload = await readBoundedJson(response, MAX_RESPONSE_BYTES, 'DailyResearchCitationAudit')
    assertCompletedProviderResponse(payload)
    const text = providerOutputText(payload)
    verdicts = z.object({ verdicts: z.array(VerdictSchema) })
      .parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))).verdicts
  } catch (cause) {
    // A missing auditor is not evidence against an idea, so the brief still publishes and
    // the gap is recorded instead of being mistaken for a clean audit.
    console.warn(JSON.stringify({
      event: 'DailyResearchCitationAuditUnavailable',
      reason: cause instanceof Error ? cause.message.slice(0, 120) : 'unknown',
      runId: request.runId,
    }))
    return { ideas: request.ideas, rejected: [], status: 'unavailable' }
  }
  const refused = new Map(verdicts.filter((v) => !v.supported).map((v) => [v.index, v.reason]))
  const rejected = request.ideas.flatMap((idea, index) => (
    refused.has(index) ? [`${idea.symbol}: ${refused.get(index)}`] : []
  ))
  return {
    ideas: request.ideas.filter((_idea, index) => !refused.has(index)),
    rejected,
    status: 'audited',
  }
}

const citationAuditSeam = defineSeam(() => ({ audit: runCitationAudit }))

export type CitationAuditor = SeamValue<typeof citationAuditSeam>
export const citationAudit = citationAuditSeam.current
export const setCitationAudit = citationAuditSeam.set
export const resetCitationAudit = citationAuditSeam.reset
