import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { type JsonValue } from '../src/domain/json-payload'

import { HESTON_GUIDE } from '../src/server/doctrine'
import { handleMcpRequest, mcpEndpointRedirect, resolveMcpCaller, type McpExecutionContext } from '../src/server/mcp'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

/**
 * Every caller is now a row in `user_mcp_tokens`, so a test that reaches `/mcp` needs a real
 * store and a real issued token. `ownerHarness` seeds the owner; `memberHarness` seeds someone
 * else, which is what separates the two tool tiers.
 */
async function harness(email: string) {
  const { migrationStore } = await import('./sqlite-d1')
  const { issueMcpToken } = await import('../src/server/mcp-tokens')
  const store = await migrationStore()
  store.sqlite.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run('member-1', 'Member', email, 'now', 'now')
  const issued = await issueMcpToken(store.database, 'member-1', 'laptop')
  return { env: { DB: store.database }, store, token: issued.token }
}

async function ownerHarness() {
  const { OWNER_EMAIL } = await import('../src/server/auth')
  return harness(OWNER_EMAIL)
}

type JsonRpcFrame = { id: number; jsonrpc: '2.0'; method: string; params?: Record<string, JsonValue> }

function mcpRequest(body: JsonRpcFrame | Record<string, never>, token?: string): Request {
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  })
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)
  return new Request('https://heston.io/mcp', {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  })
}

/** Responses come back as an SSE frame; the JSON body starts at the first brace. */
async function mcpPayload(response: Response) {
  const body = await response.text()
  return JSON.parse(body.slice(body.indexOf('{')))
}

const executionContext: McpExecutionContext = { props: undefined, waitUntil: () => undefined }

describe('MCP bearer authentication', () => {
  it('admits exactly the issued token and identifies who presented it', async () => {
    const { env, store, token } = await ownerHarness()
    await expect(resolveMcpCaller(mcpRequest({}, token), env))
      .resolves.toMatchObject({ owner: true, userId: 'member-1' })
    await expect(resolveMcpCaller(mcpRequest({}, `${token}x`), env)).resolves.toBeUndefined()
    await expect(resolveMcpCaller(mcpRequest({}), env)).resolves.toBeUndefined()
    await expect(resolveMcpCaller(mcpRequest({}, 'not-a-heston-token'), env)).resolves.toBeUndefined()
    store.close()
  })

  it('is no access, never open access, when there is no store to recognise anyone', async () => {
    const { store, token } = await ownerHarness()
    // The shared secret that used to authenticate as the owner is gone; without the token
    // store there is no other way in, and a missing binding must not become a bypass.
    await expect(resolveMcpCaller(mcpRequest({}, token), {})).resolves.toBeUndefined()
    store.close()
  })

  it('gives a member their own identity, not the owner\'s', async () => {
    const { env, store, token } = await harness('member@example.com')
    await expect(resolveMcpCaller(mcpRequest({}, token), env))
      .resolves.toMatchObject({ owner: false, userId: 'member-1' })
    store.close()
  })

  it('serves a caller who presented nothing, from the public tier', async () => {
    const { env, store } = await ownerHarness()
    try {
      const response = await handleMcpRequest(mcpRequest({
        id: 1, jsonrpc: '2.0', method: 'tools/list', params: {},
      }), env, executionContext)
      expect(response.status).toBe(200)
      const names = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(await mcpPayload(response))
        .result.tools.map((tool) => tool.name)

      // The reads that cost nothing per call, plus quotes from the website's cached snapshot.
      for (const offered of ['read_instrument_quotes', 'read_price_history', 'read_catalysts', 'read_watchlist']) {
        expect(names).toContain(offered)
      }
      // Search is offered: the website already resolves names anonymously, and a name that
      // resolves joins the tracked universe for every later visitor.
      expect(names).toContain('search_symbols')
      // Nothing that spends a per-call broker request, writes to shared state, mutates an
      // account, or is owner-only. A destructive tool that could only ever refuse is worse than
      // absent, so placement is withheld rather than advertised and rejected.
      for (const withheld of [
        'find_option_contracts', 'read_option_greeks', 'remember_symbols',
        'read_account_history', 'read_account_snapshot',
        'place_brokerage_order', 'cancel_brokerage_order',
        'record_catalysts', 'record_evidence',
      ]) {
        expect(names).not.toContain(withheld)
      }
    } finally {
      store.close()
    }
  })

  it('still challenges a credential that is present and does not verify', async () => {
    // A caller trying to authenticate and failing can act on a challenge; one who never claimed
    // to be anybody cannot, which is why only this case is refused. The challenge must also say
    // how to authenticate, or a stale token is indistinguishable from a broken endpoint.
    const response = await handleMcpRequest(
      mcpRequest({ id: 1, jsonrpc: '2.0', method: 'tools/list' }, 'heston_0000000000000000_notarealsecret'),
      {},
      executionContext,
    )
    expect(response.status).toBe(401)
    const challenge = response.headers.get('WWW-Authenticate') ?? ''
    expect(challenge).toMatch(/^Bearer\b/)
    expect(challenge).toContain('invalid_token')
  })
})

