import {
  McpServer,
  OAuthError,
  bearerAuthChallengeResponse,
  fromJsonSchema,
  type JsonSchemaType,
} from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { type AgentTool } from '../domain/agent-tool'
import { type TSchema } from 'typebox'
import { z } from 'zod'

import { CancelOrderParameters, CancelOrderSchema, OrderPlacementParameters } from './agent-contracts'
import { cancelBrokerageOrder, placeBrokerageOrder } from './order-placement'
import { createBrokerageReconciliationTool } from './brokerage-reconciliation'
import { createCatalystRecordTool } from './catalyst-record-tool'
import { createSymbolEvidenceTool } from './symbol-evidence-tool'
import {
  createBrokerageReadTools,
  createInstrumentQuoteReadTool,
  createMarketMetricsReadTool,
  createOptionContractFindTool,
} from './brokerage-read-tools'
import { type AppEnv } from './env'
import { createMarketResearchTools } from './market-research-tools'
import { createPublicMarketReadTools } from './public-market-tools'
import { noteSymbolAttention, readsSymbols, type SymbolNamingCall } from './symbol-attention'
import { createExactOptionGreeksReadTool } from './option-greeks-tool'
import { createRecommendationChallengeTool } from './recommendation-challenge'
import { createRecentCoverageTool, createRedditIngestTool } from './research-agent-tools'
import { DailyRecommendationsSubmissionSchema } from './research-submission'
import { publishSubmittedDailyRecommendations } from './research-publish'
import { createResearchReadTools } from './research-read-tools'
import {
  dailyResearchPrompt,
  PORTFOLIO_REVIEW_PROMPT,
  SPICE_GUIDE,
  spiceMcpInstructions,
  tradeIdeaPrompt,
} from './doctrine'
import { toolAnnotations } from './mcp-annotations'
import { authenticateMcpToken } from './mcp-tokens'
import { getAuthRuntime, isOwnerEmail } from './auth'
import { verifyMcpAccessToken } from './mcp-token-verify'
import { createRememberSymbolsTool, createWatchlistManageTool, createWatchlistReadTool } from './watchlist-tool'
import {
  BrokerCredentialMissingError,
  brokerCredentialFromHeaders,
  type BrokerCredential,
} from './broker-credential'

function asJsonSchema(schema: TSchema): JsonSchemaType {
  // SAFETY: a TypeBox schema is a plain JSON Schema object at runtime. `TUnsafe` (which the
  // order-placement union and the submission schema use) merely hides the structural properties
  // from the type system, not from the wire, so this asserts nothing that is not already true.
  return schema as JsonSchemaType
}

/**
 * The web app as a tool surface for an agent that runs on the owner's machine. Agent loops do
 * not run in this Worker any more — a year of closes, a grown conversation, and a 128 MB
 * isolate were a bad fit three failed runs proved — so the Worker keeps what it is good at:
 * authoritative reads, the deterministic guards, and the stores.
 *
 * Every tool here is stateless per call; all state lives in D1 and at the broker, which is
 * why the stateless handler lane fits and no Durable Object is involved.
 */
