import { type AppEnv } from '../../src/server/env'
import { pruneInternalWatchlistToFocus } from '../../src/server/internal-watchlist'
import { replacePublicMarketUniverseSymbols } from '../../src/server/public-market-universe'
import { authorizedOpsRequest } from '../shared/worker-auth'

type OpsEnv = AppEnv & { OPS_AUTH_TOKEN?: string }

export default {
  async fetch(request: Request, env: OpsEnv): Promise<Response> {
    if (request.method !== 'POST'
      || new URL(request.url).pathname !== '/apply'
      || !await authorizedOpsRequest(request, env.OPS_AUTH_TOKEN)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const { kept: symbols, removedCount } = await pruneInternalWatchlistToFocus(env, 100)
      await replacePublicMarketUniverseSymbols(env, symbols)
      return Response.json({ count: symbols.length, removedCount, symbols: [...symbols].sort() })
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'ResearchFocus:operation-failed'
      return Response.json({ error }, { status: 500 })
    }
  },
}
