import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Bot, Send, ShieldCheck, Sparkles } from 'lucide-react'

import { volatilityVerdict, type Ticker } from '../domain/market'

type PendingAction = {
  expiresAt: string
  id: string
  preview: string
  token: string
}

type ChatMessage = {
  actionStatus?: string
  id: string
  pendingAction?: PendingAction
  role: 'assistant' | 'user'
  text: string
}

function ActionCard({
  action,
  messageId,
  onResolved,
}: {
  action: PendingAction
  messageId: string
  onResolved: (messageId: string, status: string) => void
}) {
  const [working, setWorking] = useState(false)
  const resolve = async (decision: 'confirm' | 'deny') => {
    setWorking(true)
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(action.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, token: action.token }),
      })
      const payload = await response.json() as { detail?: string; error?: string }
      onResolved(messageId, payload.detail ?? payload.error ?? 'Action resolved')
    } catch {
      onResolved(messageId, 'Could not reach the action service')
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="action-card">
      <div className="action-label"><ShieldCheck size={16} aria-hidden="true" /><span>Brokerage confirmation</span></div>
      <strong>{action.preview}</strong>
      <small>Expires in 5 minutes · orders are dry-run before submission</small>
      <div className="action-buttons">
        <button disabled={working} onClick={() => resolve('deny')} type="button">Discard</button>
        <button disabled={working} onClick={() => resolve('confirm')} type="button">{working ? 'Working…' : 'Confirm action'}</button>
      </div>
    </div>
  )
}

export function AgentScreen({ selected }: { selected: Ticker }) {
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: 'welcome',
    role: 'assistant',
    text: `I’m looking at ${selected.symbol}. Ask me about option premium, account state, watchlists, or draft an order. Every tastytrade write stops for confirmation.`,
  }])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, sending])

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setInput('')
    setSending(true)
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', text: trimmed }])
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, selectedSymbol: selected.symbol }),
      })
      const payload = await response.json() as { error?: string; message?: string; pendingAction?: PendingAction }
      setMessages((current) => [...current, {
        id: crypto.randomUUID(), role: 'assistant',
        text: payload.message ?? payload.error ?? 'I could not complete that request.',
        pendingAction: payload.pendingAction,
      }])
    } catch {
      setMessages((current) => [...current, {
        id: crypto.randomUUID(), role: 'assistant',
        text: 'I’m offline. Cached market data is still available, but brokerage actions require a connection.',
      }])
    } finally {
      setSending(false)
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void send(input) }
  const resolved = (messageId: string, status: string) => {
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, pendingAction: undefined, actionStatus: status } : message
    )))
  }
  const suggestions = [
    `Why is ${selected.symbol} vol ${volatilityVerdict(selected)}?`,
    'Show my active positions',
    'Explain the safest bullish structure',
  ]
  return (
    <div className="agent-screen">
      <header className="agent-header">
        <span className="dan-avatar"><Bot size={22} /></span>
        <div><h1>Dan</h1><p><i /> Connected to Spice Must Flow</p></div>
        <button className="icon-button" type="button" aria-label="Agent controls"><ShieldCheck size={20} /></button>
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        <div className="context-chip"><Sparkles size={14} /> Live context · {selected.symbol} · IV rank {selected.ivRank}</div>
        {messages.map((message) => (
          <div className={`message-row ${message.role}`} key={message.id}>
            {message.role === 'assistant' && <span className="mini-avatar">D</span>}
            <div className="message-stack">
              <div className="bubble">{message.text}</div>
              {message.pendingAction && <ActionCard action={message.pendingAction} messageId={message.id} onResolved={resolved} />}
              {message.actionStatus && <div className="action-status"><ShieldCheck size={15} />{message.actionStatus}</div>}
            </div>
          </div>
        ))}
        {sending && <div className="message-row assistant"><span className="mini-avatar">D</span><div className="bubble typing"><i /><i /><i /></div></div>}
      </div>
      <div className="suggestion-row">{suggestions.map((suggestion) => <button onClick={() => void send(suggestion)} key={suggestion} type="button">{suggestion}</button>)}</div>
      <form className="chat-composer" onSubmit={submit}>
        <label><span className="sr-only">Message Dan</span><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about a ticker or draft an order…" /></label>
        <button disabled={!input.trim() || sending} type="submit" aria-label="Send message"><Send size={18} /></button>
      </form>
    </div>
  )
}
