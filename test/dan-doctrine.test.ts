import { describe, expect, it } from 'vitest'

import { DAN_SYSTEM_PROMPT } from '../src/server/dan-doctrine'

describe('Dan Markets-notes doctrine', () => {
  it('reasons about the complete options payoff instead of instrument labels', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Analyze the net position, not its labels')
    expect(DAN_SYSTEM_PROMPT).toContain('do not make positions operationally identical')
    expect(DAN_SYSTEM_PROMPT).toContain('A covered call retains substantial downside')
    expect(DAN_SYSTEM_PROMPT).toContain('Correct direction can still lose')
  })

  it('keeps dealer flow and sentiment hypotheses conditional', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Dealer hedging is conditional flow, not a directional law')
    expect(DAN_SYSTEM_PROMPT).toContain('magnitude relative to liquidity')
    expect(DAN_SYSTEM_PROMPT).toContain('not an automatic contrarian trigger')
  })

  it('grades decisions independently from outcomes and anchors', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('Separate decision quality from outcome')
    expect(DAN_SYSTEM_PROMPT).toContain('relative to what the market and Dan already expected')
    expect(DAN_SYSTEM_PROMPT).toContain('fresh capital would initiate the same exposure today')
    expect(DAN_SYSTEM_PROMPT).toContain('Never add merely because price fell')
  })

  it('requires adversarial due diligence and payoff-based portfolio roles', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('treat every pitch as an incentive problem')
    expect(DAN_SYSTEM_PROMPT).toContain('job its actual payoff performs')
    expect(DAN_SYSTEM_PROMPT).toContain('Separate skill from historical tailwinds')
  })
})
