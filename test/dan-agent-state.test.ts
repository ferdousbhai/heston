import { describe, expect, it } from 'vitest'

import { compactTranscript } from '../src/domain/agent-transcript'
import { type AgentChatMessage } from '../src/domain/agent-chat'

function message(index: number, role: 'assistant' | 'user', text = `message ${index}`): AgentChatMessage {
  return { createdAt: new Date(index * 1_000).toISOString(), id: String(index), role, text }
}

describe('Dan transcript retention', () => {
  it('bounds both message count and serialized size without starting on an orphan assistant turn', () => {
    const messages = Array.from({ length: 100 }, (_, index) => message(
      index,
      index % 2 ? 'assistant' : 'user',
      index > 80 ? 'x'.repeat(20_000) : `message ${index}`,
    ))
    const compacted = compactTranscript(messages)

    expect(compacted.length).toBeLessThanOrEqual(80)
    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(140_500)
    expect(compacted[0]?.role).toBe('user')
    expect(compacted.at(-1)?.id).toBe('99')
  })
})