describe('MCP tool surface', () => {
  it('lists the read tools and the guarded order tools, and never a confirmation path', async () => {
    const { env, store, token } = await ownerHarness()
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
      }, token), env, executionContext)
      expect(initialize.status).toBe(200)

      const listed = await handleMcpRequest(mcpRequest({
        id: 2, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, token), env, executionContext)
      expect(listed.status).toBe(200)
      const payload = await mcpPayload(listed)
      const names = payload.result.tools.map((tool: { name: string }) => tool.name)

      // The market reads are enumerated by hand here and in `mcp.ts`, and twice now a factory
      // has been added to the research run's bundle and forgotten on this surface -- most
      // recently `read_price_history`, which left a connected agent with no historical read at
      // all while every "right now" tool worked. Naming them is what makes that omission fail.
      for (const expected of [
        'read_market_metrics', 'read_instrument_quotes', 'search_symbols',
        'find_option_contracts', 'read_catalysts', 'read_watchlist',
        'read_price_history', 'read_option_greeks', 'remember_symbols',
        'place_brokerage_order',
        'cancel_brokerage_order',
        'reconcile_brokerage_action',
        'record_catalysts',
        'record_evidence',
      ]) {
        expect(names).toContain(expected)
      }
      // The draft/confirm ceremony is gone: placement is one guarded tool and there is no
      // pending-action surface left to confirm or resolve against.
      expect(names.join(' ')).not.toMatch(/confirm|prepare_brokerage/)
      expect(names).not.toContain('read_watchlists')
      // The local agent reads the web with its own tools; the Worker reads a page only to bind
      // a citation an agent recorded, never as a tool it offers.
      expect(names).not.toContain('read_page')
      // The brief is produced elsewhere; nothing here writes one.
      expect(names).not.toContain('publish_daily_recommendations')
    } finally {
      resetBrokerApi()
      store.close()
    }
  })
})

