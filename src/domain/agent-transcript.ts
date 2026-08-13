import { type AgentChatMessage } from './agent-chat'

const MAX_MESSAGES = 80
const MAX_TRANSCRIPT_CHARS = 120_000

function welcomeMessage(): AgentChatMessage {
  return {
    createdAt: new Date().toISOString(),
    id: 'welcome',
    role: 'assistant',
    text: 'Ask me about option premium, account state, watchlists, or a defined-risk order. I can inspect and reason freely; only order placement stops at a confirmation boundary.',
  }
}

export function compactTranscript(messages: AgentChatMessage[]): AgentChatMessage[] {
  const recent = messages.slice(-MAX_MESSAGES)
  const selected: AgentChatMessage[] = []
  let characters = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!
    const size = JSON.stringify(message).length
    if (selected.length && characters + size > MAX_TRANSCRIPT_CHARS) break
    selected.push(message)
    characters += size
  }
  selected.reverse()
  while (selected[0]?.role === 'assistant' && selected[0]?.id !== 'welcome') selected.shift()
  return selected.length ? selected : [welcomeMessage()]
}
