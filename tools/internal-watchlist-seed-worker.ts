import { readInternalWatchlistSeedAudit } from '../src/server/internal-watchlist'
import {
  brokerApi,
  previewInternalWatchlistFromTastytrade,
  seedInternalWatchlistFromTastytrade,
} from '../src/server/tastytrade'
import { type AppEnv } from '../src/server/env'

export { BrokerGate } from '../src/server/broker-gate'

const WORKER_NAME = 'spice-internal-watchlist-seed'
type SeedEnv = AppEnv & { SEED_AUTH_TOKEN?: string }
type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean
}

async function authorized(request: Request, env: SeedEnv): Promise<boolean> {
  const expected = env.SEED_AUTH_TOKEN
  const provided = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1]
  if (!expected || !provided) return false
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  // SAFETY: the one-off Worker runs on Cloudflare, whose SubtleCrypto extension
  // provides a constant-time comparison for equally sized SHA-256 digests.
  return (crypto.subtle as CloudflareSubtleCrypto).timingSafeEqual(providedHash, expectedHash)
}

/**
 * One-off remote-dev entrypoint. Wrangler supplies the production Worker bindings,
 * while its authenticated preview tunnel keeps brokerage credentials out of the
 * local process and avoids adding a bootstrap route to the deployed application.
 */
export default {
  async fetch(request: Request, env: SeedEnv): Promise<Response> {
    const url = new URL(request.url)
    if (!['/preview', '/seed', '/sync'].includes(url.pathname)
      || request.method !== 'POST'
      || !await authorized(request, env)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      if (url.pathname === '/preview') {
        return Response.json({ worker: WORKER_NAME, preview: await previewInternalWatchlistFromTastytrade(env) })
      }
      if (url.pathname === '/sync') {
        const snapshot = await brokerApi().loadMarketSnapshot(env)
        return Response.json({
          worker: WORKER_NAME,
          sync: {
            catalystCount: snapshot.catalysts.length,
            syncedAt: snapshot.syncedAt,
            tickerCount: snapshot.tickers.length,
            watchlistItemCount: snapshot.watchlists.find((watchlist) => watchlist.kind === 'private')?.symbols.length ?? 0,
          },
        })
      }
      await seedInternalWatchlistFromTastytrade(env)
      return Response.json({ worker: WORKER_NAME, audit: await readInternalWatchlistSeedAudit(env) })
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'InternalWatchlist:seed-failed'
      return Response.json({ worker: WORKER_NAME, error }, { status: 500 })
    }
  },
}
