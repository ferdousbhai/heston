import { z } from 'zod'

import {
  CATALYST_HORIZON_DAYS,
  CatalystKindSchema,
  CatalystTimingSchema,
  MAX_CATALYST_DESCRIPTION_LENGTH,
  MAX_CATALYST_TITLE_LENGTH,
} from '../domain/catalyst'
import { CitedSourceUrlSchema } from '../domain/https-url'
import { EquitySymbolSchema } from '../domain/instrument'
import { IsoDateSchema } from '../domain/iso-date'
import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import {
  bindCatalystCandidates,
  type CatalystCandidateBinding,
  type ResearchCatalystCandidate,
} from './research-catalyst-output'
import { type RetainedPage } from './research-page-retention'
import { citedPageKey } from './research-url'
import { readStoredSecret } from './secrets'

/**
 * Exa searches the web and, given a JSON schema, synthesizes one structured answer from the
 * pages it read. That is the whole catalyst producer: a symbol goes in, dated events with
 * the page each came from come back under `output.content`, beside the text Exa returned for
 * every page it read.
 *
 * A synthesized answer is still model text, so an event is kept only when its date is bound
 * to a page this run actually read: the text Exa returned for the cited page has to state that
 * date. Exa also returns an `output.grounding` list naming the pages that support each field,
 * and it is deliberately not read: it is the same model vouching for its own answer, and model
 * output never establishes a citation here. Reporting routinely writes "Sept. 1" where the
 * event says 2026-09-01, which is why the text is read the way every other catalyst binder
 * reads it -- a year-less month-day binds inside the horizon, where it can name only one date --
 * and by the same code: `bindCatalystCandidates`.
 */
const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const MAX_EXA_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_EXA_RESULTS = 8
export const MAX_RESULT_CHARACTERS = 4_000
/** An allocation bound on the untrusted events array; the response is already byte-bounded above. */
const MAX_EXA_EVENTS = 50
/**
 * Bounds the whole search, body included, since the signal aborts the stream too. Exported because
 * a `running` receipt older than the run this bounds is a run that died, not one still answering.
 */
export const EXA_REQUEST_TIMEOUT_MS = 30_000

