import { describe, expect, it } from 'vitest'

import {
  createInstrumentQuoteReadTool,
  createMarketMetricsReadTool,
  createOptionContractFindTool,
} from '../src/server/brokerage-read-tools'
import { createResearchReadTools } from '../src/server/research-read-tools'
import { toolErrorResult } from '../src/server/agent-tool-result'
import { UnreadableTickerError } from '../src/server/ticker-arguments'

/**
 * An argument that is not a ticker is a failed call. Returned as an ordinary result it read to
 * the model as a successful one, which is exactly what `AgentTool.execute`'s contract forbids.
 * Nothing here reaches a store or a provider: each refusal happens before either is touched.
 */
async function refusal(run: () => Promise<object>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error('expected a refusal')
}

describe('unreadable ticker arguments', () => {
  const catalysts = createResearchReadTools({}).find((tool) => tool.name === 'read_catalysts')!

  it.each([
    ['read_market_metrics', () => createMarketMetricsReadTool({}).execute({ symbols: ['NVDA', 'BRK.B'] }), 'symbols[1]'],
    ['read_instrument_quotes', () => createInstrumentQuoteReadTool({}).execute({ symbols: ['BRK.B'] }), 'symbols[0]'],
    ['find_option_contracts', () => createOptionContractFindTool({}).execute({ underlying: 'BRK.B' }), 'underlying'],
    ['read_catalysts', () => catalysts.execute({ symbols: ['NXE.TO'] }), 'symbols[0]'],
  ])('%s throws a refusal naming the argument, not its text', async (toolName, run, argument) => {
    const error = await refusal(run)
    expect(error).toBeInstanceOf(UnreadableTickerError)
    const text = toolErrorResult(toolName, error).content[0]?.text
    expect(text).toBe(`TickerArgument:not-a-ticker: ${argument} is not a ticker symbol.`)
    expect(text).not.toMatch(/BRK|NXE/)
  })
})
