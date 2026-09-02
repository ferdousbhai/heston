import { describe, expect, it, vi } from 'vitest'

import { type JsonValue } from '../src/domain/json-payload'

import { handleMcpRequest, mcpTokenMatches, type McpExecutionContext } from '../src/server/mcp'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

const TOKEN = 'k1DEo9yYb3pQ7v2mX8cRwZa5uT4nJ6hL0fSgAiBd'

// A distinct absent-marker rather than a default parameter: passing an explicit undefined
// would silently select the default and test the wrong world.
function env(secret: string | 'absent' = TOKEN) {
  return {
    SPICE_MCP_TOKEN: secret === 'absent'
      ? undefined
      : { get: vi.fn(async () => secret) },
  }
}

type JsonRpcFrame = { id: number; jsonrpc: '2.0'; method: string; params?: Record<string, JsonValue> }

function mcpRequest(body: JsonRpcFrame | Record<string, never>, token?: string): Request {
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  })
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)
  return new Request('https://tryspice.xyz/mcp', {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  })
}

const executionContext: McpExecutionContext = { props: undefined, waitUntil: () => undefined }

describe('MCP bearer authentication', () => {
  it('admits exactly the configured token', async () => {
    await expect(mcpTokenMatches(mcpRequest({}, TOKEN), env())).resolves.toBe(true)
    await expect(mcpTokenMatches(mcpRequest({}, TOKEN.slice(0, -1) + '!'), env())).resolves.toBe(false)
    await expect(mcpTokenMatches(mcpRequest({}), env())).resolves.toBe(false)
    // Tokens of a different length must fail by comparison, never by shortcut.
    await expect(mcpTokenMatches(mcpRequest({}, TOKEN + TOKEN), env())).resolves.toBe(false)
  })

  it('reads a missing or unreadable secret as no access, never as open access', async () => {
    await expect(mcpTokenMatches(mcpRequest({}, TOKEN), env('absent'))).resolves.toBe(false)
    const broken = { SPICE_MCP_TOKEN: { get: vi.fn(async () => { throw new Error('SecretsStore:down') }) } }
    await expect(mcpTokenMatches(mcpRequest({}, TOKEN), broken)).resolves.toBe(false)
  })

  it('rejects an unauthenticated request before any protocol handling', async () => {
    const response = await handleMcpRequest(
      mcpRequest({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      env('absent'),
      executionContext,
    )
    expect(response.status).toBe(401)
  })
})

describe('MCP tool surface', () => {
  it('lists the read tools and the draft tool, and never a confirmation path', async () => {
    setBrokerApi(stubBroker())
    try {
      const initialize = await handleMcpRequest(mcpRequest({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
          protocolVersion: '2025-06-18',
        },
      }, TOKEN), env(), executionContext)
      expect(initialize.status).toBe(200)

      const listed = await handleMcpRequest(mcpRequest({
        id: 2, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, TOKEN), env(), executionContext)
      expect(listed.status).toBe(200)
      const body = await listed.text()
      const payload = JSON.parse(body.slice(body.indexOf('{')))
      const names = payload.result.tools.map((tool: { name: string }) => tool.name)

      for (const expected of [
        'read_market_metrics', 'read_instrument_quotes', 'search_symbols',
        'find_option_contracts', 'read_catalysts', 'read_daily_recommendations',
        'get_recent_coverage',
        'ingest_wsb',
        'prepare_brokerage_action',
        'publish_daily_recommendations',
      ]) {
        expect(names).toContain(expected)
      }
      // The boundary: drafting travels over MCP, confirming never does.
      expect(names.join(' ')).not.toMatch(/confirm|resolve/)
      // read_page exists to retain text for the Worker's own binders; the local agent reads
      // the web with its own tools and the publish boundary re-reads whatever it cites.
      expect(names).not.toContain('read_page')
    } finally {
      resetBrokerApi()
    }
  })
})
