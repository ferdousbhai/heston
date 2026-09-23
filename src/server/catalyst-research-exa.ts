import { z } from 'zod'

import {
  CATALYST_HORIZON_DAYS,
  CatalystKindSchema,
  CatalystSchema,
  marketDate,
  MAX_CATALYST_DESCRIPTION_LENGTH,
  MAX_CATALYST_TITLE_LENGTH,
  type Catalyst,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { addDays, IsoDateSchema, textMentionsDateWithinHorizon } from '../domain/iso-date'
import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
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
 * reads it -- a year-less month-day binds inside the horizon, where it can name only one date.
 */
const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const MAX_EXA_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_EXA_RESULTS = 8
const MAX_RESULT_CHARACTERS = 4_000
const MAX_EXA_EVENTS = 50
const EXA_REQUEST_TIMEOUT_MS = 30_000

/** The timings a catalyst carries, asked for and read back through one list. */
const EXA_TIMINGS = ['pre-market', 'intraday', 'after-hours', 'unknown'] as const

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
          timing: { enum: EXA_TIMINGS, type: 'string' },
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
  timing: z.enum(EXA_TIMINGS).optional(),
  title: z.string().min(1).max(MAX_CATALYST_TITLE_LENGTH),
})

export type ExaCatalystRun = {
  catalysts: Catalyst[]
  rejected: string[]
}

function catalystQuery(symbol: string, name: string): string {
  return `Scheduled upcoming catalysts for ${name} (${symbol}) stock over the next six months: `
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
 * One catalyst search for one symbol. Every event that survives names a page Exa read on
 * this run, carries a date that page states, and falls inside the same horizon the rest of
 * the product uses. Everything else is reported as rejected rather than stored.
 */
export async function runExaCatalystSearch(
  env: AppEnv,
  untrustedSymbol: string,
  name: string,
  now = new Date(),
): Promise<ExaCatalystRun> {
  const symbol = EquitySymbolSchema.parse(untrustedSymbol)
  const payload = await requestExaSearch(env, symbol, name)
  const pages = new Map(payload.results.map((result) => [result.url, result.text ?? '']))
  const events = payload.output?.content?.events
  if (!events) return { catalysts: [], rejected: ['Exa returned no structured events'] }

  const today = marketDate(now)
  const horizon = addDays(today, CATALYST_HORIZON_DAYS)
  const catalysts: Catalyst[] = []
  const rejected: string[] = []
  const ids = new Set<string>()

  for (const [index, untrusted] of events.entries()) {
    const parsed = ExaEventSchema.safeParse(untrusted)
    if (!parsed.success) {
      rejected.push(`event ${index + 1}: ${parsed.error.issues[0]?.message ?? 'malformed'}`)
      continue
    }
    const event = parsed.data
    const sourceUrl = new URL(event.sourceUrl)
    const page = pages.get(event.sourceUrl)
    if (sourceUrl.protocol !== 'https:' || page === undefined) {
      rejected.push(`event ${index + 1}: source was not read this run`)
      continue
    }
    if (event.date < today || event.date > horizon) {
      rejected.push(`event ${index + 1}: date is outside the ${CATALYST_HORIZON_DAYS}-day horizon`)
      continue
    }
    if (!textMentionsDateWithinHorizon(page, event.date, today, horizon)) {
      rejected.push(`event ${index + 1}: ${event.date} is not bound to its source page`)
      continue
    }
    const id = `exa:${symbol}:${event.kind}:${event.date}`
    if (ids.has(id)) {
      rejected.push(`event ${index + 1}: duplicates ${id}`)
      continue
    }
    ids.add(id)
    catalysts.push(CatalystSchema.parse({
      // A searched finding is never `confirmed`: only the broker's own calendar is.
      confidence: 'estimated',
      date: event.date,
      description: event.description ?? null,
      id,
      kind: event.kind,
      source: `Exa search · ${sourceUrl.hostname.replace(/^www\./, '')}`,
      sourceUrl: event.sourceUrl,
      symbol,
      timing: event.timing ?? 'unknown',
      title: event.title,
      updatedAt: now.toISOString(),
    }))
  }
  return { catalysts, rejected }
}
