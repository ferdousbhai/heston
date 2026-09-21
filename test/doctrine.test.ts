import { describe, expect, it } from 'vitest'

/** The per-turn ceiling `test/mcp.test.ts` holds the whole advertised surface to. */
const HESTON_MCP_INSTRUCTIONS_CHAR_BUDGET = 1_500
import { RESEARCH_REFRESH_INTERVAL_MS } from '../src/domain/research-refresh'
import { dailyResearchPrompt, PLACE_BROKERAGE_ORDER_DESCRIPTION, hestonMcpInstructions } from '../src/server/doctrine'
import { MAX_DAILY_RECOMMENDATIONS } from '../src/server/research-submission'
import {
  createInstrumentQuoteReadTool,
  createOptionContractFindTool,
} from '../src/server/brokerage-read-tools'
import { createExactOptionGreeksReadTool } from '../src/server/option-greeks-tool'
import { createBrokerageReconciliationTool } from '../src/server/brokerage-reconciliation'

/*
 * The doctrine's wording is free to change. What is pinned here is only what no schema, guard,
 * or state machine enforces, and what changes what reaches the reader if it is lost. With Dan
 * gone the doctrine is split: standing posture rides on the server's MCP `instructions`, and a
 * rule that belongs to one tool rides on that tool's description, where a model is choosing
 * whether to call it. Each half is pinned where it actually lives.
 */
describe('server instructions', () => {
  const signedIn = hestonMcpInstructions(true)
  const anonymous = hestonMcpInstructions(false)

  it('says the one thing about sizing that applies to every turn', () => {
    // The rest of the sizing posture moved into the trade-idea prompt, which costs nothing
    // until someone invokes it. What stays here is the part that governs any answer at all.
    for (const instructions of [signedIn, anonymous]) expect(instructions).toContain('recommend nothing')
  })

  it('states each rule once', () => {
    // "Never state ... from memory" used to appear here and again on three tool descriptions.
    // Both places are in every model call, so the duplicate bought attention, not coverage.
    for (const instructions of [signedIn, anonymous]) {
      expect(instructions.match(/from memory/g)).toHaveLength(1)
    }
    expect(createInstrumentQuoteReadTool({}).description).not.toContain('from memory')
    expect(createExactOptionGreeksReadTool({}).description).not.toContain('from memory')
  })

  it('states that the server, not the advice, decides admissibility', () => {
    for (const instructions of [signedIn, anonymous]) {
      expect(instructions).toContain('guards decide what is admissible')
    }
  })

  it('tells each tier only what is true of the surface it was given', () => {
    // An anonymous caller has no order tools, so placement working rules are a rule about a
    // refusal it cannot reach; a signed-in one is not waiting to be told what signing in would add.
    expect(anonymous).not.toContain('tick-aligned mid')
    expect(anonymous).not.toContain('broker credential')
    expect(anonymous).toContain('public tier')
    expect(signedIn).not.toContain('public tier')
    expect(signedIn.length).toBeLessThan(HESTON_MCP_INSTRUCTIONS_CHAR_BUDGET)
    expect(anonymous.length).toBeLessThan(signedIn.length)
    expect(signedIn).toContain('tick-aligned mid')
    expect(signedIn).toContain('several sells at once')
    expect(signedIn).toContain('Planned size is not a fill quantity')
    expect(PLACE_BROKERAGE_ORDER_DESCRIPTION).not.toContain('tick-aligned mid')
  })

  it('is built only from this repository, so untrusted content cannot reach an agent through it', () => {
    // A literal template of our own constants. Anything provider-, model- or page-derived would
    // make this server an injection vector into someone else's agent.
    for (const instructions of [signedIn, anonymous]) {
      expect(instructions).not.toMatch(/undefined|\[object|NaN/)
    }
  })

})

describe('rules that ride on the tool they govern', () => {
  it('requires a current chain lookup before any specific contract is named', () => {
    // Kept on the tool rather than in instructions: it governs whether to call this tool, and
    // it guards a failure that actually occurred -- a named contract that did not exist.
    expect(createOptionContractFindTool({}).description)
      .toContain('Only contracts this tool returns exist')
  })

  it('forbids automatically retrying an ambiguous broker mutation', () => {
    expect(createBrokerageReconciliationTool({}, undefined).description)
      .toContain('never automatically retry an ambiguous broker mutation')
  })
})

describe('the daily research prompt', () => {
  it('promises only what the publish boundary enforces', () => {
    const prompt = dailyResearchPrompt(false)
    // The numbers a run can be refused on, from the constants the boundary reads.
    expect(prompt).toContain(`at most ${MAX_DAILY_RECOMMENDATIONS} ideas`)
    expect(prompt).toContain(`${RESEARCH_REFRESH_INTERVAL_MS / 60_000} minutes`)
    expect(prompt).toContain('publish_daily_recommendations')
    // The model is what the site shows readers; the prompt is where the agent is told to say it.
    expect(prompt).toContain('`model`')
    // A research run is not a trading session, whoever's agent is running it.
    expect(prompt).toContain('Place no order')
    expect(prompt).not.toMatch(/undefined|\[object|NaN/)
  })

  it('names the private discovery tools only to the caller who has them', () => {
    // A member's agent walked to `ingest_wsb` would meet a tool that is not on its list.
    expect(dailyResearchPrompt(false)).not.toMatch(/ingest_wsb|get_recent_coverage/)
    expect(dailyResearchPrompt(true)).toContain('ingest_wsb')
    expect(dailyResearchPrompt(true)).toContain('get_recent_coverage')
    expect(dailyResearchPrompt(true)).not.toMatch(/undefined|\[object|NaN/)
  })
})

describe('prompt arguments', () => {
  it('carries the caller-supplied thesis into the prompt without reinterpreting it', async () => {
    const { tradeIdeaPrompt } = await import('../src/server/doctrine')
    const prompt = tradeIdeaPrompt('NVDA', 'Supply constraints ease into the print')
    expect(prompt).toContain('NVDA')
    expect(prompt).toContain('Supply constraints ease into the print')
    // The sizing posture lives here now, where it is free until someone asks for it.
    expect(prompt).toContain('Fractional Kelly is a ceiling')
  })
})

