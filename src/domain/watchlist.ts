import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'

/**
 * The maintained D1 list, public projection, and snapshot fetch are one product
 * surface. Sharing that invariant prevents a narrower model or browser schema from
 * silently dropping symbols accepted by the authoritative list. The list grows on
 * its own as reader searches and member agents admit names, so this is an observable ceiling
 * rather than a curated size: pruning back to a working set stays available for
 * the day the list outgrows what a reader can scan.
 */
export const MAX_WATCHLIST_SYMBOLS = 500

/**
 * The live feed is the one surface the list size cannot carry: every symbol here is
 * an open DXLink subscription in one browser. The rest of the list still renders from
 * the snapshot, so a longer watchlist costs streamed rows rather than visible ones.
 */
export const MAX_LIVE_STREAM_SYMBOLS = 100

const WatchlistSymbolsSchema = z.array(EquitySymbolSchema).min(1).max(MAX_WATCHLIST_SYMBOLS)

/** spicy.trade maintains one internal watchlist; broker list names are seed provenance, not mutation targets. */
export const AddWatchlistSymbolsSchema = z.strictObject({
  kind: z.literal('add_watchlist_symbols'),
  symbols: WatchlistSymbolsSchema,
})
export const RemoveWatchlistSymbolsSchema = z.strictObject({
  kind: z.literal('remove_watchlist_symbols'),
  symbols: WatchlistSymbolsSchema,
})
/** The runtime parser is `WatchlistActionSchema`, the tool contract built from these two. */
export type WatchlistMutation =
  | z.infer<typeof AddWatchlistSymbolsSchema>
  | z.infer<typeof RemoveWatchlistSymbolsSchema>

/**
 * spicy.trade's own report of a mutation it just made, never parsed: it crosses no trust boundary,
 * and a schema here would only have looked like an enforced bound. Refusing it after the write
 * had landed would also have told the caller a completed change had failed.
 */
export type WatchlistMutationResult = {
  appliedSymbols: string[]
  /** May enumerate the complete maintained list. */
  detail: string
  discardedSymbols: string[]
}
