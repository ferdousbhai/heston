import { z } from 'zod'

import { DailyBriefSchema, type DailyBrief } from '../domain/brief'
import { loadPublicJson } from './public-json'

const BriefArchiveResponseSchema = z.strictObject({ brief: DailyBriefSchema.nullable() })

export async function loadPreviousDailyBrief(publishedBefore: string, signal?: AbortSignal): Promise<DailyBrief | undefined> {
  const query = new URLSearchParams({ before: publishedBefore })
  return (await loadPublicJson(`/api/public-daily-briefs?${query}`, BriefArchiveResponseSchema, signal)).brief ?? undefined
}
