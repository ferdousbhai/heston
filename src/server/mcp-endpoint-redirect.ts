import { z } from 'zod'

/**
 * The JSON-RPC answer for an MCP client that connected to the wrong path.
 *
 * People are told to point their agent at spicy.trade, and the natural thing to type is the site's
 * own address rather than the endpoint under it. That request lands on the web app, which
 * answers `200 text/html`, and the client fails somewhere inside its JSON parser — the one
 * failure mode that tells the user nothing at all. A JSON-RPC error naming the endpoint is
 * something an agent can read and act on, and a browser never sends a request shaped like this.
 *
 * Returns undefined when the request is not an MCP handshake, so every ordinary request —
 * including a server function posting JSON — passes through untouched.
 *
 * Kept apart from `mcp.ts` and imported statically by the Worker entry: every JSON POST (favorites,
 * token minting, catalyst refresh, better-auth) runs this probe, and it needs only zod. Living in
 * the MCP module made each of those requests evaluate the whole MCP graph just to learn it was
 * not a handshake.
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
      message: `spicy.trade's MCP endpoint is ${endpoint} — this address serves the web app. Reconnect to ${endpoint}.`,
    },
    id: null,
    jsonrpc: '2.0',
  }, { status: 404 })
}