describe('MCP tool tiers', () => {
  async function toolNames(token: string, database: D1Database): Promise<string[]> {
    setBrokerApi(stubBroker())
    try {
      const listed = await handleMcpRequest(mcpRequest({
        id: 3, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, token), { DB: database }, executionContext)
      const payload = await mcpPayload(listed)
      return payload.result.tools.map((tool: { name: string }) => tool.name)
    } finally {
      resetBrokerApi()
    }
  }

  const OWNER_ONLY = ['manage_watchlist']

  it('hides the owner surface from a member rather than refusing it on call', async () => {
    const { store, token } = await harness('member@example.com')
    const names = await toolNames(token, store.database)
    // The market and account surface is every member's.
    for (const expected of [
      'read_market_metrics', 'find_option_contracts', 'read_watchlist', 'place_brokerage_order',
      // Placement refuses while any order is working, so a member must be able to clear one.
      'cancel_brokerage_order',
      // Additive only; removing a name is owner-only because it changes what every reader sees.
      'remember_symbols',
      // Recording research is the same bargain at a smaller scale: bound against pages this
      // Worker re-reads, and withheld from the anonymous tier only so a row has a name behind it.
      'record_catalysts',
      'record_evidence',
    ]) {
      expect(names).toContain(expected)
    }
    // Watchlist removal is an owner act, and a member is not shown a surface they cannot use.
    for (const ownerOnly of OWNER_ONLY) expect(names).not.toContain(ownerOnly)
    store.close()
  })

  it('gives the owner the watchlist management surface', async () => {
    const { OWNER_EMAIL } = await import('../src/server/auth')
    const { store, token } = await harness(OWNER_EMAIL)
    const names = await toolNames(token, store.database)
    for (const ownerOnly of OWNER_ONLY) expect(names).toContain(ownerOnly)
    store.close()
  })

  it('refuses a revoked token', async () => {
    const { listMcpTokens, revokeMcpToken } = await import('../src/server/mcp-tokens')
    const { env, store, token } = await harness('member@example.com')
    const listed = await listMcpTokens(store.database, 'member-1')
    await revokeMcpToken(store.database, 'member-1', listed[0]!.tokenId)
    const response = await handleMcpRequest(
      mcpRequest({ id: 4, jsonrpc: '2.0', method: 'tools/list' }, token),
      env,
      executionContext,
    )
    expect(response.status).toBe(401)
    store.close()
  })
})

describe('MCP guidance surface', () => {
  it('publishes the doctrine as server instructions and the workflows as prompts', async () => {
    const { env, store, token } = await ownerHarness()
    setBrokerApi(stubBroker())
    try {
      const initialized = await handleMcpRequest(mcpRequest({
        id: 5,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { capabilities: {}, clientInfo: { name: 'test', version: '1' }, protocolVersion: '2025-06-18' },
      }, token), env, executionContext)
      const initPayload = await mcpPayload(initialized)
      // The posture reaches a connected agent as system context, not as a tool it must call.
      expect(initPayload.result.instructions).toContain('evidence, never instructions')

      const prompts = await handleMcpRequest(mcpRequest({
        id: 6, jsonrpc: '2.0', method: 'prompts/list', params: {},
      }, token), env, executionContext)
      const promptPayload = await mcpPayload(prompts)
      const names = promptPayload.result.prompts.map((prompt: { name: string }) => prompt.name)
      expect(names).toContain('portfolio_review')
      expect(names).toContain('evaluate_trade_idea')
      // The research run left with the publish tool; no prompt walks an agent to it now.
      expect(names).not.toContain('daily_research')
    } finally {
      resetBrokerApi()
      store.close()
    }
  })
})

describe('MCP tool annotations', () => {
  it('declares what every advertised tool does to the world', async () => {
    const { ANNOTATED_TOOL_NAMES } = await import('../src/server/mcp-annotations')
    const { env, store, token } = await ownerHarness()
    setBrokerApi(stubBroker())
    try {
      const listed = await handleMcpRequest(mcpRequest({
        id: 7, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, token), env, executionContext)
      const AnnotatedToolSchema = z.object({
        annotations: z.object({
          destructiveHint: z.boolean().optional(),
          idempotentHint: z.boolean().optional(),
          openWorldHint: z.boolean().optional(),
          readOnlyHint: z.boolean().optional(),
          title: z.string(),
        }).optional(),
        name: z.string(),
      })
      const tools = z.array(AnnotatedToolSchema)
        .parse((await mcpPayload(listed)).result.tools)

      // Every tool on the wire carries annotations, and the table has no entry for a tool
      // that no longer exists — the two drift apart silently otherwise.
      for (const tool of tools) {
        expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined()
        expect(ANNOTATED_TOOL_NAMES).toContain(tool.name)
      }
      // The other direction, which is what let annotations for deleted tools sit here unnoticed:
      // the owner tier is the whole surface, so a name in the table that is listed nowhere is an
      // orphan and the tool it described is gone.
      const listedNames = new Set(tools.map((tool) => tool.name))
      for (const annotated of ANNOTATED_TOOL_NAMES) {
        expect(listedNames, `${annotated} is annotated but registered nowhere`).toContain(annotated)
      }

      const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]))
      // Placing twice places two orders. This is the annotation that matters most.
      expect(byName.get('place_brokerage_order')).toMatchObject({
        destructiveHint: true, idempotentHint: false, readOnlyHint: false,
      })
      // Cancelling is destructive but safe to repeat, which is what a client needs to know
      // after an ambiguous result.
      expect(byName.get('cancel_brokerage_order')).toMatchObject({
        destructiveHint: true, idempotentHint: true, readOnlyHint: false,
      })
      // Additive, and that distinction is the reason it is a member tool at all.
      expect(byName.get('remember_symbols')).toMatchObject({ destructiveHint: false, readOnlyHint: false })
      // The recordings are additive too, and repeating one refreshes what it wrote.
      for (const additive of ['record_catalysts', 'record_evidence']) {
        expect(byName.get(additive)).toMatchObject({
          destructiveHint: false, idempotentHint: true, readOnlyHint: false,
        })
      }
      // Reads must never be advertised as writes.
      for (const readOnly of ['read_market_metrics', 'find_option_contracts', 'read_watchlist']) {
        expect(byName.get(readOnly)).toMatchObject({ readOnlyHint: true })
      }
    } finally {
      resetBrokerApi()
      store.close()
    }
  })

  it('refuses to register a tool nobody has described', async () => {
    const { toolAnnotations } = await import('../src/server/mcp-annotations')
    expect(() => toolAnnotations('a_tool_that_was_never_declared')).toThrow('undeclared-tool')
  })
})

