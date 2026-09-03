import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type TSchema } from 'typebox'

import { OrderPlacementParameters } from './agent-contracts'
import { placeBrokerageOrder } from './order-placement'
import { createBrokerageReconciliationTool } from './brokerage-reconciliation'
import {
  createBrokerageReadTools,
  createInstrumentQuoteReadTool,
  createMarketMetricsReadTool,
  createOptionContractFindTool,
} from './brokerage-read-tools'
import { type AppEnv } from './env'
import { createExactOptionGreeksReadTool } from './option-greeks-tool'
import { createRecentCoverageTool, createRedditIngestTool } from './research-agent-tools'
import { DailyRecommendationsSubmissionSchema } from './research-submission'
import { publishSubmittedDailyRecommendations } from './research-publish'
import { createResearchReadTools } from './research-read-tools'
import { readStoredSecret } from './secrets'
import { createWatchlistReadTool } from './watchlist-tool'
import {
  BrokerCredentialMissingError,
  brokerCredentialFromHeaders,
  type BrokerCredential,
} from './broker-credential'

/**
 * The web app as a tool surface for an agent that runs on the owner's machine. Agent loops do
 * not run in this Worker any more — a year of closes, a grown conversation, and a 128 MB
 * isolate were a bad fit three failed runs proved — so the Worker keeps what it is good at:
 * authoritative reads, the deterministic guards, and the stores.
 *
 * Every tool here is stateless per call; all state lives in D1 and at the broker, which is
 * why the stateless handler lane fits and no Durable Object is involved.
 */
/**
 * SAFETY: a TypeBox schema is a plain JSON Schema object at runtime. `TUnsafe` (which the
 * order-placement union uses) merely hides the structural properties from the type system,
 * not from the wire, so widening through `unknown` asserts nothing that is not already true.
 */
function orderPlacementJsonSchema(): JsonSchemaType {
  const schema: unknown = OrderPlacementParameters
  // SAFETY: see above — the runtime value is the JSON Schema the type hides.
  return schema as JsonSchemaType
}

/** SAFETY: as above — the submission schema's TUnsafe members are plain JSON Schema on the wire. */
function submissionJsonSchema(): JsonSchemaType {
  const schema: unknown = DailyRecommendationsSubmissionSchema
  // SAFETY: see above — the runtime value is the JSON Schema the type hides.
  return schema as JsonSchemaType
}

