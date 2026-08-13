import { z } from 'zod'

export const CatalystKindSchema = z.enum([
  'earnings', 'dividend-ex', 'dividend-pay', 'investor-event', 'product-event',
  'regulatory', 'clinical', 'conference', 'shareholder',
])
export const CatalystConfidenceSchema = z.enum(['confirmed', 'estimated'])
export const CatalystTimingSchema = z.enum(['pre-market', 'intraday', 'after-hours', 'unknown'])

export const CatalystSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  kind: CatalystKindSchema,
  title: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timing: CatalystTimingSchema,
  confidence: CatalystConfidenceSchema,
  source: z.string(),
  sourceUrl: z.string().url(),
  updatedAt: z.string(),
})

export type Catalyst = z.infer<typeof CatalystSchema>

const KIND_PRIORITY: Record<Catalyst['kind'], number> = {
  earnings: 0,
  regulatory: 1,
  clinical: 2,
  'investor-event': 3,
  'product-event': 4,
  conference: 5,
  shareholder: 6,
  'dividend-ex': 7,
  'dividend-pay': 8,
}

const STORY_CATALYST_KINDS = new Set<Catalyst['kind']>([
  'earnings', 'investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder',
])

function dateParts(date: Date, timeZone = 'America/New_York') {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map((part) => [part.type, part.value]))
}

export function marketDate(date = new Date()): string {
  const parts = dateParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function epochDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

export function daysUntilCatalyst(catalyst: Catalyst, now = new Date()): number {
  return epochDay(catalyst.date) - epochDay(marketDate(now))
}

export function nextCatalystForSymbol(
  symbol: string,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Catalyst | undefined {
  const today = marketDate(now)
  return catalysts
    .filter((catalyst) => catalyst.symbol === symbol && catalyst.date >= today)
    .sort((left, right) => (
      left.date.localeCompare(right.date)
      || KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
      || left.id.localeCompare(right.id)
    ))[0]
}

export function nextStoryCatalystForSymbol(
  symbol: string,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Catalyst | undefined {
  return nextCatalystForSymbol(
    symbol,
    catalysts.filter((catalyst) => STORY_CATALYST_KINDS.has(catalyst.kind)),
    now,
  )
}

export function catalystLabel(catalyst: Catalyst, now = new Date()): string {
  const days = daysUntilCatalyst(catalyst, now)
  const event = ({
    earnings: 'EARN', 'dividend-ex': 'EX-DIV', 'dividend-pay': 'PAY',
    'investor-event': 'INVESTOR', 'product-event': 'PRODUCT', regulatory: 'REG',
    clinical: 'CLINICAL', conference: 'CONF', shareholder: 'VOTE',
  } satisfies Record<Catalyst['kind'], string>)[catalyst.kind]
  if (days === 0) return `${event} TODAY`
  return `${event} ${days}D`
}

export function sortSymbolsByCatalyst(
  symbols: readonly string[],
  catalysts: readonly Catalyst[],
  now = new Date(),
): string[] {
  const originalOrder = new Map(symbols.map((symbol, index) => [symbol, index]))
  const next = new Map(symbols.map((symbol) => [symbol, nextCatalystForSymbol(symbol, catalysts, now)]))
  return [...symbols].sort((left, right) => {
    const leftCatalyst = next.get(left)
    const rightCatalyst = next.get(right)
    if (!leftCatalyst && !rightCatalyst) return originalOrder.get(left)! - originalOrder.get(right)!
    if (!leftCatalyst) return 1
    if (!rightCatalyst) return -1
    return leftCatalyst.date.localeCompare(rightCatalyst.date)
      || KIND_PRIORITY[leftCatalyst.kind] - KIND_PRIORITY[rightCatalyst.kind]
      || originalOrder.get(left)! - originalOrder.get(right)!
  })
}

export function upcomingInterestedSymbols(
  positionSymbols: readonly string[],
  privateWatchlistSymbols: readonly string[],
  catalysts: readonly Catalyst[],
  now = new Date(),
  horizonDays = 30,
): string[] {
  const positions = [...new Set(positionSymbols)]
  const positionSet = new Set(positions)
  const privateOnly = [...new Set(privateWatchlistSymbols)].filter((symbol) => !positionSet.has(symbol))
  const upcoming = (symbols: readonly string[]) => symbols
    .map((symbol, index) => ({ catalyst: nextStoryCatalystForSymbol(symbol, catalysts, now), index, symbol }))
    .filter((item): item is typeof item & { catalyst: Catalyst } => Boolean(
      item.catalyst && daysUntilCatalyst(item.catalyst, now) <= horizonDays,
    ))
    .sort((left, right) => left.catalyst.date.localeCompare(right.catalyst.date) || left.index - right.index)
    .map(({ symbol }) => symbol)

  return [...upcoming(positions), ...upcoming(privateOnly)]
}
