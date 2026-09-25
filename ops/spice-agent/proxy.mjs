#!/usr/bin/env node
import { createServer } from 'node:http'
import { z } from 'zod'

import { APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, keyringSecret, REFRESH_TOKEN_KEY, TASTYTRADE, tastytradeCredentialKind } from './keyring.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS, tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * The brokerage credential broker for a local agent.
 *
 * Spice holds no member's brokerage credential, so one has to reach the Worker on each request.
 * It must not reach it through the agent: an MCP config's `${VAR}` interpolation reads the agent
 * process's own environment, which its Bash tool inherits, and a tastytrade refresh token never
 * expires and bypasses every Spice guard. One prompt-injected `printenv | curl` out of the
 * untrusted-content pipeline would be permanent, unguarded trading authority.
 *
 * So this runs as its own process. It reads the long-lived credential from the OS keyring,
 * exchanges it for a 15-minute access token, and attaches that to requests it forwards. The
 * agent points at this address and holds nothing secret at all.
 *
 * It is also why the 15-minute lifetime never surfaces: tastytrade sets it and it cannot be
 * raised, but re-minting happens here, ahead of expiry, so a long session never re-authenticates.
 *
 * A tastytrade credential comes in one of two kinds, told apart by the keyring entries present:
 *   personal grant  `client-secret` + `refresh-token`, from the member's own OAuth app; minted
 *                   directly against tastytrade.
 *   app grant       `app-refresh-token`, from `connect-tastytrade.mjs` under Spice's OAuth app,
 *                   whose client secret only the Worker holds; minted through the Worker.
 * Either way only the 15-minute access token is attached to forwarded requests. A keyring holding
 * both is refused rather than resolved by a precedence rule: which account the agent trades
 * would otherwise turn on an ordering nobody chose.
 */

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
})

// What the Worker's `/api/brokers/tastytrade/token` answers: a mint, or a refusal that carries
// tastytrade's own status when tastytrade was the one that refused.
const AppGrantResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
})
const AppGrantRefusalSchema = z.object({ tastytradeStatus: z.number().int() })

/** The only broker with an adapter that can place orders; also its keyring service name. */
const BROKER = TASTYTRADE
const LISTEN_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const UPSTREAM = process.env.SPICE_MCP_URL ?? 'https://spicy.trade/mcp'
const TASTYTRADE_API_BASE = process.env.TASTYTRADE_API_BASE ?? 'https://api.tastyworks.com'
// An app grant is minted by the Worker that UPSTREAM names, so it is the same origin: the agent
// token that authenticates the forwarded call is the one that authenticates the mint.
const APP_GRANT_TOKEN_URL = new URL('/api/brokers/tastytrade/token', UPSTREAM)
const PROGRAM = 'SpiceAgentProxy'
// UPSTREAM_TIMEOUT_MS and TOKEN_REQUEST_TIMEOUT_MS live in token-refresh.mjs because importing
// this file starts the proxy (`await main()`), so the retirement test takes them from there.
// A mint runs before, and in addition to, the forwarded call's own UPSTREAM_TIMEOUT_MS, so a call
// that also mints can take up to the sum of the two.

/**
 * A refused, unreachable, or unreadable token exchange. Its `code` is tastytrade's HTTP status, a
 * fixed word of ours, or `spice-` and the Worker's status when the Worker refused an app-grant
 * mint itself, and the handler logs it beside the name: a revoked grant or an unreachable broker
 * has to read as that in the log, not as a bare `Error` or `TypeError` indistinguishable from the
 * Worker failing. `transport`, when present, is the OS- or undici-level code of the failure --
 * `ENOTFOUND`, `TimeoutError` -- never a message. Nothing here carries the request or response
 * body, either of which can hold credential material.
 */
class TastytradeAuthError extends Error {
  constructor(code, transport) {
    super(`TastytradeAuth:${code}`)
    this.name = 'TastytradeAuth'
    this.code = code
    this.transport = transport
  }
}

