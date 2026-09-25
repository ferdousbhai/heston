#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { z } from 'zod'

import { keyringSecret, keyringStore } from './keyring.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * Connect tastytrade through Heston's OAuth app, once, and keep the result in the OS keyring.
 *
 * The member approves Heston on tastytrade's own page; the browser comes back through the Worker
 * to a listener here on the loopback address; this process redeems the code through the Worker
 * and stores the refresh token under `tastytrade/app-refresh-token`, where the local proxy finds
 * it. The Worker holds the app's client secret and never keeps the refresh token; this machine
 * keeps the refresh token and never needs a client secret.
 *
 * Every Worker call carries the member's Heston agent token from the keyring, which is what binds
 * the whole connection to that member: a started connection can be redeemed only with the same
 * token, so the consent URL, the code, and the state are each useless to anyone else.
 *
 * Output is fixed vocabulary. No token, code, or state is printed; the consent URL is, because
 * following it is the whole point, and its state grants nothing without the agent token.
 */

const PROGRAM = 'HestonConnectTastytrade'
const ORIGIN = new URL(process.env.HESTON_MCP_URL ?? 'https://heston.io/mcp').origin
const LISTEN_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'
const BROKER = 'tastytrade'
const KEY = 'app-refresh-token'
const PERSONAL_GRANT_KEYS = ['client-secret', 'refresh-token']

// The codes RFC 6749 §4.1.2.1 defines for a refused authorization. Anything else tastytrade
// returns is reported without its text, since the text is not ours.
const OAUTH_ERRORS = new Set([
  'access_denied', 'invalid_request', 'invalid_scope', 'server_error', 'temporarily_unavailable',
  'unauthorized_client', 'unsupported_response_type',
])

const AuthorizeResponseSchema = z.object({
  authorizationUrl: z.url({ protocol: /^https$/ }),
  expiresAt: z.iso.datetime(),
  state: z.string().min(1),
})
const ExchangeResponseSchema = z.object({ refreshToken: z.string().min(1) })

function fail(message) {
  process.stderr.write(`${PROGRAM}: ${message}\n`)
  process.exit(1)
}

/**
 * One call to the Worker. A refusal is reported by status and, for a tastytrade refusal the
 * Worker relays, tastytrade's status; never by body text, which for the exchange could carry
 * credential material.
 */
async function callWorker(path, hestonToken, body) {
  let response
  try {
    response = await fetch(new URL(path, ORIGIN), {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${hestonToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    fail(`Heston could not be reached (${error instanceof Error ? error.name : 'UnknownError'})`)
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const tastytradeStatus = z.object({ tastytradeStatus: z.number().int() }).safeParse(payload)
    if (response.status === 401) fail('Heston did not accept the agent token in the keyring')
    if (tastytradeStatus.success) fail(`tastytrade refused the grant (HTTP ${tastytradeStatus.data.tastytradeStatus})`)
    fail(`Heston refused ${path} (HTTP ${response.status})`)
  }
  return payload
}

/** Constant-time equality for two strings, so a probe cannot learn the state a byte at a time. */
function sameState(presented, expected) {
  const left = Buffer.from(presented ?? '')
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function page(response, status, text) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    // One return is all this listener serves, so no browser connection is kept open past it.
    connection: 'close',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  response.end(`${text}\n`)
}

/**
 * Listen on an ephemeral loopback port and resolve with the port and a promise of the browser's
 * return: `{ code }` or `{ error }`. `expectedState` is set once the Worker has issued it.
 */
async function loopbackListener() {
  let expectedState
  let settle
  const returned = new Promise((resolve) => { settle = resolve })
  let port
  const server = createServer((request, response) => {
    // DNS rebinding, as in the proxy: a page can resolve its own name to 127.0.0.1 and reach this
    // port from the browser. The real return is a top-level navigation to this address, which
    // names it as Host and carries no Origin.
    const allowedHosts = new Set([`${LISTEN_HOST}:${port}`, `localhost:${port}`])
    if (!allowedHosts.has(request.headers.host ?? '') || request.headers.origin !== undefined) {
      request.resume()
      page(response, 403, 'This listener only answers the tastytrade return.')
      return
    }
    const url = new URL(request.url ?? '/', `http://${LISTEN_HOST}:${port}`)
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH || !expectedState) {
      page(response, 404, 'Not found.')
      return
    }
    if (!sameState(url.searchParams.get('state'), expectedState)) {
      // Not this run's return. Refused, and the real one can still arrive.
      process.stderr.write(`${PROGRAM}: ignored a return whose state did not match this run\n`)
      page(response, 400, 'This return does not belong to the connection in progress.')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error || !code) {
      page(response, 200, 'tastytrade did not grant access. You can close this tab.')
      settle({ error: error && OAUTH_ERRORS.has(error) ? error : 'unrecognized' })
      return
    }
    page(response, 200, 'Heston received the authorization. You can close this tab and return to the terminal.')
    settle({ code })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LISTEN_HOST, resolve)
  })
  port = server.address().port
  return {
    close: () => {
      server.close()
      server.closeAllConnections()
    },
    expect: (state) => { expectedState = state },
    port,
    returned,
  }
}

/** Best effort: the printed URL is the path, so failing to open a browser is not a failure. */
function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is already on screen.
  }
}

