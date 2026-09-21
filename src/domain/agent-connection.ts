import { z } from 'zod'

/**
 * Whether an agent has ever reached Heston as this member, which is what the recommendations
 * tab needs before it asks them to run a brief. MCP is stateless HTTP, so there is no live
 * connection to report; what can be known is that a client was authorized or a token was
 * used. `lastSeenAt` is the newest headless-token use and is refreshed at most hourly, so it
 * is approximate by design; an OAuth-connected client leaves no per-call trace, so for one
 * `connected` is the whole answer.
 */
export const AgentConnectionSchema = z.strictObject({
  connected: z.boolean(),
  lastSeenAt: z.string().optional(),
})

export type AgentConnection = z.infer<typeof AgentConnectionSchema>
