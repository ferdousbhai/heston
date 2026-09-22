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
import { type CatalystProvider } from './catalysts'
import { type RetainedPage } from './research-agent-tools'
import { recommendationLinkKey } from './research-url'

export const ResearchCatalystCandidateSchema = z.strictObject({
  date: IsoDateSchema,
  description: z.string().min(1).max(MAX_CATALYST_DESCRIPTION_LENGTH).nullable(),
  kind: CatalystKindSchema,
  sourceIndex: z.number().int().nonnegative(),
  symbol: EquitySymbolSchema,
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  title: z.string().min(1).max(MAX_CATALYST_TITLE_LENGTH),
})

export type ResearchCatalystCandidate = z.infer<typeof ResearchCatalystCandidateSchema>

export interface CatalystCandidateBinding {
  catalysts: Catalyst[]
  rejected: string[]
}

/**
 * How a bound row names the producer that wrote it. The id prefix is the provider value itself,
 * which is what the `catalysts` CHECK pairs a row's id against, so a row stays traceable to
 * something that can refresh or retract it. The label is the other half of that, for a reader:
 * it says which surface produced the date, beside the host it was read from.
 */
const BOUND_CATALYST_LABELS = {
  'daily-research': 'Daily research',
  'member-research': 'Member research',
} satisfies Partial<Record<CatalystProvider, string>>

export type BoundCatalystProvider = keyof typeof BOUND_CATALYST_LABELS

/**
 * Turn model-authored catalyst candidates into application-owned rows. A candidate survives
 * only when this run retained its HTTPS page and the page contains the exact event date.
 *
 * The provider is a parameter so any producer of model-authored dates is bound under the same
 * rules. A member's recording is the one producer left; `daily-research` stays in the label map
 * because rows it wrote are still on the calendar.
 */
export function bindCatalystCandidates(
  candidates: readonly ResearchCatalystCandidate[],
  sources: readonly { sourceUrl: string }[],
  retained: ReadonlyMap<string, RetainedPage>,
  now: Date,
  provider: BoundCatalystProvider = 'member-research',
): CatalystCandidateBinding {
  const catalysts: Catalyst[] = []
  const rejected: string[] = []
  const ids = new Set<string>()
  const today = marketDate(now)
  const horizon = addDays(today, CATALYST_HORIZON_DAYS)

  for (const [index, untrusted] of candidates.entries()) {
    const parsed = ResearchCatalystCandidateSchema.safeParse(untrusted)
    if (!parsed.success) {
      rejected.push(...parsed.error.issues.map((issue) => (
        `catalyst ${index + 1}: ${issue.message}`
      )))
      continue
    }
    const candidate = parsed.data
    const source = sources[candidate.sourceIndex]
    const sourceUrl = source ? recommendationLinkKey(source.sourceUrl) : undefined
    const page = sourceUrl ? retained.get(sourceUrl) : undefined
    if (!sourceUrl || !page) {
      rejected.push(`catalyst ${index + 1}: source was not read this run`)
      continue
    }
    if (candidate.date < today || candidate.date > horizon) {
      rejected.push(`catalyst ${index + 1}: date is outside the ${CATALYST_HORIZON_DAYS}-day horizon`)
      continue
    }
    if (!textMentionsDateWithinHorizon(page.markdown, candidate.date, today, horizon)) {
      // Year-less mentions bind within the horizon, so what remains missing is the date itself.
      rejected.push(`catalyst ${index + 1}: ${candidate.date} does not appear on its source page`)
      continue
    }
    const id = `${provider}:${candidate.symbol}:${candidate.kind}:${candidate.date}`
    if (ids.has(id)) {
      rejected.push(`catalyst ${index + 1}: duplicates ${id}`)
      continue
    }
    ids.add(id)
    const { sourceIndex: _sourceIndex, ...publicFields } = candidate
    catalysts.push(CatalystSchema.parse({
      ...publicFields,
      confidence: 'estimated',
      id,
      source: `${BOUND_CATALYST_LABELS[provider]} · ${new URL(sourceUrl).hostname.replace(/^www\./, '')}`,
      sourceUrl,
      updatedAt: now.toISOString(),
    }))
  }
  return { catalysts, rejected }
}
