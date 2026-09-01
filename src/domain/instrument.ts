import { Type } from 'typebox'
import { z } from 'zod'

/**
 * tastytrade equity symbology, the one rule every symbol in Spice is bound by.
 *
 * "Equity symbols contain only alphanumeric characters (A-Z, 0-9) with an occasional `/`.
 * A few examples: `AAPL` `BRK/A`" — https://developer.tastytrade.com/api-overview/
 * (#tastytrade-symbology).
 *
 * tastytrade publishes no regex and no length: its OpenAPI spec declares `symbol` as a bare
 * string with no `pattern` or `maxLength`. The bounds below are therefore the documented
 * character set plus the shape every published example honors — a root of at most six
 * alphanumerics, which is also the width of the OCC root field, so any optionable equity
 * fits, followed by an optional share class after a single slash that never leads. A
 * leading `/` is a futures symbol and a `:` suffix marks a streamer symbol; neither is an
 * equity, so neither is accepted here.
 *
 * The dot form (`BRK.B`) is the NASDAQ file convention rather than tastytrade's, and the
 * broker 404s on it. A provider with its own rendering translates at that provider's own
 * boundary and nowhere else — `yahooSymbol` maps the slash to Yahoo's dash.
 */
const equitySymbolBody = (characters: string): string => `${characters}{1,6}(?:/${characters}{1,3})?`
const EQUITY_SYMBOL_BODY = equitySymbolBody('[A-Z0-9]')

/**
 * The shape a symbol may arrive in when it comes out of model text: X's cashtag, any letter
 * case, and nothing else. It admits exactly what `equitySymbolFromModelText` can read, so the
 * schema a provider validates against and the reader behind it cannot disagree about what is
 * well formed. Another venue's notation stays a visible refusal until it is named a
 * convention here, and both halves change together in this one place.
 */
export const MODEL_TEXT_EQUITY_SYMBOL_PATTERN = `^\\$?${equitySymbolBody('[A-Za-z0-9]')}$`
export const ModelTextEquitySymbolType = Type.String({ pattern: MODEL_TEXT_EQUITY_SYMBOL_PATTERN })

export const MAX_EQUITY_SYMBOL_LENGTH = 10

export const EQUITY_SYMBOL_PATTERN = `^${EQUITY_SYMBOL_BODY}$`
export const EQUITY_SYMBOL_REGEX = new RegExp(EQUITY_SYMBOL_PATTERN)
export const EquitySymbolType = Type.String({ pattern: EQUITY_SYMBOL_PATTERN })
export const EquitySymbolSchema = z.string().trim().toUpperCase().regex(EQUITY_SYMBOL_REGEX)

/**
 * A ticker arriving from model text may still wear the cashtag X writes it with, and Reddit
 * uses both forms. Search keeps whichever the venue expects; every provider and internal
 * lookup takes the bare symbol, so a symbol crossing out of model text is read here rather
 * than rejected for a convention it was written in. Anything still unreadable stays refused.
 */
export function equitySymbolFromModelText(value: string): string | undefined {
  return EquitySymbolSchema.safeParse(value.trim().replace(/^\$/, '').toUpperCase()).data
}

const OptionalBoolean = z.boolean().nullable()

// Provider description fields are untrusted storage input. These generous text widths bound
// D1 rows and UI strings without classifying or shortening any valid symbol or trading field.
export const InstrumentCatalogItemSchema = z.object({
  borrowRate: z.number().finite().nullable(),
  countryOfIncorporation: z.string().trim().min(1).max(128).nullable(),
  description: z.string().trim().min(1).max(512).nullable(),
  isEtf: OptionalBoolean,
  isIndex: OptionalBoolean,
  lendability: z.string().trim().min(1).max(128).nullable(),
  listedMarket: z.string().trim().min(1).max(128).nullable(),
  resolutionStatus: z.enum(['resolved', 'unresolved']),
  shortDescription: z.string().trim().min(1).max(256).nullable(),
  symbol: EquitySymbolSchema,
})

export type InstrumentCatalogItem = z.infer<typeof InstrumentCatalogItemSchema>

export function instrumentDisplayName(item: Pick<InstrumentCatalogItem, 'description' | 'shortDescription' | 'symbol'>): string {
  return item.description ?? item.shortDescription ?? item.symbol
}
