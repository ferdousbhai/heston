import { z } from 'zod'

import { type MarketSnapshot } from '../domain/market'
import { type AppEnv } from './env'

export const MAX_PUBLIC_MARKET_SYMBOLS = 100

const PublicMarketUniverseSchema = z.strictObject({
  symbols: z.array(z.string().regex(/^[A-Z.]{1,8}$/)).max(MAX_PUBLIC_MARKET_SYMBOLS),
})

export type PublicMarketUniverse = z.infer<typeof PublicMarketUniverseSchema>

function normalizedSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z.]{1,8}$/.test(symbol)))]
    .sort()
    .slice(0, MAX_PUBLIC_MARKET_SYMBOLS)
}

/** Source categories are flattened before storage and never cross the public boundary. */
export function publicMarketUniverseFromSnapshot(snapshot: MarketSnapshot): PublicMarketUniverse {
  return PublicMarketUniverseSchema.parse({
    symbols: normalizedSymbols(snapshot.watchlists
      .filter((watchlist) => watchlist.kind === 'positions' || watchlist.kind === 'private')
      .flatMap((watchlist) => watchlist.symbols)),
  })
}

async function writePublicMarketUniverse(
  env: AppEnv,
  universe: PublicMarketUniverse,
  updatedAt: string,
): Promise<void> {
  if (!env.DB) return
  await env.DB.prepare(
    `INSERT INTO public_market_universe (id, payload_json, updated_at)
     VALUES ('primary', ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(universe), updatedAt).run()
}

export async function persistPublicMarketUniverse(env: AppEnv, snapshot: MarketSnapshot): Promise<void> {
  try {
    await writePublicMarketUniverse(env, publicMarketUniverseFromSnapshot(snapshot), snapshot.syncedAt)
  } catch (error) {
    console.error('PublicMarketUniverseStoreFailed', error instanceof Error ? error.message : 'UnknownError')
  }
}

/** Replace the derived source-neutral universe without accepting provenance fields. */
export async function replacePublicMarketUniverseSymbols(
  env: AppEnv,
  symbols: readonly string[],
  updatedAt = new Date(),
): Promise<void> {
  const universe = PublicMarketUniverseSchema.parse({ symbols: normalizedSymbols(symbols) })
  await writePublicMarketUniverse(env, universe, updatedAt.toISOString())
}

export async function loadStoredPublicMarketUniverse(env: AppEnv): Promise<PublicMarketUniverse | undefined> {
  if (!env.DB) return undefined
  try {
    const row = await env.DB.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).first<{ payload_json: string }>()
    if (!row) return undefined
    return PublicMarketUniverseSchema.parse(JSON.parse(row.payload_json))
  } catch (error) {
    console.error('PublicMarketUniverseLoadFailed', error instanceof Error ? error.message : 'UnknownError')
    return undefined
  }
}

/** New internal-list discoveries become publicly visible without publishing their provenance. */
export async function mergePublicMarketUniverseSymbols(env: AppEnv, symbols: readonly string[]): Promise<void> {
  if (!symbols.length) return
  try {
    const current = await loadStoredPublicMarketUniverse(env)
    const prioritized = [...new Set([
      ...symbols.map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => /^[A-Z.]{1,8}$/.test(symbol)),
      ...(current?.symbols ?? []),
    ])].slice(0, MAX_PUBLIC_MARKET_SYMBOLS).sort()
    const universe = PublicMarketUniverseSchema.parse({ symbols: prioritized })
    await writePublicMarketUniverse(env, universe, new Date().toISOString())
  } catch (error) {
    console.error('PublicMarketUniverseMergeFailed', error instanceof Error ? error.message : 'UnknownError')
  }
}
