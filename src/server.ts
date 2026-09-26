import handler from '@tanstack/react-start/server-entry'

import { handleWellKnownDiscovery } from './server/auth'
import { type AppEnv } from './server/env'
import { canonicalHostRedirect, finalizeDocumentResponse } from './server/http'
import { mcpEndpointRedirect } from './server/mcp-endpoint-redirect'
import { configureTypeboxRuntime } from './server/typebox-runtime'
import { MCP_PATH } from './domain/site'

/*
 * The MCP surface and the scheduled jobs are loaded when a request needs them rather than when
 * the isolate starts. Each pulls a large dependency graph — the MCP server, the broker client,
 * the research pipeline — that a visitor fetching the market never runs, and a cold isolate pays
 * for every module it evaluates before it can answer anyone. Auth is not among them: `http.ts`
 * reads the session on every document response, so better-auth is in the startup graph already
 * and OAuth discovery is imported statically.
 */
const mcpSurface = () => import('./server/mcp')

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
      const discovery = await handleWellKnownDiscovery(request, env)
      if (discovery) return discovery
    }
    // The tool surface for the agent each caller runs on their own machine -- the owner, any
    // member, or an anonymous caller at the public tier. Bearer-authed inside the handler; the
    // session/cookie path stays untouched and the token opens nothing else.
    if (url.pathname === MCP_PATH) return (await mcpSurface()).handleMcpRequest(request, env, ctx)
    // An agent aimed at the site rather than at `/mcp` would otherwise be handed the web app's
    // HTML with a 200 and fail inside its JSON parser, saying nothing useful to anyone. The
    // probe is its own zod-only module, so an ordinary JSON POST never loads the MCP graph; the
    // redirect it answers with needs nothing from that graph either.
    const misdirected = await mcpEndpointRedirect(request)
    if (misdirected) return misdirected
    return finalizeDocumentResponse(request, await handler.fetch(request))
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime)
    // The year chart is decoration over live prices, so a failed refresh leaves the last good
    // series in place rather than failing the tick. Record the degraded run without logging
    // symbols or provider content.
    context.waitUntil(import('./server/scheduled-jobs')
      .then(({ refreshYearCandles, yearCandleRefreshEvent }) => (
        refreshYearCandles(env, scheduledAt).then(yearCandleRefreshEvent)
      ))
      .then((event) => console.info(JSON.stringify(event)))
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
    // Every distinct valid-pattern ticker a reader searches leaves an unresolved catalog
    // placeholder; one whose retry interval has lapsed already reads as missing, so the tick
    // deletes it rather than letting the table grow with every junk query ever typed.
    context.waitUntil(import('./server/instrument-catalog')
      .then(({ sweepStaleUnresolvedInstruments }) => sweepStaleUnresolvedInstruments(env, scheduledAt))
      .then((instrumentCount) => console.info(JSON.stringify({
        event: 'UnresolvedInstrumentsSwept',
        instrumentCount,
      })))
      .catch((cause: unknown) => console.error(
        'UnresolvedInstrumentSweepFailed',
        cause instanceof Error ? cause.name : 'UnknownError',
      )))
    // A member's lapsed brokerage connections are dropped whenever they start another; the tick
    // drops those of members who never came back.
    context.waitUntil(import('./server/broker-authorizations')
      .then(({ sweepExpiredBrokerAuthorizations }) => sweepExpiredBrokerAuthorizations(env, scheduledAt))
      .then((authorizationCount) => console.info(JSON.stringify({
        event: 'BrokerAuthorizationsSwept',
        authorizationCount,
      })))
      .catch((cause: unknown) => console.error(
        'BrokerAuthorizationSweepFailed',
        cause instanceof Error ? cause.name : 'UnknownError',
      )))
  },
}
