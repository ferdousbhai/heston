import { describe, expect, it } from 'vitest'
import { type Model } from '@earendil-works/pi-ai'
import { type AgentEvent } from '@earendil-works/pi-agent-core'

import { type AgentChatMessage, type AgentToolCall, type PendingAction } from '../src/domain/agent-chat'
import {
  completedToolCall,
  projectTurnEnd,
  replayTranscript,
} from '../src/server/dan-transcript'

const MODEL: Model<'openai-responses'> = {
  api: 'openai-responses',
  baseUrl: 'https://api.x.ai/v1',
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: 'grok-test',
  input: ['text'],
  maxTokens: 8_192,
  name: 'Grok test',
  provider: 'xai',
  reasoning: true,
}

const USAGE = {
  cacheRead: 3,
  cacheWrite: 4,
  cost: { cacheRead: 0.03, cacheWrite: 0.04, input: 0.01, output: 0.02, total: 0.1 },
  input: 1,
  output: 2,
  totalTokens: 10,
}

describe('Dan transcript projection', () => {
  it('replays user and completed prose while excluding tool traces', () => {
    const messages: AgentChatMessage[] = [
      { createdAt: '2026-08-29T10:01:00.000Z', id: 'user-1', role: 'user', text: 'Inspect NVDA' },
      {
        createdAt: '2026-08-29T10:02:00.000Z', id: 'tool-turn', model: 'grok', role: 'assistant',
        stopReason: 'toolUse', text: '', toolCalls: [], usage: {
          cacheRead: 0, cacheWrite: 0, cost: 0, input: 1, output: 1, totalTokens: 2,
        },
      },
      {
        createdAt: '2026-08-29T10:03:00.000Z', id: 'answer', model: 'grok', role: 'assistant',
        stopReason: 'stop', text: 'Done', usage: {
          cacheRead: 3, cacheWrite: 4, cost: 0.1, input: 1, output: 2, totalTokens: 10,
        },
      },
    ]

    expect(replayTranscript(messages, MODEL)).toEqual([
      { content: 'Inspect NVDA', role: 'user', timestamp: Date.parse('2026-08-29T10:01:00.000Z') },
      expect.objectContaining({
        content: [{ text: 'Done', type: 'text' }],
        role: 'assistant',
        stopReason: 'stop',
      }),
    ])
  })

  it('projects tool completion, reasoning, usage, and pending action without mutating active calls', () => {
    const active: AgentToolCall = {
      id: 'call-1', input: { symbol: 'NVDA' }, label: 'Reading quote',
      name: 'read_quote', status: 'running',
    }
    const action: PendingAction = {
      expiresAt: '2026-08-29T10:10:00.000Z', id: 'action-1', preview: 'Buy one', token: 'opaque',
    }
    const event = {
      message: {
        api: 'openai-responses',
        content: [
          { thinking: 'Check the guard.', type: 'thinking' },
          { text: 'Ready for confirmation.', type: 'text' },
          { arguments: { symbol: 'NVDA' }, id: 'call-1', name: 'read_quote', type: 'toolCall' },
        ],
        model: 'grok',
        provider: 'xai',
        role: 'assistant',
        stopReason: 'toolUse',
        timestamp: Date.parse('2026-08-29T10:04:00.000Z'),
        usage: USAGE,
      },
      toolResults: [{
        content: [{ text: 'Quote loaded', type: 'text' }],
        isError: false,
        role: 'toolResult',
        timestamp: Date.parse('2026-08-29T10:04:01.000Z'),
        toolCallId: 'call-1',
        toolName: 'read_quote',
      }],
      type: 'turn_end',
    } satisfies Extract<AgentEvent, { type: 'turn_end' }>

    const result = projectTurnEnd(event, new Map([[active.id, active]]), new Map([[active.id, action]]), 'message-1')

    expect(result).toMatchObject({
      kind: 'completed',
      message: {
        id: 'message-1', pendingAction: action, reasoning: 'Check the guard.',
        stopReason: 'toolUse', text: 'Ready for confirmation.', usage: { cost: 0.1 },
      },
    })
    if (result.kind !== 'completed') throw new Error('Expected a completed turn')
    expect(result.toolCalls.get('call-1')).toMatchObject({ output: 'Quote loaded', status: 'complete' })
    expect(active.status).toBe('running')
    expect(active).not.toHaveProperty('output')
  })

  it('returns explicit failures and never leaves stale tool output on errors', () => {
    const call: AgentToolCall = {
      id: 'call-1', input: {}, label: 'Reading quote', name: 'read_quote',
      output: 'old result', status: 'complete',
    }
    expect(completedToolCall(call, 'denied', true)).toMatchObject({
      error: 'denied', output: undefined, status: 'error',
    })
    expect(call.output).toBe('old result')

    const event = {
      message: {
        api: 'openai-responses',
        content: [],
        errorMessage: 'Provider unavailable',
        model: 'grok',
        provider: 'xai',
        role: 'assistant',
        stopReason: 'error',
        timestamp: Date.parse('2026-08-29T10:05:00.000Z'),
        usage: USAGE,
      },
      toolResults: [],
      type: 'turn_end',
    } satisfies Extract<AgentEvent, { type: 'turn_end' }>
    expect(projectTurnEnd(event, new Map(), new Map(), 'unused')).toEqual({
      kind: 'failed', message: 'Provider unavailable',
    })
  })
})
