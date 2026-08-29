import { z } from 'zod'

import { JsonObjectSchema, type JsonObject } from './json-payload'

export type PendingAction = {
  expiresAt: string
  id: string
  preview: string
  token: string
}

type AgentUsage = {
  cacheRead: number
  cacheWrite: number
  cost: number
  input: number
  output: number
  totalTokens: number
}

export type AgentToolCall = {
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
  status: 'error' | 'idle' | 'running'
}

export type DanAgentEvent =
  | { type: 'dan:error'; message: string }
  | { type: 'dan:reasoning_delta'; delta: string }
  | { type: 'dan:text_delta'; delta: string }
  | { type: 'dan:tool_execution_end'; error?: string; output?: string; toolCallId: string; toolName: string }
  | { type: 'dan:tool_execution_start'; input: JsonObject; label: string; toolCallId: string; toolName: string }
  | { type: 'dan:turn_end' }
  | { type: 'dan:turn_start' }

const DanAgentEventSchema = z.discriminatedUnion('type', [
  z.object({ message: z.string(), type: z.literal('dan:error') }),
  z.object({ delta: z.string(), type: z.literal('dan:reasoning_delta') }),
  z.object({ delta: z.string(), type: z.literal('dan:text_delta') }),
  z.object({
    error: z.string().optional(),
    output: z.string().optional(),
    toolCallId: z.string(),
    toolName: z.string(),
    type: z.literal('dan:tool_execution_end'),
  }),
  z.object({
    input: JsonObjectSchema,
    label: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    type: z.literal('dan:tool_execution_start'),
  }),
  z.object({ type: z.literal('dan:turn_end') }),
  z.object({ type: z.literal('dan:turn_start') }),
])

/** Relay frames arrive over a socket; validate each variant before dispatch. */
export function isDanAgentEvent(value: JsonObject): value is DanAgentEvent {
  return DanAgentEventSchema.safeParse(value).success
}
