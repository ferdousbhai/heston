import { z } from 'zod'

export const MarketSymbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z.]{1,8}$/)

export const LiveMarketEventSchema = z.object({
  type: z.literal('market'),
  symbol: MarketSymbolSchema,
  price: z.number().finite().positive().optional(),
  change: z.number().finite().optional(),
  bid: z.number().finite().positive().optional(),
  ask: z.number().finite().positive().optional(),
  candleClose: z.number().finite().positive().optional(),
  timestamp: z.string().datetime(),
})

export type LiveMarketEvent = z.infer<typeof LiveMarketEventSchema>

export function parseRequestedSymbols(url: URL, limit = 100): string[] {
  return [...new Set((url.searchParams.get('symbols') ?? '')
    .split(',')
    .map((symbol) => MarketSymbolSchema.safeParse(symbol))
    .flatMap((result) => result.success ? [result.data] : []))]
    .slice(0, limit)
}

export function isSameOriginWebSocketRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return Boolean(origin && origin === new URL(request.url).origin)
}
