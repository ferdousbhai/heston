import { AgentConnectionSchema, type AgentConnection } from '../domain/agent-connection'

/** The member's own agent; the route scopes the read to them, so the session is the whole query. */
export async function loadAgentConnection(signal?: AbortSignal): Promise<AgentConnection> {
  const response = await fetch('/api/agent-connection', { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`Agent connection request failed (${response.status})`)
  return AgentConnectionSchema.parse(await response.json())
}
