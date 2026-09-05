import { type TSchema, Type } from 'typebox'

import { PublicMarketSnapshotSchema, type PublicMarketSnapshot } from '../domain/market'
import { EquitySymbolType, equitySymbolFromModelText } from '../domain/instrument'
import { type AgentTool } from '../domain/agent-tool'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import { servePublicSnapshot } from './public-snapshot-cache'

/**
 * The market reads an unauthenticated caller gets.
 *
 * A signed-in caller's quote and metric tools ask the broker on every call, on this Worker's own
 * market credential. Serving those anonymously would put an uncapped per-call cost behind no
 * identity at all -- which is the real reason the surface was gated, even though the same data
 * has always been public through the website.
 *
 * These read the website's own cached snapshot instead, through the same edge cache entry a
 * visitor populates. An anonymous agent therefore costs exactly what an anonymous browser costs
 * and not a request more, so the tier needs no rate limit of its own: the bound is the cache
 * that already exists rather than a number chosen here.
 *
 * The trade is honest and stated on each tool: the tracked universe only, priced as of the last
 * refresh rather than this instant.
 */
const MAX_PUBLIC_SYMBOLS = 25

const PublicQuoteParameters = Type.Object({
  symbols: Type.Array(EquitySymbolType, { maxItems: MAX_PUBLIC_SYMBOLS, minItems: 1 }),
}, { additionalProperties: false })

type PublicRow = PublicMarketSnapshot['tickers'][number]

async function readCachedSnapshot(env: AppEnv): Promise<PublicMarketSnapshot> {
  const origin = env.AUTH_BASE_URL
  if (!origin) throw new Error('PublicSnapshotOriginMissing')
  // The same URL the website requests, so this shares its cache entry rather than opening a
  // second one that would double the refresh cost it was meant to avoid.
  // SAFETY: the Workers runtime exposes `caches.default`, which the standard `CacheStorage` type
  // does not declare; `api.public-snapshot` reaches it the same way for the same reason.
  const edgeCache = (caches as CacheStorage & { default: Cache }).default
  const response = await servePublicSnapshot(new Request(`${origin}/api/public-snapshot`), env, edgeCache)
  if (!response.ok) throw new Error('PublicSnapshotUnavailable')
  return PublicMarketSnapshotSchema.parse(await response.json())
}

/** Resolve requested symbols against the snapshot, naming the ones it does not carry. */
function selectRows(snapshot: PublicMarketSnapshot, requested: readonly string[]) {
  const wanted = new Set(requested.map((symbol) => equitySymbolFromModelText(symbol) ?? symbol))
  const rows = snapshot.tickers.filter((ticker) => wanted.has(ticker.symbol))
  const found = new Set(rows.map((ticker) => ticker.symbol))
  return { missing: [...wanted].filter((symbol) => !found.has(symbol)), rows }
}

/**
 * A name outside the tracked universe is reported rather than silently dropped: an empty answer
 * would read as "no such symbol" when the truth is "not tracked, and a signed-in caller can ask
 * the broker directly".
 */
function unavailableNote(missing: readonly string[]): string | undefined {
  if (!missing.length) return undefined
  return `not in the tracked universe: ${missing.join(', ')}. A signed-in caller can quote any symbol live.`
}

export function createPublicMarketReadTools(env: AppEnv): AgentTool<TSchema>[] {
  return [
    {
      description: 'Price and daily move for tracked symbols, from the public snapshot refreshed '
        + 'about once a minute. Not a live quote and carries no bid/ask: sign in for those.',
      execute: async (_toolCallId, params) => {
        // SAFETY: the MCP server validates every call against this tool's own JSON Schema before
        // dispatch, and `PublicQuoteParameters` requires `symbols` as a non-empty string array.
        const { symbols } = params as { symbols: string[] }
        const snapshot = await readCachedSnapshot(env)
        const { missing, rows } = selectRows(snapshot, symbols)
        return textResult({
          asOf: snapshot.syncedAt,
          note: unavailableNote(missing),
          quotes: rows.map((row: PublicRow) => ({
            change: row.change,
            changePercent: row.changePercent,
            price: row.price,
            symbol: row.symbol,
          })),
          source: 'spice-public-snapshot',
        })
      },
      label: 'Reading public quotes',
      name: 'read_instrument_quotes',
      parameters: PublicQuoteParameters,
    },
    {
      description: 'Implied volatility rank, percentile and index for tracked symbols, from the '
        + 'public snapshot refreshed about once a minute. Sign in for the full broker metrics.',
      execute: async (_toolCallId, params) => {
        // SAFETY: the MCP server validates every call against this tool's own JSON Schema before
        // dispatch, and `PublicQuoteParameters` requires `symbols` as a non-empty string array.
        const { symbols } = params as { symbols: string[] }
        const snapshot = await readCachedSnapshot(env)
        const { missing, rows } = selectRows(snapshot, symbols)
        return textResult({
          asOf: snapshot.syncedAt,
          metrics: rows.map((row: PublicRow) => ({
            ivIndex: row.ivIndex,
            ivPercentile: row.ivPercentile,
            ivRank: row.ivRank,
            marketCap: row.marketCap,
            symbol: row.symbol,
          })),
          note: unavailableNote(missing),
          source: 'spice-public-snapshot',
        })
      },
      label: 'Reading public market metrics',
      name: 'read_market_metrics',
      parameters: PublicQuoteParameters,
    },
  ]
}
