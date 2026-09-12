/**
 * What each tool does to the world, declared the way MCP asks servers to declare it.
 *
 * The defaults matter and are the cautious reading: `destructiveHint` defaults to true and
 * `idempotentHint` to false, so saying nothing describes the most dangerous possible tool.
 * Stating them is how a client learns that remembering a symbol is additive while cancelling an
 * order is not, and that placing an order twice places two orders.
 *
 * These are hints. The spec is explicit that a client must treat annotations from an untrusted
 * server as untrusted, and nothing here is a control: the server's own guards decide what is
 * admissible, and they run whether or not a client read a single one of these.
 *
 * Every registered tool must appear here. `toolAnnotations` throws on a name it does not know,
 * so a new tool cannot reach the wire without someone deciding what it does.
 */
export interface McpToolAnnotations {
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
  readOnlyHint?: boolean
  title: string
}

/** A read that leaves our stores and the broker untouched. `openWorld` is about where it reads from. */
function read(title: string, openWorld: boolean): McpToolAnnotations {
  return { openWorldHint: openWorld, readOnlyHint: true, title }
}

// `satisfies` keeps the literal keys as evidence, so `ANNOTATED_TOOL_NAMES` is the real
// list of declared tools rather than an open dictionary that could be anything.
const ANNOTATIONS = {
  // Reads that reach a provider or the open web.
  find_option_contracts: read('Find option contracts', true),
  get_recent_coverage: read('Read recent coverage', true),
  ingest_wsb: read('Read WallStreetBets candidates', true),
  read_account_history: read('Read account history', true),
  read_instrument_quotes: read('Read quotes', true),
  read_market_metrics: read('Read market metrics', true),
  read_option_greeks: read('Read option Greeks', true),
  read_price_history: read('Read price history', true),
  search_symbols: read('Search symbols', true),
  // Reads answered entirely from Spice's own stores.
  read_catalysts: read('Read catalysts', false),
  read_daily_recommendations: read('Read the daily brief', false),
  read_watchlist: read('Read the watchlist', false),

  // Writes.
  place_brokerage_order: {
    // The one tool here that spends money. Calling it twice places two orders, which is
    // precisely what `idempotentHint: false` is for.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Place a brokerage order',
  },
  cancel_brokerage_order: {
    // Destructive in that it removes a working order, but cancelling an already-cancelled
    // order changes nothing further.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Cancel a brokerage order',
  },
  reconcile_brokerage_action: {
    // Only settles a quarantine against what the broker already did; it never places or
    // cancels anything.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Reconcile an ambiguous submission',
  },
  remember_symbols: {
    // Additive by construction: it can admit a name to the shared watchlist, never remove one.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
    title: 'Remember symbols',
  },
  manage_watchlist: {
    // Can remove a symbol, which takes it from every reader — hence owner-only, and hence
    // destructive where `remember_symbols` is not.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
    title: 'Manage the watchlist',
  },
  publish_daily_recommendations: {
    // Replaces the market date's brief, which is what the public site then shows. The
    // replaced brief is not kept, so this is destructive in the way that matters most.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Publish the daily brief',
  },
} satisfies Readonly<Record<string, McpToolAnnotations>>

const BY_NAME = new Map<string, McpToolAnnotations>(Object.entries(ANNOTATIONS))

export function toolAnnotations(name: string): McpToolAnnotations {
  const annotations = BY_NAME.get(name)
  if (!annotations) throw new Error(`McpAnnotations:undeclared-tool:${name}`)
  return annotations
}

/** Exposed so a test can assert the table and the registered surface never drift apart. */
export const ANNOTATED_TOOL_NAMES = [...BY_NAME.keys()]
