import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REFRESH_TOKEN = 'refresh-token-that-must-never-leave-this-machine'
const CLIENT_SECRET = 'client-secret-that-must-never-leave-this-machine'
const HESTON_TOKEN = 'heston_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA'
const MINTED = 'minted-15-minute-access-token'

type Captured = { body: string; headers: IncomingMessage['headers'] }

let proxy: ChildProcess | undefined
let upstream: Server | undefined
/** Each fake keyring holds the test's secrets in an executable script; none may outlive the run. */
const keyrings: string[] = []

afterEach(async () => {
  proxy?.kill('SIGKILL')
  proxy = undefined
  const server = upstream
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve())
    else resolve()
  })
  upstream = undefined
  await Promise.all(keyrings.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  upstream = createServer(handler)
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  // SAFETY: this server was just listened on a TCP port, which is the case where Node returns
  // an AddressInfo rather than a pipe path or null.
  return (upstream.address() as AddressInfo).port
}

/**
 * A `secret-tool` stand-in on PATH, so the proxy's own keyring code path is what runs. Keyed by
 * `service/key` rather than key alone, because the service is what separates Heston's own token
 * from a broker's credentials and a stub that ignored it would not notice them being confused.
 */
async function fakeKeyring(entries: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'heston-keyring-'))
  const cases = Object.entries(entries)
    .map(([path, value]) => `    ${path}) printf '%s' '${value}' ;;`)
    .join('\n')
  await writeFile(join(directory, 'secret-tool'), `#!/usr/bin/env bash
# usage: secret-tool lookup service <service> key <key>
case "$3/$5" in
${cases}
  *) exit 1 ;;
esac
`)
  await chmod(join(directory, 'secret-tool'), 0o755)
  keyrings.push(directory)
  return directory
}

async function startProxy(env: Record<string, string>, port: number): Promise<void> {
  proxy = spawn(process.execPath, ['ops/heston-agent/proxy.mjs'], {
    env: { ...process.env, ...env, HESTON_AGENT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), 10_000)
    proxy!.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('HestonAgentProxy: http://')) {
        clearTimeout(timer)
        resolve()
      }
    })
    proxy!.on('exit', () => { clearTimeout(timer); reject(new Error('proxy exited')) })
  })
}

describe('local agent proxy', () => {
  it('attaches a freshly minted broker token and never forwards the long-lived credential', async () => {
    const captured: Captured[] = []
    let tokenRequests = 0
    const port = await listen((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        if (request.url?.endsWith('/oauth/token')) {
          tokenRequests += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ access_token: MINTED, expires_in: 900 }))
          return
        }
        captured.push({ body, headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({
      'heston/mcp-token': HESTON_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    })
    const proxyPort = 18_787
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      HESTON_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const call = () => fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    // `Response.ok` would also match this shape, so assert the forwarded body explicitly.
    expect(await (await call()).json()).toEqual({ ok: true })
    expect(await (await call()).json()).toEqual({ ok: true })

    expect(captured).toHaveLength(2)
    for (const request of captured) {
      expect(request.headers.authorization).toBe(`Bearer ${HESTON_TOKEN}`)
      expect(request.headers['x-heston-broker']).toBe('tastytrade')
      expect(request.headers['x-heston-broker-token']).toBe(MINTED)
      // The whole reason this process exists: the permanent credential stays here.
      const serialized = JSON.stringify(request)
      expect(serialized).not.toContain(REFRESH_TOKEN)
      expect(serialized).not.toContain(CLIENT_SECRET)
    }
    // Minted once and reused inside its lifetime, not re-fetched per request.
    expect(tokenRequests).toBe(1)
  }, 30_000)

  it('forwards the market surface when no brokerage credential is configured', async () => {
    const captured: Captured[] = []
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        captured.push({ body: '', headers: request.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({ 'heston/mcp-token': HESTON_TOKEN })
    const proxyPort = 18_788
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      HESTON_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${HESTON_TOKEN}`)
    // No broker headers at all, so the Worker's account tools answer with their own
    // connect-a-brokerage message rather than being handed a half-configured credential.
    expect(captured[0]?.headers['x-heston-broker']).toBeUndefined()
    expect(captured[0]?.headers['x-heston-broker-token']).toBeUndefined()
  }, 30_000)

  it('forwards MCP session headers in both directions', async () => {
    const captured: Captured[] = []
    const port = await listen((request, response) => {
      request.resume()
      request.on('end', () => {
        captured.push({ body: '', headers: request.headers })
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'session-from-worker',
          'mcp-protocol-version': '2025-03-26',
        })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    const keyring = await fakeKeyring({ 'heston/mcp-token': HESTON_TOKEN })
    const proxyPort = 18_789
    await startProxy({
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      HESTON_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    }, proxyPort)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize' }),
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': 'session-from-client',
        'last-event-id': '42',
      },
      method: 'POST',
    })
    expect(response.headers.get('mcp-session-id')).toBe('session-from-worker')
    expect(response.headers.get('mcp-protocol-version')).toBe('2025-03-26')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.headers['mcp-session-id']).toBe('session-from-client')
    expect(captured[0]?.headers['mcp-protocol-version']).toBe('2025-03-26')
    expect(captured[0]?.headers['last-event-id']).toBe('42')
  }, 30_000)
})