export function createSpiceMcpServer(env: AppEnv, credential?: BrokerCredential): McpServer {
  const server = new McpServer({ name: 'spice', version: '1.0.0' })

  const tools: AgentTool<TSchema>[] = [
    // The bundle carries only the account-flavored pair; the market reads are standalone
    // factories, and leaving them to the bundle silently served a two-tool market surface.
    ...createBrokerageReadTools(env, credential),
    createMarketMetricsReadTool(env),
    createOptionContractFindTool(env),
    createInstrumentQuoteReadTool(env),
    ...createResearchReadTools(env),
    createWatchlistReadTool(env),
    createExactOptionGreeksReadTool(env),
    // Discovery for the local research run: WSB candidates and prior-coverage reads are
    // private context behind the same bearer token, never part of any public surface.
    createRedditIngestTool(env),
    createRecentCoverageTool(env),
    // An ambiguous submission quarantines the account. The agent must be able to clear it,
    // because nothing else can: reconciliation needs the caller's own broker credential.
    createBrokerageReconciliationTool(env, credential),
  ]
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // TypeBox parameter schemas are plain JSON Schema, which is what MCP advertises.
        inputSchema: fromJsonSchema(tool.parameters),
      },
      async (params) => {
        try {
          // SAFETY: the SDK validated `params` against this very tool's own JSON Schema before
          // dispatch, which is exactly the contract `execute` states for its parameters.
          const result = await tool.execute(crypto.randomUUID(), params as never)
          // AgentToolResult content is already MCP CallToolResult content for text parts.
          return { content: result.content.filter((part) => part.type === 'text') }
        } catch (error) {
          // A disconnected brokerage is an actionable tool result, not an MCP transport failure.
          if (error instanceof BrokerCredentialMissingError) {
            return { content: [{ text: error.message, type: 'text' as const }] }
          }
          throw error
        }
      },
    )
  }

  server.registerTool(
    'place_brokerage_order',
    {
      description: 'PLACES a real equity, option, debit vertical, or price-replacement order '
        + 'against the connected brokerage account. Supply every field explicitly: the server '
        + 'never fills in, enlarges, or reinterprets one. A fully specified user-directed order '
        + 'is placed without endorsement. The server resolves the exact contract from the live '
        + 'chain, runs its portfolio and market guards, and requires a clean broker dry-run '
        + 'before submitting; it refuses on its own authority and the refusal is final.',
      inputSchema: fromJsonSchema(orderPlacementJsonSchema()),
      // A conforming client prompts its user on every call to a tool marked this way, and
      // offers no "don't ask again". That is worth having, but it is not a boundary: the
      // server cannot verify a prompt happened, and another client may ignore the flag
      // entirely. What actually bounds the damage is the guard chain below it.
      _meta: { 'anthropic/requiresUserInteraction': true },
    },
    async (params) => {
      try {
        // SAFETY: `placeBrokerageOrder` re-parses its input with OrderPlacementSchema at the
        // trust boundary regardless of what the transport already checked.
        const receipt = await placeBrokerageOrder(env, params as never, credential)
        return { content: [{ text: JSON.stringify(receipt), type: 'text' as const }] }
      } catch (error) {
        if (error instanceof BrokerCredentialMissingError) {
          return { content: [{ text: error.message, type: 'text' as const }] }
        }
        throw error
      }
    },
  )

  server.registerTool(
    'publish_daily_recommendations',
    {
      description: 'Submit the day\'s finished research brief for publication. The server '
        + 'reads every cited page itself and refuses any quote or catalyst date it cannot '
        + 'find in that text; a rejected submission returns the exact reasons so citations '
        + 'can be fixed and the brief submitted again. Publishing replaces the current '
        + 'market date\'s brief and posts it to the public channel.',
      inputSchema: fromJsonSchema(submissionJsonSchema()),
    },
    async (params) => {
      // SAFETY: `publishSubmittedDailyRecommendations` re-parses its input with the same
      // submission schema at the trust boundary regardless of what the transport checked.
      const publication = await publishSubmittedDailyRecommendations(env, params as never)
      return { content: [{ text: JSON.stringify(publication), type: 'text' as const }] }
    },
  )

  return server
}

/**
 * A bearer token, not a session: the caller is a headless process on the owner's machine, and
 * a cookie jar is the wrong shape for it. Digests are compared rather than the strings, which
 * removes length as a signal, and the comparison runs the full width regardless of where the
 * first difference falls.
 */
export async function mcpTokenMatches(request: Request, env: AppEnv): Promise<boolean> {
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return false
  const presented = header.slice('Bearer '.length).trim()
  if (!presented) return false
  let expected: string
  try {
    expected = await readStoredSecret(env.SPICE_MCP_TOKEN, 'SPICE_MCP_TOKEN')
  } catch {
    // No configured token means no MCP access, never open access.
    return false
  }
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

/**
 * All the stateless MCP handler ever reads from the platform context is `props`, which carries
 * OAuth material this server does not use. Naming that slice lets a test hand in a plain object
 * instead of imitating the whole platform type.
 */
export type McpExecutionContext = Pick<ExecutionContext, 'props' | 'waitUntil'>

export async function handleMcpRequest(request: Request, env: AppEnv, ctx: McpExecutionContext): Promise<Response> {
  if (!await mcpTokenMatches(request, env)) {
    console.error('McpAuthRejected')
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const credential = brokerCredentialFromHeaders(request.headers)
  // SAFETY: the handler reads only `props` from the context (verified against its dist), which
  // McpExecutionContext carries; the platform type's other members are never touched.
  return createMcpHandler(() => createSpiceMcpServer(env, credential), { route: '/mcp' })(request, env, ctx as ExecutionContext)
}
