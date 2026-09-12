import { type AgentConnection } from '../domain/agent-connection'

/**
 * Two stores answer this, because there are two ways an agent connects. A minted token is our
 * own row and carries the last use we recorded for it. An OAuth client is the provider's row:
 * consent is granted only through an MCP client's authorization flow, so a consent row is an
 * agent that connected -- and its dates are the provider's, in a format this code does not
 * own, so only the row's existence is read. Scoped by user id on both reads; nothing here
 * can describe anyone else's agent.
 */
export async function readAgentConnection(database: D1Database, userId: string): Promise<AgentConnection> {
  const [tokens, consents] = await Promise.all([
    database.prepare(
      `SELECT COUNT(*) AS count, MAX(last_used_at) AS last_used_at
         FROM user_mcp_tokens
        WHERE user_id = ?`,
    ).bind(userId).first<{ count: number; last_used_at: string | null }>(),
    database.prepare(
      'SELECT COUNT(*) AS count FROM "oauthConsent" WHERE "userId" = ?',
    ).bind(userId).first<{ count: number }>(),
  ])
  const connection: AgentConnection = {
    connected: (tokens?.count ?? 0) > 0 || (consents?.count ?? 0) > 0,
  }
  // Absent rather than null: a token that was issued and never used is a real fact about it.
  if (tokens?.last_used_at) connection.lastSeenAt = tokens.last_used_at
  return connection
}
