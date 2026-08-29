import { describe, expect, it } from 'vitest'

import { isDanAgentEvent } from '../src/domain/agent-chat'

describe('Dan relay event boundary', () => {
  it('accepts a complete event variant', () => {
    expect(isDanAgentEvent({ delta: 'hello', type: 'dan:text_delta' })).toBe(true)
    expect(isDanAgentEvent({
      output: 'done',
      toolCallId: 'tool-1',
      toolName: 'read_market_status',
      type: 'dan:tool_execution_end',
    })).toBe(true)
  })

  it('rejects unknown and structurally incomplete dan-prefixed events', () => {
    expect(isDanAgentEvent({ type: 'dan:text_delta' })).toBe(false)
    expect(isDanAgentEvent({ toolCallId: 'tool-1', type: 'dan:tool_execution_end' })).toBe(false)
    expect(isDanAgentEvent({ payload: 'untrusted', type: 'dan:invented_event' })).toBe(false)
  })
})
