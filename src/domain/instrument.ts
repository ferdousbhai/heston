import { z } from 'zod'

export const EQUITY_SYMBOL_PATTERN = '^[A-Z][A-Z.]{0,7}$'
export const EQUITY_SYMBOL_REGEX = new RegExp(EQUITY_SYMBOL_PATTERN)
export const EquitySymbolSchema = z.string().trim().toUpperCase().regex(EQUITY_SYMBOL_REGEX)

const OptionalText = (max: number) => z.string().trim().min(1).max(max).nullable()
const OptionalBoolean = z.boolean().nullable()

export const InstrumentTickSizeSchema = z.object({
  appliesToSymbol: OptionalText(128),
  kind: z.enum(['equity', 'option']),
  threshold: z.number().finite().nullable(),
  tierIndex: z.number().int().nonnegative(),
  value: z.number().finite().positive(),
})

export type InstrumentTickSize = z.infer<typeof InstrumentTickSizeSchema>

/** Typed, provider-neutral shape read by research and market rendering. */
export const InstrumentCatalogItemSchema = z.object({
  active: OptionalBoolean,
  borrowRate: z.number().finite().nullable(),
  bypassManualReview: OptionalBoolean,
  countryOfIncorporation: OptionalText(128),
  countryOfTaxation: OptionalText(128),
  createdAt: z.string().datetime(),
  description: OptionalText(512),
  haltedAt: z.string().datetime().nullable(),
  identityRefreshedAt: z.string().datetime(),
  identitySource: z.enum(['equity-endpoint', 'watchlist-symbol']),
  instrumentSubType: OptionalText(128),
  instrumentType: z.literal('Equity'),
  isClosingOnly: OptionalBoolean,
  isEtf: OptionalBoolean,
  isFractionalQuantityEligible: OptionalBoolean,
  isIlliquid: OptionalBoolean,
  isIndex: OptionalBoolean,
  isOptionsClosingOnly: OptionalBoolean,
  lendability: OptionalText(128),
  listedMarket: OptionalText(128),
  marketTimeInstrumentCollection: OptionalText(128),
  overnightTradingPermitted: OptionalBoolean,
  preIpo: OptionalBoolean,
  resolutionStatus: z.enum(['resolved', 'unresolved']),
  shortDescription: OptionalText(256),
  source: z.literal('tastytrade'),
  statusRefreshedAt: z.string().datetime(),
  stopsTradingAt: z.string().datetime().nullable(),
  streamerSymbol: OptionalText(128),
  symbol: EquitySymbolSchema,
  tickSizes: z.array(InstrumentTickSizeSchema).max(100),
  underlyingProductType: OptionalText(128),
  updatedAt: z.string().datetime(),
})

export type InstrumentCatalogItem = z.infer<typeof InstrumentCatalogItemSchema>

export function instrumentDisplayName(item: Pick<InstrumentCatalogItem, 'description' | 'shortDescription' | 'symbol'>): string {
  return item.description ?? item.shortDescription ?? item.symbol
}
