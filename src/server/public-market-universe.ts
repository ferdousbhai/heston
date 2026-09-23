import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { type AppEnv } from './env'
import { CallerVisibleError } from './caller-visible-error'

const PublicMarketUniverseSchema = z.strictObject({
  symbols: z.array(EquitySymbolSchema).max(MAX_WATCHLIST_SYMBOLS),
})
const PublicMarketUniverseRowSchema = z.strictObject({ symbol: EquitySymbolSchema })
const StoredPublicMarketUniverseRowSchema = z.strictObject({ payload_json: z.string() })

export type PublicMarketUniverse = z.infer<typeof PublicMarketUniverseSchema>

/** Publish only the current source-neutral D1 projection, never a stale caller snapshot. */
export async function publishInternalWatchlistUniverse(
  env: AppEnv,
  updatedAt = new Date(),
): Promise<void> {
  if (!env.DB) throw new CallerVisibleError('PublicMarketUniverse:store-unavailable')
  // A name the broker has stopped trading is excluded here rather than deleted from the list.
  // It quotes a stale last price forever and can never trade again, so offering it to a reader
  // is offering something to act on that cannot be acted on -- CRVW rode the original seed onto
  // the public page this way and priced at three cents for as long as anyone looked. A row the
  // catalog has never seen is kept: unknown is not the same as delisted.
  const rows = await env.DB.prepare(
    `SELECT i.symbol FROM internal_watchlist_items i
       LEFT JOIN instrument_catalog c ON c.symbol = i.symbol
      WHERE coalesce(c.active, 1) = 1
      ORDER BY i.symbol ASC`,
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
  if (!env.DB) throw new CallerVisibleError('PublicMarketUniverse:store-unavailable')
  const result = await env.DB.prepare(
    `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
  ).first<{ payload_json: string }>()
  if (!result) throw new CallerVisibleError('PublicMarketUniverse:not-found')
  const row = StoredPublicMarketUniverseRowSchema.parse(result)
  return PublicMarketUniverseSchema.parse(JSON.parse(row.payload_json))
}
