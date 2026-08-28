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
  description: z.string().trim().min(1).max(500).nullable().optional(),
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

export function upcomingCatalystsForSymbol(
  symbol: string,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Catalyst[] {
  const today = marketDate(now)
  return catalysts
    .filter((catalyst) => catalyst.symbol === symbol && catalyst.date >= today)
    .sort((left, right) => (
      left.date.localeCompare(right.date)
      || KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
      || left.id.localeCompare(right.id)
    ))
}

export function nextCatalystForSymbol(
  symbol: string,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Catalyst | undefined {
  return upcomingCatalystsForSymbol(symbol, catalysts, now)[0]
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

export function upcomingCatalystSymbols(
  symbols: readonly string[],
  catalysts: readonly Catalyst[],
  now = new Date(),
  horizonDays = 30,
  limit = 12,
): string[] {
  return [...new Set(symbols)]
    .map((symbol) => ({ catalyst: nextCatalystForSymbol(symbol, catalysts, now), symbol }))
    .filter((item): item is typeof item & { catalyst: Catalyst } => Boolean(
      item.catalyst
      && daysUntilCatalyst(item.catalyst, now) >= 0
      && daysUntilCatalyst(item.catalyst, now) <= horizonDays,
    ))
    .sort((left, right) => left.catalyst.date.localeCompare(right.catalyst.date)
      || KIND_PRIORITY[left.catalyst.kind] - KIND_PRIORITY[right.catalyst.kind]
      || left.symbol.localeCompare(right.symbol))
    .slice(0, Math.max(0, limit))
    .map(({ symbol }) => symbol)
}

/** Every local Codex finding is keyed by this prefix; the D1 table CHECKs the same GLOB. */
export const CODEX_WEB_CATALYST_ID_PREFIX = 'codex-web:'
const CODEX_WEB_EVIDENCE_MAX_AGE_DAYS = 7
const CODEX_WEB_EVIDENCE_MAX_ROWS = 40

/**
 * Bounds the additive local Codex rows before they become editor evidence. Only
 * findings the local run re-verified within the last week qualify, so a runner
 * that stops working decays out of the brief instead of feeding it six-month-old
 * rows, and the nearest-dated forty keep the packet a fixed size.
 */
export function recentCodexWebCatalysts(
  catalysts: readonly Catalyst[],
  symbols: ReadonlySet<string>,
  now = new Date(),
): Catalyst[] {
  const freshSince = now.getTime() - CODEX_WEB_EVIDENCE_MAX_AGE_DAYS * 86_400_000
  const today = marketDate(now)
  return catalysts
    .filter((catalyst) => catalyst.id.startsWith(CODEX_WEB_CATALYST_ID_PREFIX)
      && symbols.has(catalyst.symbol)
      && catalyst.date >= today
      && Date.parse(catalyst.updatedAt) >= freshSince)
    .sort((left, right) => left.date.localeCompare(right.date) || left.symbol.localeCompare(right.symbol))
    .slice(0, CODEX_WEB_EVIDENCE_MAX_ROWS)
}