describe('the guide resource', () => {
  it('is advertised, readable, and names only tools and prompts that exist', async () => {
    const { env, store, token } = await ownerHarness()
    setBrokerApi(stubBroker())
    try {
      const listed = await handleMcpRequest(mcpRequest({
        id: 20, jsonrpc: '2.0', method: 'resources/list', params: {},
      }, token), env, executionContext)
      const resources = z.object({ result: z.object({ resources: z.array(z.object({ uri: z.string() })) }) })
        .parse(await mcpPayload(listed))
      expect(resources.result.resources.map((entry) => entry.uri)).toContain('heston://guide')

      const read = await handleMcpRequest(mcpRequest({
        id: 21, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'heston://guide' },
      }, token), env, executionContext)
      const contents = z.object({ result: z.object({ contents: z.array(z.object({ text: z.string() })) }) })
        .parse(await mcpPayload(read))
      const guide = contents.result.contents[0]!.text
      expect(guide).toBe(HESTON_GUIDE)

      // An index that names something gone is worse than no index: it sends an agent looking for
      // a tool that will never answer. Every backticked name in the guide must be real.
      const toolsResponse = await handleMcpRequest(mcpRequest({
        id: 22, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, token), env, executionContext)
      const tools = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(await mcpPayload(toolsResponse))
      const known = new Set([
        ...tools.result.tools.map((tool) => tool.name),
        'portfolio_review',
        'evaluate_trade_idea',
      ])
      const named = [...guide.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!)
      expect(named.length).toBeGreaterThan(5)
      expect(named.filter((name) => !known.has(name))).toEqual([])
    } finally {
      resetBrokerApi()
      store.close()
    }
  })

  it('reaches a caller who presented nothing, whose instructions also point at it', async () => {
    const { env, store } = await ownerHarness()
    try {
      const listed = await handleMcpRequest(mcpRequest({
        id: 30, jsonrpc: '2.0', method: 'resources/list', params: {},
      }), env, executionContext)
      const resources = z.object({ result: z.object({ resources: z.array(z.object({ uri: z.string() })) }) })
        .parse(await mcpPayload(listed))
      expect(resources.result.resources.map((entry) => entry.uri)).toContain('heston://guide')

      const read = await handleMcpRequest(mcpRequest({
        id: 31, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'heston://guide' },
      }), env, executionContext)
      const contents = z.object({ result: z.object({ contents: z.array(z.object({ text: z.string() })) }) })
        .parse(await mcpPayload(read))
      expect(contents.result.contents[0]!.text).toBe(HESTON_GUIDE)
    } finally {
      store.close()
    }
  })
})

