import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import { type TSchema } from 'typebox'

import { OrderPlacementParameters } from './agent-contracts'
import { preparePendingAction } from './agent'
import {
  createBrokerageReadTools,
  createInstrumentQuoteReadTool,
  createMarketMetricsReadTool,
  createOptionContractFindTool,
} from './brokerage-read-tools'
import { type AppEnv } from './env'
import { createExactOptionGreeksReadTool } from './option-greeks-tool'
import { DailyRecommendationsSubmissionSchema } from './research-agent'
import { publishSubmittedDailyRecommendations } from './research-publish'
import { createResearchReadTools } from './research-read-tools'
import { readStoredSecret } from './secrets'
import { createWatchlistReadTool } from './watchlist-tool'

/**
 * The web app as a tool surface for an agent that runs on the owner's machine. Agent loops do
 * not run in this Worker any more — a year of closes, a grown conversation, and a 128 MB
 * isolate were a bad fit three failed runs proved — so the Worker keeps what it is good at:
 * authoritative reads, the draft boundary, and the stores.
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

export function createSpiceMcpServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: 'spice', version: '1.0.0' })

  const tools: AgentTool<TSchema>[] = [
    // The bundle carries only the account-flavored pair; the market reads are standalone
    // factories, and leaving them to the bundle silently served a two-tool market surface.
    ...createBrokerageReadTools(env),
    createMarketMetricsReadTool(env),
    createOptionContractFindTool(env),
    createInstrumentQuoteReadTool(env),
    ...createResearchReadTools(env),
    createWatchlistReadTool(env),
    createExactOptionGreeksReadTool(env),
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
        // SAFETY: the SDK validated `params` against this very tool's own JSON Schema before
        // dispatch, which is exactly the contract `execute` states for its parameters.
        const result = await tool.execute(crypto.randomUUID(), params as never)
        // AgentToolResult content is already MCP CallToolResult content for text parts.
        return { content: result.content.filter((part) => part.type === 'text') }
      },
    )
  }

  server.registerTool(
    'prepare_brokerage_action',
    {
      description: 'Draft an equity, option, debit vertical, or price replacement. '
        + 'Drafting never places an order: the draft expires in five minutes and only the '
        + 'owner can confirm it, in the web app, on a channel this tool cannot reach.',
      inputSchema: fromJsonSchema(orderPlacementJsonSchema()),
    },
    async (params) => {
      // SAFETY: `preparePendingAction` re-parses its input with OrderPlacementSchema at the
      // trust boundary regardless of what the transport already checked.
      const pending = await preparePendingAction(env, params as never)
      // The confirmation token stays server-side on purpose. Handing it to the caller would
      // let the same process that drafted the order confirm it, and the entire value of the
      // boundary is that the confirming channel is not the agent's channel.
      return {
        content: [{
          text: JSON.stringify({
            actionId: pending.id,
            expiresAt: pending.expiresAt,
            preview: pending.preview,
            status: 'awaiting_owner_confirmation',
          }),
          type: 'text' as const,
        }],
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
  // SAFETY: the handler reads only `props` from the context (verified against its dist), which
  // McpExecutionContext carries; the platform type's other members are never touched.
  return createMcpHandler(() => createSpiceMcpServer(env), { route: '/mcp' })(request, env, ctx as ExecutionContext)
}
