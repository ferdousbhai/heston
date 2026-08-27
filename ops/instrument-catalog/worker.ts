import { type AppEnv } from '../../src/server/env'
import { finalizeInternalWatchlist } from '../../src/server/internal-watchlist'
import {
  brokerApi,
  loadOwnerPositionSymbolsFromTastytrade,
  previewInternalInstrumentCatalogChunkFromTastytrade,
  refreshInternalInstrumentCatalogChunkFromTastytrade,
} from '../../src/server/tastytrade'
import { authorizedOpsRequest } from '../shared/worker-auth'

export { BrokerGate } from '../../src/server/broker-gate'

type OpsEnv = AppEnv & { OPS_AUTH_TOKEN?: string }

export default {
  async fetch(request: Request, env: OpsEnv): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST'
      || !['/preview', '/apply', '/finalize', '/sync'].includes(path)
      || !await authorizedOpsRequest(request, env.OPS_AUTH_TOKEN)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      if (path === '/finalize') {
        const positions = await loadOwnerPositionSymbolsFromTastytrade(env)
        return Response.json({ mode: 'finalize', result: await finalizeInternalWatchlist(env, positions) })
      }
      if (path === '/sync') {
        const snapshot = await brokerApi().loadMarketSnapshot(env)
        return Response.json({
          mode: 'sync',
          sync: {
            catalystCount: snapshot.catalysts.length,
            syncedAt: snapshot.syncedAt,
            tickerCount: snapshot.tickers.length,
            watchlistItemCount: snapshot.watchlists.find((watchlist) => watchlist.kind === 'private')?.symbols.length ?? 0,
          },
        })
      }
      const offsetValue = new URL(request.url).searchParams.get('offset') ?? '0'
      if (!/^\d{1,5}$/.test(offsetValue)) throw new Error('InstrumentCatalog:invalid-offset')
      const result = path === '/preview'
        ? await previewInternalInstrumentCatalogChunkFromTastytrade(env, Number(offsetValue))
        : await refreshInternalInstrumentCatalogChunkFromTastytrade(env, Number(offsetValue))
      return Response.json({
        mode: path.slice(1),
        result,
      })
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'InstrumentCatalog:operation-failed'
      return Response.json({ error }, { status: 500 })
    }
  },
}