export function createSpiceMcpServer(
  env: AppEnv,
  caller: McpCaller,
  credential?: BrokerCredential,
  scheduleTask?: (task: Promise<unknown>) => void,
): McpServer {
  // `instructions` reaches the caller's agent as system context, so it is assembled only from
  // this repository's own constants and never from anything a provider or model supplied. It is
  // built for this caller's tier: it is paid for on every turn, and a rule about a tool they
  // were not given is a per-turn tax on a refusal they cannot reach.
  const server = new McpServer(
    { name: 'spice', version: '1.0.0' },
    { instructions: spiceMcpInstructions(caller.signedIn) },
  )
  // Scheduling rather than awaiting: a search the caller did not ask for must not lengthen the
  // turn they did ask for. Absent in a test harness, where doing the work inline is correct.
  const waitUntil = (task: Promise<unknown>) => { scheduleTask?.(task) }

  const tools: AgentTool<TSchema>[] = [
    // Price history is the only historical read there is: quotes, metrics, chains and Greeks
    // are all "right now". Without it a connected agent cannot answer how a name has moved,
    // where it sits against its own range, or anything a study describes -- so it was left
    // guessing on exactly the questions a trader asks first. Yahoo, not this Worker's broker
    // quota, so it costs an anonymous caller nothing the website does not already spend.
    ...createMarketResearchTools(),
    // D1 reads. Already public through the website, and free of any per-call provider cost.
    ...createResearchReadTools(env),
    createWatchlistReadTool(env),
    // Quotes and metrics exist at both tiers and mean different things: a signed-in caller asks
    // the broker on every call, an anonymous one reads the website's cached snapshot. They share
    // a name, so the tier chooses which is registered rather than both colliding.
    ...(caller.signedIn
      ? [
        // The bundle carries only the account-flavored pair; the market reads are standalone
        // factories, and leaving them to the bundle silently served a two-tool market surface.
        ...createBrokerageReadTools(env, credential),
        createMarketMetricsReadTool(env),
        createOptionContractFindTool(env),
        createInstrumentQuoteReadTool(env),
        createExactOptionGreeksReadTool(env),
        // Writing to the shared watchlist, and clearing a quarantined submission, are acts that
        // want an account behind them even though neither touches one directly.
        createRememberSymbolsTool(env),
        createBrokerageReconciliationTool(env, credential),
        // Challenging the standing brief belongs with publishing it, and for the same reason:
        // a challenge can only ever trigger the server's own re-read of pages the server itself
        // published -- it injects nothing and names no address -- but it spends page reads, and
        // a cost the site pays wants a name behind it.
        createRecommendationChallengeTool(env),
        // Writing research back to the site between briefs: dated events for every reader's
        // calendar, and the passages a member's agent read them in. Both are bound against
        // pages this Worker re-reads, so what the tier adds is a name behind the row.
        createCatalystRecordTool(env),
        createSymbolEvidenceTool(env, caller.userId),
      ]
      : createPublicMarketReadTools(env, waitUntil)),
    // Private Reddit discovery and removing a name from the shared watchlist are owner acts. A
    // member is not shown a surface they cannot use, so these are absent from their tool list
    // rather than present and refused.
    ...(caller.owner
      ? [createRedditIngestTool(env), createRecentCoverageTool(env), createWatchlistManageTool(env)]
      : []),
  ]
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        annotations: toolAnnotations(tool.name),
        description: tool.description,
        // TypeBox parameter schemas are plain JSON Schema, which is what MCP advertises.
        inputSchema: fromJsonSchema(tool.parameters),
      },
      async (params) => {
        try {
          // SAFETY: the SDK validated `params` against this very tool's own JSON Schema before
          // dispatch, which is exactly the contract `execute` states for its parameters.
          const result = await tool.execute(crypto.randomUUID(), params as never)
          // Reading a symbol is the same signal a reader opening it on the site is, and buys the
          // same bounded catalyst search for everyone. Scheduled after the answer, never blocking
          // it; `symbol-attention.ts` carries the reasoning and the bound.
          if (readsSymbols(tool.name)) {
            // SAFETY: `noteSymbolAttention` re-parses this with its own schema and ignores a call
            // that names no symbol, so a shape it does not expect costs nothing.
            waitUntil(noteSymbolAttention(env, params as SymbolNamingCall))
          }
          // AgentToolResult content is already MCP CallToolResult content for text parts.
          return { content: result.content.filter((part) => part.type === 'text') }
        } catch (error) {
          // A disconnected brokerage is a tool execution error, not a protocol error: the spec
          // asks servers to return these with `isError` so the model can act on them, and the
          // message names the setup step rather than looking like a transport failure.
          if (error instanceof BrokerCredentialMissingError) {
            return { content: [{ text: error.message, type: 'text' as const }], isError: true }
          }
          throw error
        }
      },
    )
  }

  // Placement and cancellation need a broker credential, which needs a member. Advertising them
  // to a caller who presented nothing would offer a destructive tool that can only ever refuse --
  // the same reason the owner tools are absent from a member's list rather than present.
  if (caller.signedIn) registerOrderTools(server, env, credential)

  server.registerPrompt(
    'portfolio_review',
    {
      description: 'Review every open position against the account\'s risk posture.',
      title: 'Portfolio review',
    },
    () => ({ messages: [{ content: { text: PORTFOLIO_REVIEW_PROMPT, type: 'text' as const }, role: 'user' as const }] }),
  )

  server.registerPrompt(
    'evaluate_trade_idea',
    {
      argsSchema: z.object({
        symbol: z.string().min(1).max(16).describe('Underlying ticker'),
        thesis: z.string().min(1).max(2_000).describe('The case to test, in the user\'s own words'),
      }),
      description: 'Test a trade idea against evidence, timing, and the account\'s loss budget.',
      title: 'Evaluate a trade idea',
    },
    ({ symbol, thesis }) => ({
      messages: [{ content: { text: tradeIdeaPrompt(symbol, thesis), type: 'text' as const }, role: 'user' as const }],
    }),
  )

  // Listed at connect time, fetched only when something wants it -- the orientation that is too
  // long for `instructions` (a per-turn cost) and unreachable in a prompt (user-invoked).
  // Registered for every tier, including the anonymous one: `instructions` points every caller
  // at this URI, and the guide describes the credential-free tier as well.
  server.registerResource(
    'guide',
    'spice://guide',
    { description: 'What Spice can answer and which tool answers it.', mimeType: 'text/markdown', title: 'Spice guide' },
    (uri) => ({ contents: [{ text: SPICE_GUIDE, uri: uri.href }] }),
  )

  // Any member's agent may produce the public brief; the site does not wait on a schedule or on
  // the owner's machine. What keeps that safe is not who calls it but what the boundary does
  // with the call: every cited page is re-read here, the binders run here, the refresh interval
  // is enforced here, and nothing partial publishes. Withheld from the anonymous tier because
  // a brief carries a name readers can hold to account, and a token is that name.
  if (caller.signedIn) {
    server.registerTool(
      'publish_daily_recommendations',
      {
        description: 'Submit a finished research brief for publication on the public site. The '
          + 'server reads every cited page itself and refuses any quote or catalyst date it '
          + 'cannot find in that text; a rejected submission returns the exact reasons so '
          + 'citations can be fixed and the brief submitted again. Publishing replaces the '
          + 'current brief, and is refused while the last one is younger than the refresh '
          + 'interval. `model` is published with the brief.',
        annotations: toolAnnotations('publish_daily_recommendations'),
        inputSchema: fromJsonSchema(asJsonSchema(DailyRecommendationsSubmissionSchema)),
      },
      async (params) => {
        // SAFETY: `publishSubmittedDailyRecommendations` re-parses its input with the same
        // submission schema at the trust boundary regardless of what the transport checked.
        // The publishing member is recorded privately with the brief; the byline the reader
        // sees is whatever that member put in the submission, and is never derived from this.
        const publication = await publishSubmittedDailyRecommendations(env, params as never, {
          publishedByUserId: caller.userId,
        })
        return { content: [{ text: JSON.stringify(publication), type: 'text' as const }] }
      },
    )
    // The run itself, offered exactly where publishing is: a prompt that ends in a tool the
    // caller does not have would send an anonymous agent all the way to a refusal.
    server.registerPrompt(
      'daily_research',
      {
        description: 'Research today\'s market, write the brief, and publish it to the site.',
        title: 'Daily research',
      },
      () => ({ messages: [{ content: { text: dailyResearchPrompt(caller.owner), type: 'text' as const }, role: 'user' as const }] }),
    )
  }

  return server
}


