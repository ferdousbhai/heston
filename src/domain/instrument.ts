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
const EQUITY_SYMBOL_BODY = '[A-Z0-9]{1,6}(?:/[A-Z0-9]{1,3})?'

export const MAX_EQUITY_SYMBOL_LENGTH = 10

export const EQUITY_SYMBOL_PATTERN = `^${EQUITY_SYMBOL_BODY}$`
export const EQUITY_SYMBOL_REGEX = new RegExp(EQUITY_SYMBOL_PATTERN)
export const EquitySymbolType = Type.String({ pattern: EQUITY_SYMBOL_PATTERN })
export const EquitySymbolSchema = z.string().trim().toUpperCase().regex(EQUITY_SYMBOL_REGEX)

/**
 * `TICKER STRIKE(c/p) M/D`, the one human-readable play shorthand the Daily Read renders.
 * It embeds the equity symbol rule so a ticker Spice accepts can never be rejected here.
 */
export const POTENTIAL_PLAY_PATTERN =
  `^${EQUITY_SYMBOL_BODY} \\d+(?:\\.\\d+)?[cp] (?:1[0-2]|[1-9])\\/(?:3[01]|[12]\\d|[1-9])$`
export const POTENTIAL_PLAY_REGEX = new RegExp(POTENTIAL_PLAY_PATTERN)

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
