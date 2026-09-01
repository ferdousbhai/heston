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
import { addDays, ISO_DATE_REGEX, isValidIsoDate, textMentionsIsoDate } from '../domain/iso-date'
import { type RetainedPage } from './research-agent-tools'
import { recommendationLinkKey } from './research-url'

export const ResearchCatalystCandidateSchema = z.strictObject({
  date: z.string().regex(ISO_DATE_REGEX).refine(isValidIsoDate, 'Use a real YYYY-MM-DD date'),
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
 * Turn model-authored catalyst candidates into application-owned rows. A candidate survives
 * only when this run retained its HTTPS page and the page contains the exact event date.
 */
export function bindCatalystCandidates(
  candidates: readonly ResearchCatalystCandidate[],
  sources: readonly { sourceUrl: string }[],
  retained: ReadonlyMap<string, RetainedPage>,
  now: Date,
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
    if (!textMentionsIsoDate(page.markdown, candidate.date)) {
      rejected.push(`catalyst ${index + 1}: ${candidate.date} does not appear on its source page`)
      continue
    }
    if (candidate.date < today || candidate.date > horizon) {
      rejected.push(`catalyst ${index + 1}: date is outside the ${CATALYST_HORIZON_DAYS}-day horizon`)
      continue
    }
    const id = `daily-research:${candidate.symbol}:${candidate.kind}:${candidate.date}`
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
      source: `Daily research · ${new URL(sourceUrl).hostname.replace(/^www\./, '')}`,
      sourceUrl,
      updatedAt: now.toISOString(),
    }))
  }
  return { catalysts, rejected }
}
