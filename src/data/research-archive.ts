import { z } from 'zod'

import { ResearchBriefSchema, type ResearchBrief } from '../domain/market'

const ResearchArchiveResponseSchema = z.strictObject({
  brief: ResearchBriefSchema.nullable(),
})

export async function loadPreviousResearchBrief(
  publishedBefore: string,
  signal?: AbortSignal,
): Promise<ResearchBrief | undefined> {
  const query = new URLSearchParams({ before: publishedBefore })
  const response = await fetch(`/api/public-research-brief?${query}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Research archive request failed (${response.status})`)
  const result = ResearchArchiveResponseSchema.parse(await response.json())
  return result.brief ?? undefined
}