/** A fixed-vocabulary code for a failed fetch: the cause's errno word, or the abort's name. */
function transportCode(error) {
  const candidate = error instanceof Error && error.cause instanceof Error && 'code' in error.cause
    ? String(error.cause.code)
    : error instanceof Error ? error.name : undefined
  return candidate && /^[A-Za-z0-9_]+$/.test(candidate) ? candidate : undefined
}

let cachedAccess

/** The cached access token, or a fresh one from `mint`, retired ahead of its expiry. */
async function brokerAccessToken(mint) {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.token
  const { lifetimeSeconds, token } = await mint()
  cachedAccess = { expiresAt: tokenRetiresAt(Date.now(), lifetimeSeconds * 1_000, UPSTREAM_TIMEOUT_MS), token }
  return token
}

/** A personal grant: the member's own client secret and refresh token, straight to tastytrade. */
async function mintPersonalGrant(clientSecret, refreshToken) {
  let response
  try {
    response = await fetch(`${TASTYTRADE_API_BASE}/oauth/token`, {
      body: JSON.stringify({
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Spice-Agent-Proxy/0.1',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    // The broker, not the Worker, could not be reached or did not answer in time.
    throw new TastytradeAuthError('unreachable', transportCode(error))
  }
  if (!response.ok) {
    // Status only. A token endpoint's body can echo credential material.
    throw new TastytradeAuthError(response.status)
  }
  // Parsed at the boundary rather than probed: a token response that does not match this
  // contract is a failure, not something to salvage a field out of.
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new TastytradeAuthError('invalid-token-response')
  }
  const grant = TokenResponseSchema.safeParse(payload)
  if (!grant.success) throw new TastytradeAuthError('invalid-token-response')
  return { lifetimeSeconds: grant.data.expires_in, token: grant.data.access_token }
}

/**
 * An app grant: the member's refresh token, minted by the Worker, which adds the app's client
 * secret. The refresh token leaves this machine only in this request's body, to Spice, over the
 * same authenticated channel every forwarded call uses.
 *
 * A refusal is reported by tastytrade's status when the Worker relays one, so a revoked grant
 * reads the same in this log whichever kind it is; a refusal of the Worker's own is `spice-`
 * and its status.
 */
async function mintAppGrant(spiceToken, refreshToken) {
  let response
  try {
    response = await fetch(APP_GRANT_TOKEN_URL, {
      body: JSON.stringify({ refreshToken }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${spiceToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Spice-Agent-Proxy/0.1',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new TastytradeAuthError('unreachable', transportCode(error))
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new TastytradeAuthError(response.ok ? 'invalid-token-response' : `spice-${response.status}`)
  }
  if (!response.ok) {
    const refusal = AppGrantRefusalSchema.safeParse(payload)
    throw new TastytradeAuthError(refusal.success ? refusal.data.tastytradeStatus : `spice-${response.status}`)
  }
  const grant = AppGrantResponseSchema.safeParse(payload)
  if (!grant.success) throw new TastytradeAuthError('invalid-token-response')
  return { lifetimeSeconds: grant.data.expiresIn, token: grant.data.accessToken }
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function main() {
  const spiceToken = await keyringSecret(PROGRAM, 'spice', 'mcp-token')
  if (!spiceToken) {
    process.stderr.write(
      'SpiceAgentProxy: no Spice token in the keyring. Create one in the Connect tab, then:\n'
      + '  ./ops/spice-agent/store-credentials.sh mcp-token\n',
    )
    process.exit(1)
  }
  const { appRefreshToken, clientSecret, kind, refreshToken } = await tastytradeCredentialKind(PROGRAM)
  if (kind === 'ambiguous') {
    process.stderr.write(
      `SpiceAgentProxy: the keyring holds both a tastytrade app grant (${BROKER}/${APP_REFRESH_TOKEN_KEY})\n`
      + `and a personal grant (${BROKER}/${CLIENT_SECRET_KEY}, ${BROKER}/${REFRESH_TOKEN_KEY}). Remove one kind:\n`
      + `  secret-tool clear service ${BROKER} key ${APP_REFRESH_TOKEN_KEY}\n`
      + 'or\n'
      + `  secret-tool clear service ${BROKER} key ${CLIENT_SECRET_KEY}\n`
      + `  secret-tool clear service ${BROKER} key ${REFRESH_TOKEN_KEY}\n`,
    )
    process.exit(1)
  }
  // Brokerage credentials are optional: without them this still forwards the market and
  // research surface, and the Worker answers account tools with its own connect-a-brokerage
  // message. Starting anyway beats refusing to run for a capability the user may not want.
  const mint = appRefreshToken
    ? () => mintAppGrant(spiceToken, appRefreshToken)
    : clientSecret && refreshToken
      ? () => mintPersonalGrant(clientSecret, refreshToken)
      : undefined
  if (!mint) {
    process.stderr.write('SpiceAgentProxy: no brokerage credential in the keyring; forwarding market tools only\n')
  }

  const port = Number(process.env.SPICE_AGENT_PORT ?? DEFAULT_PORT)
  // DNS rebinding: a web page can resolve its own name to 127.0.0.1 and reach this port from the
  // browser, and every request here leaves carrying the Spice token and a broker token. A
  // browser always sends that page's name as Host, and sends Origin on a cross-origin request;
  // an MCP client does neither, so a request naming any other host, or carrying an Origin at
  // all, is refused before anything is attached.
  const allowedHosts = new Set([`${LISTEN_HOST}:${port}`, `localhost:${port}`])

  const server = createServer((request, response) => {
    if (!allowedHosts.has(request.headers.host ?? '') || request.headers.origin !== undefined) {
      request.resume()
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'The Spice proxy only answers local MCP clients' }))
      return
    }
    void (async () => {
      try {
        const headers = new Headers({ Authorization: `Bearer ${spiceToken}` })
        // Node gives a repeated header as an array; MCP sends none of these more than once,
        // so the first value is the whole value.
        for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
          const raw = request.headers[name]
          const value = Array.isArray(raw) ? raw[0] : raw
          if (value) headers.set(name, value)
        }
        if (mint) {
          headers.set('X-Spice-Broker', BROKER)
          headers.set('X-Spice-Broker-Token', await brokerAccessToken(mint))
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
        // `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT` -- or a token exchange's status or fixed code.
        // All are fixed vocabulary, never content, and they are what separates "this machine
        // could not reach the Worker" or "the broker refused the grant" from a bug in here:
        // undici reports every network failure as an indistinguishable `TypeError`.
        const name = error instanceof Error ? error.name : 'UnknownError'
        const detail = error instanceof TastytradeAuthError
          ? ` ${String(error.code)}${error.transport ? ` ${error.transport}` : ''}`
          : error instanceof Error && error.cause instanceof Error && 'code' in error.cause
            ? ` ${String(error.cause.code)}`
            : ''
        process.stderr.write(`SpiceAgentProxy: ${request.method} ${name}${detail}\n`)
        // Once the upstream status and headers are relayed -- an event stream already under way,
        // then the timeout or a dropped connection -- a JSON error written now would arrive as the
        // tail of that stream and end it cleanly, reading as a complete reply. Cutting the
        // connection is the only signal left that the reply is incomplete.
        if (response.headersSent) {
          response.destroy()
          return
        }
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'The Spice proxy could not complete this request' }))
      }
    })()
  })

  // Loopback only. This process holds a credential that grants trading, so it must never be
  // reachable from the network, only from processes on this machine.
  server.listen(port, LISTEN_HOST, () => {
    process.stdout.write(`SpiceAgentProxy: http://${LISTEN_HOST}:${port}/mcp -> ${UPSTREAM}\n`)
  })
}

await main()
