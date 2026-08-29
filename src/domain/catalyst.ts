import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'

export const CatalystKindSchema = z.enum([
  'earnings', 'investor-event', 'product-event', 'regulatory', 'clinical',
  'conference', 'shareholder',
])
const CatalystConfidenceSchema = z.enum(['confirmed', 'estimated'])
const CatalystTimingSchema = z.enum(['pre-market', 'intraday', 'after-hours', 'unknown'])

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

export const CatalystSchema = z.object({
  id: z.string(),
  symbol: EquitySymbolSchema,
  kind: CatalystKindSchema,
  title: z.string(),
  description: z.string().min(1).max(500).nullable().optional(),
  date: z.string().refine(isValidIsoDate, 'Use a real YYYY-MM-DD date'),
  timing: CatalystTimingSchema,
  confidence: CatalystConfidenceSchema,
  source: z.string(),
  sourceUrl: z.string().url().refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL'),
  updatedAt: z.string(),
})

export type Catalyst = z.infer<typeof CatalystSchema>

const KIND_PRIORITY = {
  earnings: 0,
  regulatory: 1,
  clinical: 2,
  'investor-event': 3,
  'product-event': 4,
  conference: 5,
  shareholder: 6,
} satisfies Record<Catalyst['kind'], number>

const MARKET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function marketDate(date = new Date()): string {
  const parts = Object.fromEntries(MARKET_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function epochDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

/** Soonest date first, then by kind priority; each caller adds its own final tiebreak. */
function compareCatalystSchedule(left: Catalyst, right: Catalyst): number {
  return left.date.localeCompare(right.date) || KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
}

function compareCatalystOrder(left: Catalyst, right: Catalyst): number {
  return compareCatalystSchedule(left, right) || left.id.localeCompare(right.id)
}

/** One pass that indexes the next dated event for every symbol at once. */
export function nextCatalystsBySymbol(
  catalysts: readonly Catalyst[],
  now = new Date(),
): ReadonlyMap<string, Catalyst> {
  const today = marketDate(now)
  const next = new Map<string, Catalyst>()
  for (const catalyst of catalysts) {
    if (catalyst.date < today) continue
    const current = next.get(catalyst.symbol)
    if (!current || compareCatalystOrder(catalyst, current) < 0) next.set(catalyst.symbol, catalyst)
  }
  return next
}

export function daysUntilCatalyst(catalyst: Catalyst, now = new Date()): number {
  return epochDay(catalyst.date) - epochDay(marketDate(now))
}

export function upcomingCatalystsForSymbol(
  symbol: string,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Catalyst[] {
  const today = marketDate(now)
  return catalysts
    .filter((catalyst) => catalyst.symbol === symbol && catalyst.date >= today)
    .sort(compareCatalystOrder)
}

export function catalystLabel(catalyst: Catalyst, now = new Date()): string {
  const days = daysUntilCatalyst(catalyst, now)
  const event = ({
    earnings: 'EARN', 'investor-event': 'INVESTOR', 'product-event': 'PRODUCT', regulatory: 'REG',
    clinical: 'CLINICAL', conference: 'CONF', shareholder: 'VOTE',
  } satisfies Record<Catalyst['kind'], string>)[catalyst.kind]
  if (days === 0) return `${event} TODAY`
  return `${event} ${days}D`
}

const KIND_NAMES = {
  earnings: 'earnings',
  regulatory: 'regulatory',
  clinical: 'clinical',
  'investor-event': 'investor day',
  'product-event': 'product launch',
  conference: 'conference',
  shareholder: 'shareholder vote',
} satisfies Record<Catalyst['kind'], string>

export function catalystKindName(kind: Catalyst['kind']): string {
  return KIND_NAMES[kind]
}

export const CATALYST_KIND_NAMES: readonly string[] = CatalystKindSchema.options
  .slice()
  .sort((left, right) => KIND_PRIORITY[left] - KIND_PRIORITY[right])
  .map((kind) => KIND_NAMES[kind])

export function catalystCountdown(catalyst: Catalyst, now = new Date()): string {
  const days = daysUntilCatalyst(catalyst, now)
  return days <= 0 ? 'TODAY' : `${days}D`
}

export function catalystTimingLabel(timing: Catalyst['timing']): string | undefined {
  return ({
    'pre-market': 'Pre-market', intraday: 'Intraday', 'after-hours': 'After hours', unknown: undefined,
  } satisfies Record<Catalyst['timing'], string | undefined>)[timing]
}

/** Every local Codex finding is keyed by this prefix; the D1 table CHECKs the same GLOB. */
export const CODEX_WEB_CATALYST_ID_PREFIX = 'codex-web:'