const EXA_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    events: {
      items: {
        additionalProperties: false,
        properties: {
          date: { description: 'Scheduled date, YYYY-MM-DD', type: 'string' },
          description: { type: 'string' },
          kind: { enum: CatalystKindSchema.options, type: 'string' },
          sourceUrl: { description: 'The result URL this event was read from', type: 'string' },
          timing: { enum: CatalystTimingSchema.options, type: 'string' },
          title: { type: 'string' },
        },
        required: ['date', 'kind', 'title', 'sourceUrl'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['events'],
  type: 'object',
} as const

/** Only what the binding check reads: the page's URL, and the text Exa returned for it. */
const ExaResultSchema = z.object({
  text: z.string().optional(),
  url: z.string(),
})

const ExaResponseSchema = z.object({
  output: z.object({
    content: z.object({ events: z.array(z.unknown()).max(MAX_EXA_EVENTS) }).optional(),
  }).optional(),
  results: z.array(ExaResultSchema).default([]),
})

const ExaEventSchema = z.object({
  date: IsoDateSchema,
  description: z.string().min(1).max(MAX_CATALYST_DESCRIPTION_LENGTH).optional(),
  kind: CatalystKindSchema,
  sourceUrl: z.string().url(),
  timing: CatalystTimingSchema.optional(),
  title: z.string().min(1).max(MAX_CATALYST_TITLE_LENGTH),
})

// The window the query asks about is the one the binder enforces, so the search is not spent on
// events the binder would refuse.
function catalystQuery(symbol: string, name: string): string {
  return `Scheduled upcoming catalysts for ${name} (${symbol}) stock over the next ${CATALYST_HORIZON_DAYS} days: `
    + 'next earnings report date, investor day, product launch or event, regulatory or FDA '
    + 'decision date, clinical trial readout, conference presentation, shareholder meeting. '
    + 'Report only events with a specific announced date.'
}

type ExaResponse = z.infer<typeof ExaResponseSchema>

async function requestExaSearch(env: AppEnv, symbol: string, name: string): Promise<ExaResponse> {
  const apiKey = await readStoredSecret(env.EXA_API_KEY, 'EXA_API_KEY')
  const response = await fetch(EXA_SEARCH_URL, {
    // Neither a `news` category nor a published-date window: a scheduled event lives on an
    // investor-relations calendar, which is neither news nor recently published. Live runs
    // with those filters returned nothing for two of three symbols and a syndicated repost
    // for the third; without them the same searches cite the companies' own IR pages.
    body: JSON.stringify({
      contents: { text: { maxCharacters: MAX_RESULT_CHARACTERS } },
      numResults: MAX_EXA_RESULTS,
      outputSchema: EXA_OUTPUT_SCHEMA,
      query: catalystQuery(symbol, name),
      type: 'auto',
    }),
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    method: 'POST',
    signal: AbortSignal.timeout(EXA_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`ExaSearchFailed:${response.status}`)
  return ExaResponseSchema.parse(await readBoundedJson(response, MAX_EXA_RESPONSE_BYTES, 'ExaSearch'))
}

/**
 * One catalyst search for one symbol, bound by the same rules as every other producer of
 * model-authored dates: every event that survives names a page Exa read on this run, carries a
 * date that page states, and falls inside the product's horizon. Everything else is reported as
 * rejected rather than stored.
 */
export async function runExaCatalystSearch(
  env: AppEnv,
  untrustedSymbol: string,
  name: string,
  now = new Date(),
): Promise<CatalystCandidateBinding> {
  const symbol = EquitySymbolSchema.parse(untrustedSymbol)
  const payload = await requestExaSearch(env, symbol, name)
  // Keyed by the canonical address every citation here is bound by, so an event citing a page
  // with a tracking parameter or fragment Exa's result lacks still finds the text it was read
  // from, and what is stored is the one address a reader is given for that page. Two results
  // that canonicalize to one page are both text this run read from it. Exa cuts each result at
  // `MAX_RESULT_CHARACTERS`, so text that long is a partial read, and the binder then says a
  // missing date may sit past what was read.
  const readAt = now.toISOString()
  const pages = new Map<string, RetainedPage>()
  for (const result of payload.results) {
    const key = citedPageKey(result.url)
    if (key === undefined) continue
    const text = result.text ?? ''
    const truncated = text.length >= MAX_RESULT_CHARACTERS
    const read = pages.get(key)
    pages.set(key, read === undefined
      ? { markdown: text, readAt, truncated }
      : { markdown: `${read.markdown}\n${text}`, readAt, truncated: read.truncated || truncated })
  }
  const events = payload.output?.content?.events
  if (!events) return { catalysts: [], rejected: ['Exa returned no structured events'] }

  // Exa's own shape is refused here, under the event's number; everything the shared binder
  // checks -- the page, the horizon, the date on the page, duplicates -- is left to it, reported
  // under the same numbering.
  const refused: string[] = []
  const candidates: ResearchCatalystCandidate[] = []
  const sources: { sourceUrl: string }[] = []
  const candidateNumbers: number[] = []
  for (const [index, untrusted] of events.entries()) {
    const parsed = ExaEventSchema.safeParse(untrusted)
    if (!parsed.success) {
      refused.push(`catalyst ${index + 1}: ${parsed.error.issues[0]?.message ?? 'malformed'}`)
      continue
    }
    const event = parsed.data
    const sourceUrl = citedPageKey(event.sourceUrl)
    if (sourceUrl === undefined || !CitedSourceUrlSchema.safeParse(sourceUrl).success) {
      refused.push(`catalyst ${index + 1}: source is not a citable https page address`)
      continue
    }
    candidates.push({
      date: event.date,
      description: event.description ?? null,
      kind: event.kind,
      sourceIndex: sources.length,
      symbol,
      timing: event.timing ?? 'unknown',
      title: event.title,
    })
    sources.push({ sourceUrl })
    candidateNumbers.push(index + 1)
  }
  const binding = bindCatalystCandidates(candidates, sources, pages, now, 'exa', candidateNumbers)
  return { catalysts: binding.catalysts, rejected: [...refused, ...binding.rejected] }
}
