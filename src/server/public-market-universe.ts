import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'

// One invariant, stated twice because this module is imported by the one that
// owns the private cap: this must stay equal to MAX_MAINTAINED_ITEMS, since the
// public universe is a bounded projection of that list.
export const MAX_PUBLIC_MARKET_SYMBOLS = 100

const PublicMarketUniverseSchema = z.strictObject({
  symbols: z.array(EquitySymbolSchema).max(MAX_PUBLIC_MARKET_SYMBOLS),
})
const PublicMarketUniverseRowSchema = z.strictObject({ symbol: EquitySymbolSchema })
const StoredPublicMarketUniverseRowSchema = z.strictObject({ payload_json: z.string() })

export type PublicMarketUniverse = z.infer<typeof PublicMarketUniverseSchema>

/** Publish only the current source-neutral D1 projection, never a stale caller snapshot. */
export async function publishInternalWatchlistUniverse(
  env: AppEnv,
  updatedAt = new Date(),
): Promise<void> {
  if (!env.DB) throw new Error('PublicMarketUniverse:store-unavailable')
  const rows = await env.DB.prepare(
    'SELECT symbol FROM internal_watchlist_items ORDER BY symbol ASC',
  ).all<{ symbol: string }>()
  const universe = PublicMarketUniverseSchema.parse({
    symbols: z.array(PublicMarketUniverseRowSchema).parse(rows.results).map((row) => row.symbol),
  })
  await env.DB.prepare(
    `INSERT INTO public_market_universe (id, payload_json, updated_at)
     VALUES ('primary', ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(universe), updatedAt.toISOString()).run()
}

export async function loadStoredPublicMarketUniverse(env: AppEnv): Promise<PublicMarketUniverse> {
  if (!env.DB) throw new Error('PublicMarketUniverse:store-unavailable')
  const result = await env.DB.prepare(
    `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
  ).first<{ payload_json: string }>()
  if (!result) throw new Error('PublicMarketUniverse:not-found')
  const row = StoredPublicMarketUniverseRowSchema.parse(result)
  return PublicMarketUniverseSchema.parse(JSON.parse(row.payload_json))
}