/** The guarded mutations. Registered only for a caller who could hold a broker credential. */
function registerOrderTools(
  server: McpServer,
  env: AppEnv,
  credential: BrokerCredential | undefined,
): void {
  server.registerTool(
    'place_brokerage_order',
    {
      description: 'PLACES a real equity, option, debit vertical, or price-replacement order '
        + 'against the connected brokerage account. Supply every field explicitly: the server '
        + 'never fills in, enlarges, or reinterprets one. A fully specified user-directed order '
        + 'is placed without endorsement. The server resolves the exact contract from the live '
        + 'chain, runs its portfolio and market guards, and requires a clean broker dry-run '
        + 'before submitting; it refuses on its own authority and the refusal is final.',
      inputSchema: fromJsonSchema(asJsonSchema(OrderPlacementParameters)),
      // Annotated destructive and non-idempotent so a client can see that calling this twice
      // places two orders. Annotations are hints a client may ignore, and the spec says to
      // treat them as untrusted anyway — they inform a confirmation prompt, they are not one.
      // What bounds the damage is the guard chain below.
      annotations: toolAnnotations('place_brokerage_order'),
    },
    async (params) => {
      try {
        // SAFETY: `placeBrokerageOrder` re-parses its input with OrderPlacementSchema at the
        // trust boundary regardless of what the transport already checked.
        const receipt = await placeBrokerageOrder(env, params as never, credential)
        return { content: [{ text: JSON.stringify(receipt), type: 'text' as const }] }
      } catch (error) {
        if (error instanceof BrokerCredentialMissingError) {
          return { content: [{ text: error.message, type: 'text' as const }], isError: true }
        }
        throw error
      }
    },
  )

  server.registerTool(
    'cancel_brokerage_order',
    {
      description: 'Cancel one working order on the connected brokerage account. The placement '
        + 'guard refuses a new order while any order is working, so this is how a stuck order is '
        + 'cleared. An ambiguous result is reported as ambiguous and is never retried: read the '
        + 'account history to find out what happened before doing anything else.',
      inputSchema: fromJsonSchema(asJsonSchema(CancelOrderParameters)),
      // Destructive but idempotent: cancelling an order already cancelled changes nothing
      // further, which is the useful thing for a client to know after an ambiguous result.
      annotations: toolAnnotations('cancel_brokerage_order'),
    },
    async (params) => {
      try {
        // SAFETY: re-parsed here at the trust boundary regardless of what the transport checked.
        const { orderId } = CancelOrderSchema.parse(params)
        const receipt = await cancelBrokerageOrder(env, orderId, credential)
        return { content: [{ text: JSON.stringify(receipt), type: 'text' as const }] }
      } catch (error) {
        if (error instanceof BrokerCredentialMissingError) {
          return { content: [{ text: error.message, type: 'text' as const }], isError: true }
        }
        throw error
      }
    },
  )
}

