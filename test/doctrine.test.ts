import { describe, expect, it } from 'vitest'

import { PORTFOLIO_POLICY } from '../src/domain/portfolio-risk'
import { SPICE_MCP_INSTRUCTIONS } from '../src/server/doctrine'
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
  it('carries the loss budget the guard enforces, so advice and admissibility agree', () => {
    expect(SPICE_MCP_INSTRUCTIONS).toContain(`${PORTFOLIO_POLICY.maxDrawdownPercent}%`)
  })

  it('says the one thing about sizing that applies to every turn', () => {
    // The rest of the sizing posture moved into the trade-idea prompt, which costs nothing
    // until someone invokes it. What stays here is the part that governs any answer at all.
    expect(SPICE_MCP_INSTRUCTIONS).toContain('recommend nothing')
  })

  it('states each rule once', () => {
    // "Never state ... from memory" used to appear here and again on three tool descriptions.
    // Both places are in every model call, so the duplicate bought attention, not coverage.
    expect(SPICE_MCP_INSTRUCTIONS.match(/from memory/g)).toHaveLength(1)
    expect(createInstrumentQuoteReadTool({}).description).not.toContain('from memory')
    expect(createExactOptionGreeksReadTool({}).description).not.toContain('from memory')
  })

  it('states that the server, not the advice, decides admissibility', () => {
    expect(SPICE_MCP_INSTRUCTIONS).toContain('guards decide what is admissible')
  })

  it('is built only from this repository, so untrusted content cannot reach an agent through it', () => {
    // A literal template of our own constants. Anything provider-, model- or page-derived would
    // make this server an injection vector into someone else's agent.
    expect(SPICE_MCP_INSTRUCTIONS).not.toMatch(/undefined|\[object|NaN/)
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

