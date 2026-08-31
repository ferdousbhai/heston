import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import {
  CATALYST_HORIZON_DAYS,
  CatalystKindSchema,
  CatalystSchema,
  marketDate,
  type Catalyst,
} from '../domain/catalyst'
import { equitySymbolFromModelText, ModelTextEquitySymbolType } from '../domain/instrument'
import { addDays, textMentionsIsoDate } from '../domain/iso-date'
import { type AppEnv } from './env'
import { textResult } from './agent-tool-result'
import { persistResearchCatalysts, type CatalystProvider } from './catalysts'
import { type RetainedPage } from './research-agent-tools'

const MAX_CATALYST_TITLE = 120
const MAX_CATALYST_DESCRIPTION = 500

const CatalystWriteParameters = Type.Object({
  date: Type.String({ description: 'Event date as YYYY-MM-DD; must appear on the page.' }),
  description: Type.Optional(Type.String({ maxLength: MAX_CATALYST_DESCRIPTION })),
  // The wire schema is the domain enum itself, so a kind added there is offered here without
  // this file restating the list.
  kind: Type.Unsafe<Catalyst['kind']>({ enum: [...CatalystKindSchema.options] }),
  sourceUrl: Type.String({ description: 'A page read with read_page this run.' }),
  symbol: ModelTextEquitySymbolType,
  timing: Type.Union([
    Type.Literal('pre-market'), Type.Literal('intraday'),
    Type.Literal('after-hours'), Type.Literal('unknown'),
  ]),
  title: Type.String({ maxLength: MAX_CATALYST_TITLE }),
}, { additionalProperties: false })

/**
 * A catalyst an agent writes is held to the bar the Codex importer already meets: the page
 * must have been read in this run, and the event date must appear in what was read. Migration
 * 0019 retired two catalyst tables because their rows could not be re-verified or retracted;
 * these rows carry the page they came from and the provider that wrote them, so both stay
 * possible. Confidence is `estimated` regardless of how a page words it — an agent reading a
 * page is not the company confirming a date.
 */
export function createCatalystWriteTool(
  env: AppEnv,
  provider: CatalystProvider,
  options: { now?: Date; retained?: ReadonlyMap<string, RetainedPage> } = {},
): AgentTool<typeof CatalystWriteParameters, unknown> {
  const now = options.now ?? new Date()
  return {
    description: 'Record a dated catalyst from a page you read this run.',
    execute: async (_toolCallId, params) => {
      const symbol = equitySymbolFromModelText(params.symbol)
      if (!symbol) return textResult({ error: `not a usable ticker: ${params.symbol}` })
      const page = options.retained?.get(params.sourceUrl)
      if (!page) {
        return textResult({ error: 'cite a page you read with read_page this run, by its exact url' })
      }
      if (!textMentionsIsoDate(page.markdown, params.date)) {
        return textResult({ error: `${params.date} does not appear on that page` })
      }
      const today = marketDate(now)
      if (params.date < today || params.date > addDays(today, CATALYST_HORIZON_DAYS)) {
        return textResult({ error: `date is outside the ${CATALYST_HORIZON_DAYS}-day horizon` })
      }
      const catalyst: Catalyst = CatalystSchema.parse({
        confidence: 'estimated',
        date: params.date,
        description: params.description,
        id: `${provider}:${symbol}:${params.kind}:${params.date}`,
        kind: params.kind,
        source: params.sourceUrl,
        sourceUrl: params.sourceUrl,
        symbol,
        timing: params.timing,
        title: params.title,
        updatedAt: now.toISOString(),
      })
      await persistResearchCatalysts(env, provider, [catalyst], now)
      return textResult({ id: catalyst.id, recorded: true })
    },
    label: 'Recording a catalyst',
    name: 'record_catalyst',
    parameters: CatalystWriteParameters,
  }
}