/**
 * Who is calling. A bearer token, not a session: the caller is a headless agent on a member's
 * own machine and a cookie jar is the wrong shape for it. Ownership is decided by the same
 * `isOwnerEmail` the cookie surface uses, so there is exactly one definition of it.
 *
 * Every caller is a row in `user_mcp_tokens`. The shared `SPICE_MCP_TOKEN` that authenticated as
 * the owner during the pivot is gone: it could not be revoked, did not die with the account, sat
 * outside the per-member cap, and left no trace of use, which is everything the token table
 * exists to fix.
 */
export type McpCaller = {
  owner: boolean
  /** False for a caller who presented no credential at all. */
  signedIn: boolean
  tokenId: string
  userId: string
}

/**
 * The caller who presented nothing.
 *
 * Reads the website's own cached snapshot and the rows behind it, so an agent can answer a market
 * question with no setup at all -- the same data a visitor gets, out of the same cache entry, at
 * the same cost. Everything that spends a per-call broker request, writes to shared state, or
 * touches an account stays behind a credential.
 */
export const ANONYMOUS_CALLER: McpCaller = { owner: false, signedIn: false, tokenId: '', userId: '' }

export async function resolveMcpCaller(request: Request, env: AppEnv): Promise<McpCaller | undefined> {
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return undefined
  const presented = header.slice('Bearer '.length).trim()
  if (!presented) return undefined

  // No store means no way to recognise anyone: no access, never open access.
  if (!env.DB) return undefined
  const identity = await authenticateMcpToken(env.DB, presented)
  if (!identity) return undefined
  return callerForUser(env, identity.userId, identity.tokenId)
}

/**
 * All the stateless MCP handler ever reads from the platform context is `props`, which carries
 * OAuth material this server does not use. Naming that slice lets a test hand in a plain object
 * instead of imitating the whole platform type.
 */
export type McpExecutionContext = Pick<ExecutionContext, 'props' | 'waitUntil'>

/** Ownership is decided by the same `isOwnerEmail` the cookie surface uses, in one place. */
async function callerForUser(
  env: AppEnv,
  userId: string,
  tokenId: string,
): Promise<McpCaller | undefined> {
  if (!env.DB) return undefined
  const row = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?')
    .bind(userId).first<{ email: string }>()
  // A row without an email cannot be the owner; absence is never elevated.
  return { owner: Boolean(row?.email) && isOwnerEmail(row?.email ?? ''), signedIn: true, tokenId, userId }
}

function serveMcp(
  request: Request,
  env: AppEnv,
  ctx: McpExecutionContext,
  caller: McpCaller,
): Promise<Response> {
  const credential = brokerCredentialFromHeaders(request.headers)
  // SAFETY: the handler reads only `props` from the context (verified against its dist), which
  // McpExecutionContext carries; the platform type's other members are never touched.
  return createMcpHandler(() => createSpiceMcpServer(env, caller, credential, (task) => ctx.waitUntil(task)), {
    route: '/mcp',
    // Out-of-band failures — a rejected request, an error raised after the response is under
    // way — are otherwise dropped without a trace. Named, never bodied: the argument may carry
    // provider or caller content, so only the error's own name is recorded.
    onerror: (error: Error) => console.error('McpHandlerError', error.name),
  })(request, env, ctx as ExecutionContext)
}

