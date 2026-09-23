#!/usr/bin/env node
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

import { tokenRetiresAt } from './token-refresh.mjs'

/**
 * The brokerage credential broker for a local agent.
 *
 * Heston holds no member's brokerage credential, so one has to reach the Worker on each request.
 * It must not reach it through the agent: an MCP config's `${VAR}` interpolation reads the agent
 * process's own environment, which its Bash tool inherits, and a tastytrade refresh token never
 * expires and bypasses every Heston guard. One prompt-injected `printenv | curl` out of the
 * untrusted-content pipeline would be permanent, unguarded trading authority.
 *
 * So this runs as its own process. It reads the long-lived credential from the OS keyring,
 * exchanges it for a 15-minute access token, and attaches that to requests it forwards. The
 * agent points at this address and holds nothing secret at all.
 *
 * It is also why the 15-minute lifetime never surfaces: tastytrade sets it and it cannot be
 * raised, but re-minting happens here, ahead of expiry, so a long session never re-authenticates.
 */

const execFileAsync = promisify(execFile)

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
})

/** The only broker with an adapter that can place orders; also its keyring service name. */
const BROKER = 'tastytrade'
const LISTEN_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const UPSTREAM = process.env.HESTON_MCP_URL ?? 'https://heston.io/mcp'
const TASTYTRADE_API_BASE = process.env.TASTYTRADE_API_BASE ?? 'https://api.tastyworks.com'
// The Worker's own bound. A forwarded request that has not answered by then is not going to.
// It is also how long a broker token must outlive the moment it is attached; see token-refresh.mjs.
const UPSTREAM_TIMEOUT_MS = 60_000
const TOKEN_REQUEST_TIMEOUT_MS = 20_000

/**
 * Keyring reads go through the secret-tool binary, so no secret is ever an argv value here.
 *
 * Credentials are filed under the service that issued them, not the app that spends them: the
 * agent token is Heston's, while a client secret and refresh token are tastytrade's and would be
 * Schwab's for a Schwab adapter. That keeps the keyring laid out the way the Worker's adapter
 * registry (`brokerAdaptersSeam` in `src/server/brokers/index.ts`) is, so adding a broker adds a
 * service rather than more keys under this one.
 *
 * "Not stored" and "could not read the keyring" are different facts. `secret-tool lookup` exits 1
 * and prints nothing when the entry is absent; anything else -- a missing binary, a locked or
 * unreachable keyring, which it reports on stderr -- is a failure, and this exits rather than
 * start in market-only mode on a credential that is in fact stored.
 */
async function keyringSecret(service, key) {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', service, 'key', key])
    const value = stdout.trim()
    return value || undefined
  } catch (error) {
    if (error?.code === 1 && !String(error.stderr ?? '').trim()) return undefined
    // Fixed vocabulary only: secret-tool's stderr is not echoed.
    process.stderr.write(`HestonAgentProxy: the keyring could not be read (${service}/${key})\n`)
    process.exit(1)
  }
}

let cachedAccess

