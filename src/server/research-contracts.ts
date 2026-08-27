export const MAX_DAILY_RESEARCH_IDEAS = 3
export const MAX_DAILY_RESEARCH_LEADS = 6

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
  outbound?: {
    label: string
    url: string
  }
  source: string
  /** Symbols deterministically associated with this item before model editing. */
  symbols?: string[]
  title: string
  url: string
  publishedAt?: string
}