/**
 * Two ways in, for two kinds of caller.
 *
 * A person at a terminal authenticates with OAuth: their client discovers this server, registers
 * itself, and sends them through Google in a browser. A machine that runs alone cannot do any of
 * that -- the daily research run is a systemd oneshot with no browser and no interactive session
 * -- so a minted `user_mcp_tokens` row stays the non-interactive path. Both resolve to the same
 * user id, so nothing downstream can tell them apart, which is the point.
 *
 * The minted token is tried first because recognising one is a regex and a single indexed read.
 * Anything else is handed to the provider, which verifies the signature, issuer, audience and
 * expiry against the published JWKS and answers an unauthenticated caller with the RFC 9728
 * challenge naming the discovery document. That challenge is what makes the flow self-starting,
 * and it is why this no longer hand-writes one.
 */
export async function handleMcpRequest(request: Request, env: AppEnv, ctx: McpExecutionContext): Promise<Response> {
  const minted = await resolveMcpCaller(request, env)
  if (minted) return serveMcp(request, env, ctx, minted)

  // No credential at all is a caller, not a refusal. The public market surface has always been
  // readable without an account through the website, and an agent asking the same question should
  // not need more than a visitor does. A credential that is *present* and does not verify still
  // gets the challenge below: that is a caller trying to authenticate and failing, which they can
  // act on, rather than one who never claimed to be anybody.
  if (!request.headers.get('Authorization')) return serveMcp(request, env, ctx, ANONYMOUS_CALLER)

  let runtime
  try {
    runtime = await getAuthRuntime(env)
  } catch (error) {
    // Without the authorization server nobody can be recognised, so the caller is unauthenticated
    // and told so. Not a 500: whether this server can reach its own auth is not the caller's
    // business and is not something they can act on, and answering anything but a refusal here
    // would be the one shape that risks opening the surface. The outage is observable in this log
    // line rather than in the status code.
    console.error('McpAuthUnavailable', error instanceof Error ? error.name : 'UnknownError')
    return bearerAuthChallengeResponse(new OAuthError('invalid_token', 'Spice could not verify this request.'))
  }

  const presented = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!presented) {
    return bearerAuthChallengeResponse(new OAuthError('invalid_token', 'Send the token as a bearer credential.'))
  }
  let claims
  try {
    claims = await verifyMcpAccessToken(runtime.auth, presented, {
      audience: runtime.mcpResource,
      issuer: runtime.authIssuer,
    })
  } catch (error) {
    // Refuse, never throw. A 500 from the auth path tells a caller nothing they can act on and
    // loses the challenge that would let them authenticate; it also reads as a broken endpoint
    // rather than a bad token, which is how a whole broken flow stayed invisible.
    console.error('McpOAuthVerificationFailed', error instanceof Error ? error.name : 'UnknownError')
    return bearerAuthChallengeResponse(new OAuthError('invalid_token', 'Spice could not verify this token.'))
  }

  const caller = await callerForUser(env, claims.sub, `oauth:${claims.jti ?? claims.sub}`)
  // A token whose subject is not a user this server knows authenticates nothing.
  if (!caller) {
    console.error('McpAuthRejected')
    return bearerAuthChallengeResponse(new OAuthError('invalid_token', 'This token does not identify a Spice member.'))
  }
  return serveMcp(request, env, ctx, caller)
}


/**
 * The JSON-RPC answer for an MCP client that connected to the wrong path.
 *
 * People are told to point their agent at Spice, and the natural thing to type is the site's
 * own address rather than the endpoint under it. That request lands on the web app, which
 * answers `200 text/html`, and the client fails somewhere inside its JSON parser — the one
 * failure mode that tells the user nothing at all. A JSON-RPC error naming the endpoint is
 * something an agent can read and act on, and a browser never sends a request shaped like this.
 *
 * Returns undefined when the request is not an MCP handshake, so every ordinary request —
 * including a server function posting JSON — passes through untouched.
 */
export async function mcpEndpointRedirect(request: Request): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined
  if (!request.headers.get('content-type')?.includes('application/json')) return undefined
  const body: unknown = await request.clone().json().catch(() => undefined)
  const probe = z.object({ jsonrpc: z.literal('2.0'), method: z.string() }).safeParse(body)
  if (!probe.success) return undefined
  const endpoint = new URL('/mcp', request.url).toString()
  return Response.json({
    error: {
      code: -32_600,
      message: `Spice's MCP endpoint is ${endpoint} — this address serves the web app. Reconnect to ${endpoint}.`,
    },
    id: null,
    jsonrpc: '2.0',
  }, { status: 404 })
}
