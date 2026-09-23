import { readInternalWatchlistSeedAudit } from '../../src/server/internal-watchlist'
import {
  previewInternalWatchlistFromTastytrade,
  seedInternalWatchlistFromTastytrade,
} from '../../src/server/tastytrade'
import { summarizeOwnerMarketSync } from '../shared/market-sync'
import { type OpsEnv, serveOpsRequest } from '../shared/worker-auth'

const SEED_PATHS = ['/preview', '/seed', '/sync']

/**
 * One-off temporary Worker entrypoint. Its authenticated, uniquely named route
 * keeps brokerage credentials out of the local process and avoids adding a
 * bootstrap route to the deployed application.
 * It shares the ops request gate, so an unauthorized caller sees only a 404.
 */
export default {
  fetch(request: Request, env: OpsEnv): Promise<Response> {
    return serveOpsRequest(request, env, SEED_PATHS, 'InternalWatchlist:seed-failed', async (path) => {
      if (path === '/preview') {
        return Response.json({ preview: await previewInternalWatchlistFromTastytrade(env) })
      }
      if (path === '/sync') {
        return Response.json({ sync: await summarizeOwnerMarketSync(env) })
      }
      await seedInternalWatchlistFromTastytrade(env)
      return Response.json({ audit: await readInternalWatchlistSeedAudit(env) })
    })
  },
}