async function main() {
  const hestonToken = await keyringSecret(PROGRAM, 'heston', 'mcp-token')
  if (!hestonToken) {
    fail('no Heston token in the keyring. Create one in the Connect tab, then:\n'
      + '  ./ops/heston-agent/store-credentials.sh mcp-token')
  }
  // The proxy refuses a keyring holding both kinds, so connecting over a personal grant would
  // only leave it unable to start. Say so now, before the member goes through tastytrade.
  for (const key of PERSONAL_GRANT_KEYS) {
    if (await keyringSecret(PROGRAM, BROKER, key)) {
      fail('the keyring already holds a tastytrade personal grant, and the proxy refuses to start with both.\n'
        + 'Remove it first:\n'
        + '  secret-tool clear service tastytrade key client-secret\n'
        + '  secret-tool clear service tastytrade key refresh-token')
    }
  }

  const listener = await loopbackListener()
  const authorization = AuthorizeResponseSchema.safeParse(
    await callWorker('/api/brokers/tastytrade/authorize', hestonToken, { port: listener.port }),
  )
  if (!authorization.success) fail('Heston answered the authorization request with an unreadable response')
  const { authorizationUrl, expiresAt, state } = authorization.data
  listener.expect(state)

  process.stdout.write(`Approve Heston on tastytrade to connect your account:\n\n  ${authorizationUrl}\n\n`)
  openBrowser(authorizationUrl)

  // Waits no longer than the Worker keeps the connection redeemable.
  const lapsed = new Promise((resolve) => {
    setTimeout(() => resolve({ lapsed: true }), Math.max(0, Date.parse(expiresAt) - Date.now())).unref()
  })
  const outcome = await Promise.race([listener.returned, lapsed])
  listener.close()
  if (outcome.lapsed) fail('the connection expired before tastytrade returned; run this again')
  if (outcome.error) fail(`tastytrade did not grant access (${outcome.error})`)

  const exchanged = ExchangeResponseSchema.safeParse(
    await callWorker('/api/brokers/tastytrade/exchange', hestonToken, { code: outcome.code, state }),
  )
  if (!exchanged.success) fail('Heston answered the exchange with an unreadable response')
  const { refreshToken } = exchanged.data

  if (!await keyringStore(BROKER, KEY, 'tastytrade refresh token (Heston app)', refreshToken)) {
    fail(`failed to store ${BROKER}/${KEY}`)
  }
  if (await keyringSecret(PROGRAM, BROKER, KEY) !== refreshToken) fail(`failed to store ${BROKER}/${KEY}`)
  process.stdout.write(`Stored ${BROKER}/${KEY}.\n`)

  // The proxy reads the keyring once at startup, so it has to be restarted to see a new value.
  const enabled = spawnSync('systemctl', ['--user', 'is-enabled', 'heston-agent-proxy.service'], { stdio: 'ignore' })
  if (enabled.status === 0) {
    spawnSync('systemctl', ['--user', 'restart', 'heston-agent-proxy.service'], { stdio: 'ignore' })
    const active = spawnSync('systemctl', ['--user', 'is-active', 'heston-agent-proxy.service'], { stdio: 'ignore' })
    process.stdout.write(active.status === 0
      ? '\nProxy restarted. Check what it picked up with:\n'
      : '\nProxy failed to restart; check:\n')
    process.stdout.write('  journalctl --user -u heston-agent-proxy.service -n 5\n')
  } else {
    process.stdout.write('\nProxy service is not installed. Enable it with:\n'
      + '  cp ops/heston-agent/systemd/heston-agent-proxy.service ~/.config/systemd/user/\n'
      + '  systemctl --user daemon-reload && systemctl --user enable --now heston-agent-proxy.service\n')
  }
}

await main()
