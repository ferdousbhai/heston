export const MAX_DAILY_RESEARCH_IDEAS = 3
// ask-dan researched a broad twenty-post discovery set before ranking. Ten exact,
// watchlist-bound symbols preserves that breadth while bounding provider fan-out.
export const MAX_DAILY_RESEARCH_LEADS = 10

/**
 * A stored brief is keyed by its market date, so a rerun replaces that day's row
 * instead of appending a second brief. The coverage search excludes exactly this
 * id, so the writer and the reader must derive it the same way.
 */
export function researchBriefId(marketDate: string): string {
  return `brief-${marketDate}`
}

export interface ResearchSourceItem {
  context?: string
  marketMover?: {
    averageVolume3Month?: number
    category: 'gainer' | 'loser' | 'most-active'
    changePercent: number
    name: string
    price: number
    symbol: string
    volume: number
  }
  /** Fetched pages found in one private discovery item; never raw model URLs. */
  linkedPages?: Array<{
    excerpt: string
    label: string
    title: string
    url: string
  }>
  outbound?: {
    /** Bounded fetched page text, retained only for private research editing. */
    excerpt?: string
    label: string
    title?: string
    url: string
  }
  source: string
  /** Symbols deterministically associated with this item before model editing. */
  symbols?: string[]
  title: string
  url: string
  publishedAt?: string
}
