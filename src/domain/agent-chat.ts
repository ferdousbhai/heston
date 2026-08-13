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
  input: Record<string, unknown>
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
  | { type: 'dan:tool_execution_end'; durationMs: number; error?: string; output?: string; toolCallId: string }
  | { type: 'dan:tool_execution_start'; input: Record<string, unknown>; toolCallId: string; toolName: string }
  | { type: 'dan:turn_end' }
  | { type: 'dan:turn_start' }

export function isDanAgentEvent(value: unknown): value is DanAgentEvent {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && type.startsWith('dan:')
}
