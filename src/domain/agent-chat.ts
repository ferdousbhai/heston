import { z } from 'zod'

import { type JsonObject } from './json-payload'

export type PendingAction = {
  expiresAt: string
  id: string
  preview: string
  token: string
}

export type AgentUsage = {
  cacheRead: number
  cacheWrite: number
  cost: number
  input: number
  output: number
  totalTokens: number
}

export type AgentToolCall = {
  durationMs?: number
  error?: string
  id: string
  input: JsonObject
  label: string
  name: string
  output?: string
  status: 'complete' | 'error' | 'running'
}

export type AgentChatMessage = {
  actionStatus?: string
  createdAt: string
  id: string
  model?: string
  pendingAction?: PendingAction
  reasoning?: string
  role: 'assistant' | 'user'
  stopReason?: string
  text: string
  toolCalls?: AgentToolCall[]
  usage?: AgentUsage
}

export type DanAgentState = {
  contextWindow: number
  error?: string
  messages: AgentChatMessage[]
  model: string
  startedAt?: string
  status: 'error' | 'idle' | 'running'
}

export type DanAgentEvent =
  | { type: 'dan:agent_end' }
  | { type: 'dan:error'; message: string }
  | { type: 'dan:reasoning_delta'; delta: string }
  | { type: 'dan:text_delta'; delta: string }
  | { type: 'dan:tool_call_delta'; delta: string; toolCallId: string }
  | { type: 'dan:tool_call_start'; toolCallId: string; toolName: string }
  | { type: 'dan:tool_execution_end'; durationMs: number; error?: string; output?: string; toolCallId: string; toolName: string }
  | { type: 'dan:tool_execution_start'; input: JsonObject; toolCallId: string; toolName: string }
  | { type: 'dan:turn_end' }
  | { type: 'dan:turn_start' }

const DanAgentEventEnvelopeSchema = z.looseObject({ type: z.string().startsWith('dan:') })

/** Relay frames arrive over a socket; only the `dan:` discriminant is trusted before dispatch. */
export function isDanAgentEvent(value: JsonObject): value is DanAgentEvent {
  return DanAgentEventEnvelopeSchema.safeParse(value).success
}
