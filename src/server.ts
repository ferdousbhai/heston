import handler from '@tanstack/react-start/server-entry'

import { type AppEnv } from './server/env'
import { canonicalHostRedirect, finalizeDocumentResponse } from './server/http'
import { configureTypeboxRuntime } from './server/typebox-runtime'

/*
 * The MCP surface, OAuth discovery, and the scheduled jobs are loaded when a request needs
 * them rather than when the isolate starts. Each pulls a large dependency graph — the MCP
 * server, the broker client, the research pipeline — that a visitor fetching the market never
 * runs, and a cold isolate pays for every module it evaluates before it can answer anyone.
 */
const mcpSurface = () => import('./server/mcp')
const authSurface = () => import('./server/auth')

configureTypeboxRuntime()

export { BriefPublisher } from './server/brief-publisher'
export { BrokerGate } from './server/broker-gate'
export { MarketFeed } from './server/market-feed'

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    const canonicalRedirect = canonicalHostRedirect(request)
    if (canonicalRedirect) return canonicalRedirect
    const url = new URL(request.url)
    // OAuth discovery. An MCP client reads these before it can authenticate at all, and only
    // ever at the origin.
    if (url.pathname.startsWith('/.well-known/')) {
      const discovery = await (await authSurface()).handleWellKnownDiscovery(request, env)
      if (discovery) return discovery
    }
    // The tool surface for the agent each caller runs on their own machine -- the owner, any
    // member, or an anonymous caller at the public tier. Bearer-authed inside the handler; the
    // session/cookie path stays untouched and the token opens nothing else.
    if (url.pathname === '/mcp') return (await mcpSurface()).handleMcpRequest(request, env, ctx)
    // An agent aimed at the site rather than at `/mcp` would otherwise be handed the web app's
    // HTML with a 200 and fail inside its JSON parser, saying nothing useful to anyone. The
    // handshake's own discriminators are checked here so that loading the MCP module graph
    // stays what it is meant to be — something only an MCP-shaped request pays for.
    if (request.method === 'POST' && request.headers.get('content-type')?.includes('application/json')) {
      const misdirected = await (await mcpSurface()).mcpEndpointRedirect(request)
      if (misdirected) return misdirected
    }
    return finalizeDocumentResponse(request, await handler.fetch(request))
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime)
    // The year chart is decoration over live prices, so a failed refresh leaves the last good
    // series in place rather than failing the tick. Record the degraded run without logging
    // symbols or provider content.
    context.waitUntil(import('./server/scheduled-jobs').then(({ refreshYearCandles }) => refreshYearCandles(env, scheduledAt))
      .then((symbolCount) => console.info(JSON.stringify({
        event: 'YearCandlesRefreshed',
        symbolCount,
      })))
      .catch((cause: unknown) => console.error(
        'YearCandleRefreshFailed',
        cause instanceof Error ? cause.name : 'UnknownError',
      )))
    // Anonymous symbol search claims a lease keyed by the reader's own query text, so each
    // distinct search leaves a row behind and nothing else ever removes one. A lapsed lease
    // guards nothing, so the tick drops the expired per-symbol rows.
    context.waitUntil(import('./server/tastytrade-market-store')
      .then(({ sweepExpiredSymbolRefreshLeases }) => sweepExpiredSymbolRefreshLeases(env, scheduledAt))
      .then((leaseCount) => console.info(JSON.stringify({
        event: 'SymbolRefreshLeasesSwept',
        leaseCount,
      })))
      .catch((cause: unknown) => console.error(
        'SymbolRefreshLeaseSweepFailed',
        cause instanceof Error ? cause.name : 'UnknownError',
      )))
  },
}
