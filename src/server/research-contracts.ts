// One transcript may read at most this many public pages. Link-history checks derive the same
// ceiling because a candidate reader link must have come from one of those reads.
export const MAX_RESEARCH_PAGE_READS = 30

/**
 * Stored daily recommendations are keyed by market date, so a rerun replaces that day's row.
 * Coverage and link-history reads exclude exactly this id, so every boundary derives it here.
 */
export function dailyRecommendationsId(marketDate: string): string {
  return `recommendations-${marketDate}`
}