async function brokerAccessToken(clientSecret, refreshToken) {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.token
  const response = await fetch(`${TASTYTRADE_API_BASE}/oauth/token`, {
    body: JSON.stringify({
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Heston-Agent-Proxy/0.1',
    },
    method: 'POST',
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    // Status only. A token endpoint's body can echo credential material.
    throw new Error(`TastytradeAuth:${response.status}`)
  }
  // Parsed at the boundary rather than probed: a token response that does not match this
  // contract is a failure, not something to salvage a field out of.
  const grant = TokenResponseSchema.safeParse(await response.json())
  if (!grant.success) throw new Error('TastytradeAuth:invalid-token-response')
  const { access_token: token, expires_in: lifetimeSeconds } = grant.data
  cachedAccess = { expiresAt: tokenRetiresAt(Date.now(), lifetimeSeconds * 1_000, UPSTREAM_TIMEOUT_MS), token }
  return token
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function main() {
  const hestonToken = await keyringSecret('heston', 'mcp-token')
  if (!hestonToken) {
    process.stderr.write(
      'HestonAgentProxy: no Heston token in the keyring. Create one in the Connect tab, then:\n'
      + '  ./ops/heston-agent/store-credentials.sh mcp-token\n',
    )
    process.exit(1)
  }
  const [clientSecret, refreshToken] = await Promise.all([
    keyringSecret(BROKER, 'client-secret'),
    keyringSecret(BROKER, 'refresh-token'),
  ])
  // Brokerage credentials are optional: without them this still forwards the market and
  // research surface, and the Worker answers account tools with its own connect-a-brokerage
  // message. Starting anyway beats refusing to run for a capability the user may not want.
  const brokerageConfigured = Boolean(clientSecret && refreshToken)
  if (!brokerageConfigured) {
    process.stderr.write('HestonAgentProxy: no brokerage credential in the keyring; forwarding market tools only\n')
  }

  const port = Number(process.env.HESTON_AGENT_PORT ?? DEFAULT_PORT)
  // DNS rebinding: a web page can resolve its own name to 127.0.0.1 and reach this port from the
  // browser, and every request here leaves carrying the Heston token and a broker token. A
  // browser always sends that page's name as Host, and sends Origin on a cross-origin request;
  // an MCP client does neither, so a request naming any other host, or carrying an Origin at
  // all, is refused before anything is attached.
  const allowedHosts = new Set([`${LISTEN_HOST}:${port}`, `localhost:${port}`])

  const server = createServer((request, response) => {
    if (!allowedHosts.has(request.headers.host ?? '') || request.headers.origin !== undefined) {
      request.resume()
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'The Heston proxy only answers local MCP clients' }))
      return
    }
    void (async () => {
      try {
        const headers = new Headers({ Authorization: `Bearer ${hestonToken}` })
        // Node gives a repeated header as an array; MCP sends none of these more than once,
        // so the first value is the whole value.
        for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
          const raw = request.headers[name]
          const value = Array.isArray(raw) ? raw[0] : raw
          if (value) headers.set(name, value)
        }
        if (brokerageConfigured) {
          headers.set('X-Heston-Broker', BROKER)
          headers.set('X-Heston-Broker-Token', await brokerAccessToken(clientSecret, refreshToken))
        }
        const body = request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await readBody(request)
        const upstream = await fetch(UPSTREAM, {
          body,
          headers,
          method: request.method,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        const responseHeaders = { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }
        for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
          const value = upstream.headers.get(name)
          if (value) responseHeaders[name] = value
        }
        response.writeHead(upstream.status, responseHeaders)
        // Streamed rather than buffered: MCP replies over text/event-stream and a buffered
        // proxy would hold a long tool call's response until it finished.
        if (upstream.body) {
          for await (const chunk of upstream.body) response.write(chunk)
        }
        response.end()
      } catch (error) {
        // Name and, for a transport failure, the OS-level cause code -- `ENOTFOUND`,
        // `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`. Both are fixed vocabulary, never content,
        // and they are what separates "this machine could not reach the Worker" from a bug in
        // here: undici reports every network failure as an indistinguishable `TypeError`.
        const name = error instanceof Error ? error.name : 'UnknownError'
        const cause = error instanceof Error && error.cause instanceof Error && 'code' in error.cause
          ? ` ${String(error.cause.code)}`
          : ''
        process.stderr.write(`HestonAgentProxy: ${request.method} ${name}${cause}\n`)
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'The Heston proxy could not complete this request' }))
      }
    })()
  })

  // Loopback only. This process holds a credential that grants trading, so it must never be
  // reachable from the network, only from processes on this machine.
  server.listen(port, LISTEN_HOST, () => {
    process.stdout.write(`HestonAgentProxy: http://${LISTEN_HOST}:${port}/mcp -> ${UPSTREAM}\n`)
  })
}

await main()
