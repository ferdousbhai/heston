import { finalizeInternalWatchlist } from '../../src/server/internal-watchlist'
import {
  previewInternalInstrumentCatalogChunkFromTastytrade,
  refreshInternalInstrumentCatalogChunkFromTastytrade,
} from '../../src/server/tastytrade'
import { loadOwnerPositionSymbols } from '../../src/server/brokers/tastytrade'
import { summarizeOwnerMarketSync } from '../shared/market-sync'
import { type OpsEnv, serveOpsRequest } from '../shared/worker-auth'

const CATALOG_PATHS = ['/preview', '/apply', '/finalize', '/sync']

export default {
  fetch(request: Request, env: OpsEnv): Promise<Response> {
    return serveOpsRequest(request, env, CATALOG_PATHS, 'InstrumentCatalog:operation-failed', async (path) => {
      if (path === '/finalize') {
        const positions = await loadOwnerPositionSymbols(env)
        return Response.json({ mode: 'finalize', result: await finalizeInternalWatchlist(env, positions) })
      }
      if (path === '/sync') {
        return Response.json({ mode: 'sync', sync: await summarizeOwnerMarketSync(env) })
      }
      const offsetValue = new URL(request.url).searchParams.get('offset') ?? '0'
      const offset = Number(offsetValue)
      if (!/^\d+$/.test(offsetValue) || !Number.isSafeInteger(offset)) {
        throw new Error('InstrumentCatalog:invalid-offset')
      }
      const result = path === '/preview'
        ? await previewInternalInstrumentCatalogChunkFromTastytrade(env, offset)
        : await refreshInternalInstrumentCatalogChunkFromTastytrade(env, offset)
      return Response.json({
        mode: path.slice(1),
        result,
      })
    })
  },
}