describe('misdirected MCP clients', () => {
  it('names the endpoint when an agent connects to the site instead of /mcp', async () => {
    const response = await mcpEndpointRedirect(new Request('https://heston.io/', {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }))
    expect(response?.status).toBe(404)
    const body = z.object({ error: z.object({ message: z.string() }) })
      .parse(await (response ?? Response.json({})).json())
    expect(body.error.message).toContain('https://heston.io/mcp')
  })

  it('leaves every request that is not an MCP handshake alone', async () => {
    const cases = [
      new Request('https://heston.io/', { method: 'GET' }),
      // A server function posting ordinary JSON must pass straight through.
      new Request('https://heston.io/api/favorites', {
        body: JSON.stringify({ symbols: ['NVDA'] }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      new Request('https://heston.io/', {
        body: 'not json at all',
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      }),
    ]
    for (const request of cases) {
      await expect(mcpEndpointRedirect(request)).resolves.toBeUndefined()
    }
  })
})

describe('MCP surface budget', () => {
  /*
   * In Claude Code the tool list and the folded instructions are in every model call, not just
   * the handshake, so this is a per-turn cost paid by every caller. These ceilings exist to make
   * growth a decision rather than an accident: a new tool or a longer description should have to
   * move a number here, with a reason. They are budgets, not measurements — the headroom is
   * deliberate, and the owner surface is the superset a member never sees all of.
   */
  // Raised for the member research tools -- `record_catalysts` and `record_evidence` --
  // each of which advertises the citation contract
  // it is held to, which is what lets an agent fix a rejection without a round trip. Then
  // lowered again, to just above the measured surface, once the published schemas stopped
  // carrying zod's safe-integer bounds and spelling closed string sets as `anyOf` of `const`:
  // both were shape, not contract, and a ceiling left above them would quietly re-admit them.
  // Raised again for `read_account_snapshot`, the current-account read that used to be injected
  // as agent context and is now a tool.
  const TOOLS_LIST_CHAR_BUDGET = 25_000
  const INSTRUCTIONS_CHAR_BUDGET = 1_500

  it('keeps the advertised surface inside its budget', async () => {
    const { env, store, token } = await ownerHarness()
    setBrokerApi(stubBroker())
    try {
      const initialized = await handleMcpRequest(mcpRequest({
        id: 8,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { capabilities: {}, clientInfo: { name: 'test', version: '1' }, protocolVersion: '2025-06-18' },
      }, token), env, executionContext)
      const instructions: string = (await mcpPayload(initialized)).result.instructions
      expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_CHAR_BUDGET)

      const listed = await handleMcpRequest(mcpRequest({
        id: 9, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, token), env, executionContext)
      const tools = (await mcpPayload(listed)).result.tools
      expect(JSON.stringify(tools).length).toBeLessThanOrEqual(TOOLS_LIST_CHAR_BUDGET)
    } finally {
      resetBrokerApi()
      store.close()
    }
  })

  it('publishes bounds the contract means and closed string sets as enums', async () => {
    const { env, store, token } = await ownerHarness()
    setBrokerApi(stubBroker())
    try {
      const listed = await handleMcpRequest(mcpRequest({
        id: 10, jsonrpc: '2.0', method: 'tools/list', params: {},
      }, token), env, executionContext)
      const tools = z.object({
        result: z.object({ tools: z.array(z.object({ inputSchema: z.unknown(), name: z.string() })) }),
      }).parse(await mcpPayload(listed)).result.tools
      const schemas = JSON.stringify(tools)

      // A bound that equals JavaScript's own safe-integer range says nothing about the contract,
      // and reads to a model as permission for a nine-quadrillion source index.
      expect(schemas).not.toContain(String(Number.MAX_SAFE_INTEGER))

      // A closed set of strings is an `enum`. The `anyOf` of `const` branches TypeBox emits for
      // a literal union means the same thing at three times the characters, on every model call.
      const history = tools.find((tool) => tool.name === 'read_account_history')
      expect(JSON.stringify(history)).toContain('"enum":["transactions","orders"]')
      const snapshot = tools.find((tool) => tool.name === 'read_account_snapshot')
      expect(JSON.stringify(snapshot)).toContain('"enum":["balances","positions","orders"]')
      // The `const`s that remain are discriminators of object unions -- an order kind, a
      // watchlist action -- where the branches differ by more than one value.
      const constTools = tools.filter((tool) => JSON.stringify(tool).includes('"const"')).map((tool) => tool.name)
      expect([...constTools].sort()).toEqual([
        'manage_watchlist', 'place_brokerage_order',
      ])
    } finally {
      resetBrokerApi()
      store.close()
    }
  })
})
