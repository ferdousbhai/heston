import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  brokerCredentialFromHeaders,
} from '../src/server/broker-credential'
import { handleMcpRequest, type McpExecutionContext } from '../src/server/mcp'
import { type JsonObject } from '../src/domain/json-payload'
import { stubBrokerGate } from './broker-stub'

const MCP_TOKEN = 'mcp-request-token'
const executionContext: McpExecutionContext = { props: undefined, waitUntil: () => undefined }

function mcpRequest(method: string, params: JsonObject): Request {
  return new Request('https://spice.test/mcp', {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${MCP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}

async function mcpPayload(response: Response) {
  const body = await response.text()
  return JSON.parse(body.slice(body.indexOf('{')))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('request-scoped broker credential', () => {
  it('parses a supported broker and trims its token', () => {
    const credential = brokerCredentialFromHeaders(new Headers({
      'X-Spice-Broker': 'tastytrade',
      'X-Spice-Broker-Token': '  request-token  ',
    }))

    expect(credential).toEqual({ accessToken: 'request-token', broker: 'tastytrade' })
  })

  it.each([
    ['missing broker', { 'X-Spice-Broker-Token': 'request-token' }],
    ['missing token', { 'X-Spice-Broker': 'tastytrade' }],
    ['empty broker', { 'X-Spice-Broker': ' ', 'X-Spice-Broker-Token': 'request-token' }],
    ['empty token', { 'X-Spice-Broker': 'tastytrade', 'X-Spice-Broker-Token': ' ' }],
    ['unknown broker', { 'X-Spice-Broker': 'another-broker', 'X-Spice-Broker-Token': 'request-token' }],
  ])('refuses %s', (_label, values) => {
    expect(brokerCredentialFromHeaders(new Headers(values))).toBeUndefined()
  })

  it('throws the owner-visible missing-credential error for an account path', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const { BrokerCredentialMissingError } = await import('../src/server/broker-credential')
    const brokerGate = stubBrokerGate()

    await expect(tastyRequest(
      { BROKER_GATE: brokerGate.namespace },
      '/customers/me/accounts',
    )).rejects.toBeInstanceOf(BrokerCredentialMissingError)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(brokerGate.namespace.getByName).not.toHaveBeenCalled()
  })

  it('fails the one-time account bootstrap helpers visibly when no credential is supplied', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const {
      loadOwnerPositionSymbolsFromTastytrade,
      previewInternalWatchlistFromTastytrade,
      seedInternalWatchlistFromTastytrade,
    } = await import('../src/server/tastytrade')
    const { BrokerCredentialMissingError } = await import('../src/server/broker-credential')

    for (const operation of [
      loadOwnerPositionSymbolsFromTastytrade,
      previewInternalWatchlistFromTastytrade,
      seedInternalWatchlistFromTastytrade,
    ]) {
      await expect(operation({})).rejects.toBeInstanceOf(BrokerCredentialMissingError)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never reads the Worker credential for an account path', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const { BrokerCredentialMissingError } = await import('../src/server/broker-credential')
    const brokerGate = stubBrokerGate()
    const workerSecret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('worker-secret') }
    const env = {
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: workerSecret,
      TASTYTRADE_REFRESH_TOKEN: workerSecret,
    }

    await expect(tastyRequest(env, '/accounts/MEMBER123/balances')).rejects
      .toBeInstanceOf(BrokerCredentialMissingError)
    expect(fetchMock).not.toHaveBeenCalled()

    await tastyRequest(env, '/accounts/MEMBER123/balances', {}, {
      accessToken: 'exact-request-token',
      broker: 'tastytrade',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe('Bearer exact-request-token')
    expect(workerSecret.get).not.toHaveBeenCalled()
    expect(brokerGate.namespace.getByName).toHaveBeenCalledWith('tastytrade:MEMBER123')
  })

  it('never refreshes or retries with the Worker credential after an account 401', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()
    const workerSecret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('worker-secret') }

    await expect(tastyRequest({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: workerSecret,
      TASTYTRADE_REFRESH_TOKEN: workerSecret,
    }, '/accounts/MEMBER123/balances', {}, {
      accessToken: 'expired-request-token',
      broker: 'tastytrade',
    })).rejects.toThrow('TastytradeApi:401:/accounts/[redacted]/balances')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe('Bearer expired-request-token')
    expect(workerSecret.get).not.toHaveBeenCalled()
  })

  it('ignores a request credential on market paths and uses the Worker credential', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (
      String(input).endsWith('/oauth/token')
        ? Response.json({ access_token: 'worker-market-token', expires_in: 900 })
        : Response.json({ data: {} })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()
    const workerSecret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('worker-secret') }

    await tastyRequest({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: workerSecret,
      TASTYTRADE_REFRESH_TOKEN: workerSecret,
    }, '/api-quote-tokens', {}, {
      accessToken: 'member-account-token',
      broker: 'tastytrade',
    })

    const marketCall = fetchMock.mock.calls.find(([input]) => !String(input).endsWith('/oauth/token'))
    expect(new Headers(marketCall?.[1]?.headers).get('Authorization')).toBe('Bearer worker-market-token')
    expect(brokerGate.namespace.getByName).toHaveBeenCalledWith('tastytrade:market')
  })

  it('keeps account tools advertised and returns a missing credential as a normal tool result', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const env = { SPICE_MCP_TOKEN: { get: async () => MCP_TOKEN } }

    const listed = await mcpPayload(await handleMcpRequest(
      mcpRequest('tools/list', {}),
      env,
      executionContext,
    ))
    const names = listed.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain('read_account_history')
    expect(names).toContain('place_brokerage_order')

    const called = await mcpPayload(await handleMcpRequest(
      mcpRequest('tools/call', { arguments: { type: 'orders' }, name: 'read_account_history' }),
      env,
      executionContext,
    ))
    expect(called.error).toBeUndefined()
    expect(called.result.content).toEqual([{
      text: 'No brokerage is connected for this request. Connect a brokerage from the Connect tab in the Spice web app, then try again.',
      type: 'text',
    }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
