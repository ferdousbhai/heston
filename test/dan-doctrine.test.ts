import { describe, expect, it } from 'vitest'

import { DAN_SYSTEM_PROMPT } from '../src/server/dan-doctrine'

describe('Dan Markets-notes doctrine', () => {
  // The ceiling bounds doctrine drift; it is not a model limit. It was raised from 8,000
  // for the chain-verification rule, which the prompt had no room left for. Trim a rule
  // before raising it again.
  it('keeps the stable doctrine within its context budget', () => {
    expect(DAN_SYSTEM_PROMPT.length).toBeLessThan(8_600)
  })

  it('reasons about the complete options payoff instead of instrument labels', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Analyze the net position')
    expect(DAN_SYSTEM_PROMPT).toContain('Synthetic equivalence at expiry does not erase')
    expect(DAN_SYSTEM_PROMPT).toContain('A covered call retains stock downside')
    expect(DAN_SYSTEM_PROMPT).toContain('Correct direction can still lose')
  })

  // Dan can name a strike and an expiry that no chain lists; the Daily Read shipped
  // exactly that. Nothing downstream inspects free prose for a contract, so the rule
  // that a recommendation follows a chain lookup lives only here.
  it('requires a current chain lookup before any specific contract is named', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('A contract exists only if the current chain lists it')
    expect(DAN_SYSTEM_PROMPT).toContain('find that exact contract with the option-contract finder')
    expect(DAN_SYSTEM_PROMPT).toContain('quote the expirations and strikes it returns')
    expect(DAN_SYSTEM_PROMPT).toContain('say the option chain is unavailable and name no contract')
  })

  it('keeps dealer flow and sentiment hypotheses conditional', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Dealer gamma is conditional flow')
    expect(DAN_SYSTEM_PROMPT).toContain('size relative to liquidity')
    expect(DAN_SYSTEM_PROMPT).toContain('Sentiment, attention, volume, and disagreement are leads')
  })

  it('grades decisions independently from outcomes and anchors', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Separate decision quality from outcome')
    expect(DAN_SYSTEM_PROMPT).toContain('State the prior, new evidence')
    expect(DAN_SYSTEM_PROMPT).toContain('whether fresh capital would enter today')
    expect(DAN_SYSTEM_PROMPT).toContain('Never add because price fell')
  })

  it('requires adversarial due diligence and payoff-based portfolio roles', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Treat every pitch as an incentive problem')
    expect(DAN_SYSTEM_PROMPT).toContain('Classify each exposure by its actual payoff')
    expect(DAN_SYSTEM_PROMPT).toContain('Underwrite businesses roughly 18 months forward')
  })
})
