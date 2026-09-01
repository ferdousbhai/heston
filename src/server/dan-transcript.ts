import { type Message, type Model, type ToolResultMessage, type Usage } from '@earendil-works/pi-ai'
import { type AgentEvent } from '@earendil-works/pi-agent-core'

import {
  type AgentChatMessage,
  type AgentToolCall,
  type PendingAction,
} from '../domain/agent-chat'

type TurnEndEvent = Extract<AgentEvent, { type: 'turn_end' }>

function transcriptUsage(usage: Usage) {
  return {
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost.total,
    input: usage.input,
    output: usage.output,
    totalTokens: usage.totalTokens,
  }
}

export function toolResultText(content: ToolResultMessage['content']): string {
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

export function completedToolCall(call: AgentToolCall, output: string, isError: boolean): AgentToolCall {
  return {
    ...call,
    error: isError ? output : undefined,
    output: isError ? undefined : output,
    status: isError ? 'error' : 'complete',
  }
}

export function replayTranscript(messages: AgentChatMessage[], model: Model<any>): Message[] {
  const replay: Message[] = []
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt)
    if (!Number.isFinite(timestamp)) throw new Error(`DanTranscript:invalid-timestamp:${message.id}`)
    if (message.role === 'user') {
      replay.push({ content: message.text, role: 'user', timestamp })
      continue
    }
    // Tool traces stay in the owner UI/audit log. Cross-turn model context keeps only
    // completed prose; fresh tools must re-read any market or account fact.
    if (message.stopReason === 'toolUse') continue
    if (message.stopReason !== 'stop') {
      throw new Error(`DanTranscript:invalid-stop-reason:${message.stopReason ?? 'missing'}`)
    }
    if (!message.text || !message.model || !message.usage) {
      throw new Error(`DanTranscript:incomplete-assistant-message:${message.id}`)
    }
    replay.push({
      api: model.api,
      content: [{ text: message.text, type: 'text' }],
      model: message.model,
      provider: model.provider,
      role: 'assistant',
      stopReason: 'stop',
      timestamp,
      usage: {
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: message.usage.cost },
        input: message.usage.input,
        output: message.usage.output,
        totalTokens: message.usage.totalTokens,
      },
    })
  }
  return replay
}

export type ProjectedTurn =
  | { kind: 'ignored' }
  | { kind: 'failed'; message: string }
  | { kind: 'completed'; message: AgentChatMessage; toolCalls: Map<string, AgentToolCall> }

export function projectTurnEnd(
  event: TurnEndEvent,
  activeToolCalls: ReadonlyMap<string, AgentToolCall>,
  pendingActions: ReadonlyMap<string, PendingAction>,
  messageId: string,
): ProjectedTurn {
  const message = event.message
  if (message.role !== 'assistant') return { kind: 'ignored' }
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return { kind: 'failed', message: message.errorMessage ?? 'The model request failed.' }
  }
  if (message.stopReason !== 'stop' && message.stopReason !== 'toolUse') {
    return { kind: 'failed', message: `The model ended with ${message.stopReason}.` }
  }
  const completedTools = new Map(activeToolCalls)
  const results = new Map(event.toolResults.map((result) => [result.toolCallId, result]))
  for (const block of message.content) {
    if (block.type !== 'toolCall') continue
    const stored = completedTools.get(block.id)
    if (!stored) throw new Error(`DanAgent:missing-tool-start:${block.id}`)
    const result = results.get(block.id)
    if (!result) throw new Error(`DanAgent:missing-tool-result:${block.id}`)
    completedTools.set(block.id, completedToolCall(stored, toolResultText(result.content), result.isError))
  }
  const toolCalls = [...completedTools.values()]
  return {
    kind: 'completed',
    message: {
      createdAt: new Date(message.timestamp).toISOString(),
      id: messageId,
      model: message.model,
      pendingAction: toolCalls.map((call) => pendingActions.get(call.id)).find(Boolean),
      reasoning: message.content.flatMap((part) => part.type === 'thinking' && !part.redacted ? [part.thinking] : []).join('\n\n') || undefined,
      role: 'assistant',
      stopReason: message.stopReason,
      text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: transcriptUsage(message.usage),
    },
    toolCalls: completedTools,
  }
}
