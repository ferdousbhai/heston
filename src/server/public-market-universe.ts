import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'

// One invariant, stated twice because this module is imported by the one that
// owns the private cap: this must stay equal to MAX_MAINTAINED_ITEMS, since the
// public universe is a bounded projection of that list.
export const MAX_PUBLIC_MARKET_SYMBOLS = 100
const PublicSymbolSchema = EquitySymbolSchema

const PublicMarketUniverseSchema = z.strictObject({
  symbols: z.array(PublicSymbolSchema).max(MAX_PUBLIC_MARKET_SYMBOLS),
})

export type PublicMarketUniverse = z.infer<typeof PublicMarketUniverseSchema>

/** Publish only the current source-neutral D1 projection, never a stale caller snapshot. */
export async function publishInternalWatchlistUniverse(
  env: AppEnv,
  updatedAt = new Date(),
): Promise<void> {
  if (!env.DB) return
  await env.DB.prepare(
    `INSERT INTO public_market_universe (id, payload_json, updated_at)
     SELECT 'primary', json_object('symbols', json_group_array(symbol)), ?
     FROM (
       SELECT symbol FROM internal_watchlist_items
       ORDER BY symbol ASC LIMIT ${MAX_PUBLIC_MARKET_SYMBOLS}
     )
     WHERE true
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).bind(updatedAt.toISOString()).run()
}

export async function persistPublicMarketUniverse(env: AppEnv, updatedAt: Date): Promise<void> {
  try {
    await publishInternalWatchlistUniverse(env, updatedAt)
  } catch (error) {
    console.error('PublicMarketUniverseStoreFailed', error instanceof Error ? error.message : 'UnknownError')
  }
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
