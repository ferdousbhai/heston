import { readInternalWatchlistSeedAudit } from '../src/server/internal-watchlist'
import {
  previewInternalWatchlistFromTastytrade,
  seedInternalWatchlistFromTastytrade,
} from '../src/server/tastytrade'
import { summarizeOwnerMarketSync } from '../ops/shared/market-sync'
import { type OpsEnv, serveOpsRequest } from '../ops/shared/worker-auth'

export { BrokerGate } from '../src/server/broker-gate'

const WORKER_NAME = 'spice-internal-watchlist-seed'
const SEED_PATHS = ['/preview', '/seed', '/sync']

/**
 * One-off remote-dev entrypoint. Wrangler supplies the production Worker bindings,
 * while its authenticated preview tunnel keeps brokerage credentials out of the
 * local process and avoids adding a bootstrap route to the deployed application.
 * It shares the ops request gate, so an unauthorized caller sees only a 404.
 */
export default {
  fetch(request: Request, env: OpsEnv): Promise<Response> {
    return serveOpsRequest(request, env, SEED_PATHS, 'InternalWatchlist:seed-failed', async (path) => {
      if (path === '/preview') {
        return Response.json({ worker: WORKER_NAME, preview: await previewInternalWatchlistFromTastytrade(env) })
      }
      if (path === '/sync') {
        return Response.json({ worker: WORKER_NAME, sync: await summarizeOwnerMarketSync(env) })
      }
      await seedInternalWatchlistFromTastytrade(env)
      return Response.json({ worker: WORKER_NAME, audit: await readInternalWatchlistSeedAudit(env) })
    })
  },
}
