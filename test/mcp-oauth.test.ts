import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { authIssuerFor, getAuthRuntime, mcpResourceIdentifier } from '../src/server/auth'
import { type AppEnv } from '../src/server/env'
import { handleMcpRequest, type McpExecutionContext } from '../src/server/mcp'
import { issueMcpToken, revokeMcpToken } from '../src/server/mcp-tokens'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

/*
 * The OAuth way in, end to end: the real auth runtime over the migration schema, and an access
 * token it signed itself with the same issuer and audience a real authorization would carry.
 * The runtime is cached per isolate, so the file shares one store.
 */
const BASE_URL = 'https://heston.io'
const executionContext: McpExecutionContext = { props: undefined, waitUntil: () => undefined }

let store: SqliteD1Store
let env: AppEnv

beforeAll(async () => {
  store = await migrationStore()
  env = {
    AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-32',
    DB: store.database,
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: { get: async () => 'google-client-secret' },
  }
})

afterAll(() => store.close())

afterEach(() => {
  resetBrokerApi()
  vi.restoreAllMocks()
})

function addMember(id: string): void {
  store.sqlite.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, 'Member', `${id}@example.com`, 'now', 'now')
}

async function accessTokenFor(sub: string): Promise<string> {
  const { auth } = await getAuthRuntime(env)
  const { token } = await auth.api.signJWT({
    body: { payload: { aud: mcpResourceIdentifier(BASE_URL), iss: authIssuerFor(BASE_URL), sub } },
  })
  return token
}

function toolsList(authorization: string): Request {
  return new Request(`${BASE_URL}/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: authorization,
      'content-type': 'application/json',
    },
    method: 'POST',
  })
}

describe('MCP OAuth callers', () => {
  it('serves a verified subject who is a member', async () => {
    addMember('oauth-member')
    setBrokerApi(stubBroker())
    const response = await handleMcpRequest(toolsList(`Bearer ${await accessTokenFor('oauth-member')}`), env, executionContext)
    expect(response.status).toBe(200)
  })

  it('refuses a validly signed token whose user has been deleted', async () => {
    addMember('deleted-member')
    // Signed while the account existed; the signature, issuer, audience and expiry all still hold.
    const token = await accessTokenFor('deleted-member')
    store.sqlite.prepare('DELETE FROM "user" WHERE id = ?').run('deleted-member')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await handleMcpRequest(toolsList(`Bearer ${token}`), env, executionContext)
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('invalid_token')
    expect(logged).toHaveBeenCalledWith('McpAuthRejected')
  })

  it('decides a minted token by its own table, whatever case the scheme is in, and never as a JWT', async () => {
    addMember('minted-member')
    setBrokerApi(stubBroker())
    const issued = await issueMcpToken(store.database, 'minted-member', 'laptop')
    const live = await handleMcpRequest(toolsList(`bearer ${issued.token}`), env, executionContext)
    expect(live.status).toBe(200)

    await revokeMcpToken(store.database, 'minted-member', issued.tokenMetadata.tokenId)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const revoked = await handleMcpRequest(toolsList(`${scheme} ${issued.token}`), env, executionContext)
      expect(revoked.status).toBe(401)
      expect(revoked.headers.get('WWW-Authenticate')).toContain('invalid_token')
    }
    // Refused as the token it is, not as a JWT that failed to verify.
    const events = logged.mock.calls.map(([event]) => event)
    expect(events).toEqual(['McpTokenRejected', 'McpTokenRejected', 'McpTokenRejected'])
  })
})
