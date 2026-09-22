import { z } from 'zod'

import { DailyBriefSchema, type DailyBrief } from '../domain/brief'

const BriefArchiveResponseSchema = z.strictObject({ brief: DailyBriefSchema.nullable() })

export async function loadPreviousDailyBrief(publishedBefore: string, signal?: AbortSignal): Promise<DailyBrief | undefined> {
  const query = new URLSearchParams({ before: publishedBefore })
  const response = await fetch(`/api/public-daily-briefs?${query}`, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`Brief archive request failed (${response.status})`)
  return BriefArchiveResponseSchema.parse(await response.json()).brief ?? undefined
}
