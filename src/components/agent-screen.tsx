import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useAgent } from 'agents/react'
import { Bot, Check, ChevronRight, CircleStop, Clock3, Send, ShieldCheck, Trash2, Wrench, X } from 'lucide-react'
import { z } from 'zod'

import { jsonObject, JsonObjectSchema, type JsonValue } from '../domain/json-payload'
import {
  isDanAgentEvent,
  type AgentChatMessage,
  type AgentToolCall,
  type DanAgentState,
  type PendingAction,
} from '../domain/agent-chat'
import { volatilityVerdict, type Ticker } from '../domain/market'

/** The relay delivers text frames; binary frames are not part of the agent protocol. */
const RelayFrameSchema = z.string()

const ActionResponseSchema = z.looseObject({ detail: z.string().optional(), error: z.string().optional() })

type ProvisionalTool = AgentToolCall & { rawInput: string }
type ProvisionalTurn = { reasoning: string; text: string; tools: ProvisionalTool[] }

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

function formatDuration(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return <span key={index}>{part}</span>
  })
}

function RichText({ text }: { text: string }) {
  const sections = text.split('```')
  const nodes: ReactNode[] = []
  sections.forEach((section, sectionIndex) => {
    if (sectionIndex % 2 === 1) {
      nodes.push(<pre className="agent-code" key={`code-${sectionIndex}`}><code>{section.trim()}</code></pre>)
      return
    }
    const lines = section.split('\n')
    let list: string[] = []
    const flushList = () => {
      if (!list.length) return
      nodes.push(<ul key={`list-${sectionIndex}-${nodes.length}`}>{list.map((line, index) => <li key={index}><InlineText text={line} /></li>)}</ul>)
      list = []
    }
    lines.forEach((line, lineIndex) => {
      if (/^[-*] /.test(line)) {
        list.push(line.slice(2))
        return
      }
      flushList()
      if (!line.trim()) return
      if (/^#{1,3} /.test(line)) {
        nodes.push(<strong className="agent-markdown-heading" key={`${sectionIndex}-${lineIndex}`}><InlineText text={line.replace(/^#{1,3} /, '')} /></strong>)
      } else {
        nodes.push(<p key={`${sectionIndex}-${lineIndex}`}><InlineText text={line} /></p>)
      }
    })
    flushList()
  })
  return <div className="agent-markdown">{nodes}</div>
}

function ToolCallRow({ tool }: { tool: AgentToolCall }) {
  const [open, setOpen] = useState(false)
  const duration = formatDuration(tool.durationMs)
  return (
    <div className={`tool-call ${tool.status}`}>
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)} type="button">
        <span className="tool-call-icon"><Wrench size={13} aria-hidden="true" /></span>
        <span className="tool-call-label">{tool.label}</span>
        {duration && <span className="tool-call-duration">{duration}</span>}
        <span className="tool-call-status" aria-label={tool.status}>
          {tool.status === 'running' ? <i /> : tool.status === 'error' ? <X size={13} /> : <Check size={13} />}
        </span>
        <ChevronRight className={open ? 'open' : ''} size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="tool-call-detail">
          <span>Input</span>
          <pre>{JSON.stringify(tool.input, null, 2)}</pre>
          {(tool.output || tool.error) && <><span>{tool.error ? 'Error' : 'Output'}</span><pre>{tool.error ?? tool.output}</pre></>}
        </div>
      )}
    </div>
  )
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
  const [error, setError] = useState<string>()
  const resolve = async (decision: 'confirm' | 'deny') => {
    setError(undefined)
    setWorking(true)
    try {
      const response = await fetch(`/api/actions/${encodeURIComponent(action.id)}`, {
        body: JSON.stringify({ decision, token: action.token }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const payload = ActionResponseSchema.safeParse(await response.json()).data
      if (!response.ok) {
        setError(payload?.error ?? 'The action could not be resolved')
        return
      }
      onResolved(messageId, payload?.detail ?? payload?.error ?? 'Action resolved')
    } catch {
      setError('Could not reach the action service')
    } finally {
      setWorking(false)
    }
  }
  return (
    <div className="action-card">
      <div className="action-label"><ShieldCheck size={15} aria-hidden="true" /><span>Order confirmation</span></div>
      <strong>{action.preview}</strong>
      <small>Short-lived draft · validated again before dispatch</small>
      {error && <small className="action-error" role="alert">{error}</small>}
      <div className="action-buttons">
        <button disabled={working} onClick={() => resolve('deny')} type="button">Discard</button>
        <button disabled={working} onClick={() => resolve('confirm')} type="button">{working ? 'Working…' : 'Place order'}</button>
      </div>
    </div>
  )
}

function TranscriptMessage({ message, onResolved }: {
  message: AgentChatMessage
  onResolved: (messageId: string, status: string) => void
}) {
  if (message.role === 'user') {
    return (
      <article className="agent-message user">
        <div className="agent-message-meta"><span>you</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        <div className="user-prompt">{message.text}</div>
      </article>
    )
  }
  return (
    <article className="agent-message assistant">
      <div className="agent-message-meta"><span>dan</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
      {message.reasoning && <details className="reasoning-trace"><summary>Thinking</summary><RichText text={message.reasoning} /></details>}
      {message.text && <RichText text={message.text} />}
      {message.toolCalls?.map((tool) => <ToolCallRow key={tool.id} tool={tool} />)}
      {message.pendingAction && <ActionCard action={message.pendingAction} messageId={message.id} onResolved={onResolved} />}
      {message.actionStatus && <div className="action-status"><ShieldCheck size={14} aria-hidden="true" />{message.actionStatus}</div>}
      {message.usage && message.usage.totalTokens > 0 && (
        <div className="message-usage">↑{formatTokens(message.usage.input)} ↓{formatTokens(message.usage.output)} · {message.stopReason ?? 'stop'}</div>
      )}
    </article>
  )
}

function RuntimeFooter({ state }: { state: DanAgentState | undefined }) {
  const totals = useMemo(() => (state?.messages ?? []).reduce((result, message) => {
    if (!message.usage) return result
    result.input += message.usage.input
    result.output += message.usage.output
    result.cacheRead += message.usage.cacheRead
    result.cost += message.usage.cost
    return result
  }, { cacheRead: 0, cost: 0, input: 0, output: 0 }), [state?.messages])
  const latestUsage = [...(state?.messages ?? [])].reverse().find((message) => message.usage)?.usage
  const contextUsed = latestUsage ? latestUsage.input + latestUsage.cacheRead + latestUsage.cacheWrite : 0
  const contextPercent = state?.contextWindow ? (contextUsed / state.contextWindow) * 100 : 0
  return (
    <div className="runtime-footer" aria-label="Agent runtime usage">
      <span>↑{formatTokens(totals.input)} ↓{formatTokens(totals.output)}{totals.cacheRead ? ` R${formatTokens(totals.cacheRead)}` : ''}{totals.cost ? ` $${totals.cost.toFixed(3)}` : ''}</span>
      <span>{state?.contextWindow ? `${contextPercent.toFixed(1)}%/${formatTokens(state.contextWindow)}` : 'context —'} · {state?.model ?? 'pi'}</span>
    </div>
  )
}

export function AgentScreen({
  onAccountMutation,
  selected,
}: {
  onAccountMutation?: () => void | Promise<void>
  selected: Ticker
}) {
  const [connected, setConnected] = useState(false)
  const [input, setInput] = useState('')
  const [provisional, setProvisional] = useState<ProvisionalTurn | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const onAgentMessage = useCallback((message: MessageEvent) => {
    const frame = RelayFrameSchema.safeParse(message.data).data
    if (frame === undefined) return
    let decoded: JsonValue
    try { decoded = JSON.parse(frame) } catch { return }
    const event = jsonObject(decoded)
    if (!event || !isDanAgentEvent(event)) return
    if (event.type === 'dan:turn_start') {
      setProvisional({ reasoning: '', text: '', tools: [] })
    } else if (event.type === 'dan:text_delta') {
      setProvisional((current) => ({ reasoning: current?.reasoning ?? '', text: `${current?.text ?? ''}${event.delta}`, tools: current?.tools ?? [] }))
    } else if (event.type === 'dan:reasoning_delta') {
      setProvisional((current) => ({ reasoning: `${current?.reasoning ?? ''}${event.delta}`, text: current?.text ?? '', tools: current?.tools ?? [] }))
    } else if (event.type === 'dan:tool_call_start') {
      setProvisional((current) => ({
        reasoning: current?.reasoning ?? '', text: current?.text ?? '',
        tools: [...(current?.tools ?? []), { id: event.toolCallId, input: {}, label: event.toolName === 'prepare_brokerage_action' ? 'Preparing order' : event.toolName, name: event.toolName, rawInput: '', status: 'running' }],
      }))
    } else if (event.type === 'dan:tool_call_delta') {
      setProvisional((current) => current ? {
        ...current,
        tools: current.tools.map((tool) => {
          if (tool.id !== event.toolCallId) return tool
          const rawInput = `${tool.rawInput}${event.delta}`
          let parsed = tool.input
          try { parsed = JsonObjectSchema.parse(JSON.parse(rawInput)) } catch { /* partial JSON */ }
          return { ...tool, input: parsed, rawInput }
        }),
      } : current)
    } else if (event.type === 'dan:tool_execution_start') {
      setProvisional((current) => current ? { ...current, tools: current.tools.map((tool) => tool.id === event.toolCallId ? { ...tool, input: event.input } : tool) } : current)
    } else if (event.type === 'dan:tool_execution_end') {
      if (!event.error && event.toolName === 'manage_watchlist') void onAccountMutation?.()
      setProvisional((current) => current ? { ...current, tools: current.tools.map((tool) => tool.id === event.toolCallId ? { ...tool, durationMs: event.durationMs, error: event.error, output: event.output, status: event.error ? 'error' : 'complete' } : tool) } : current)
    } else if (event.type === 'dan:turn_end' || event.type === 'dan:agent_end') {
      setProvisional(null)
    }
  }, [onAccountMutation])

  const agent = useAgent<DanAgentState>({
    agent: 'DanAgent',
    name: 'owner',
    onClose: () => setConnected(false),
    onError: () => setConnected(false),
    onMessage: onAgentMessage,
    onOpen: () => setConnected(true),
  })
  const state = agent.state
  const running = state?.status === 'running'

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
  }, [provisional, state?.messages])

  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || running || !connected) return
    setInput('')
    agent.send(JSON.stringify({ message: trimmed, selectedSymbol: selected.symbol, type: 'submit' }))
  }
  const submit = (event: FormEvent) => { event.preventDefault(); send(input) }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send(input)
    }
  }
  const resolved = (messageId: string, status: string) => {
    agent.send(JSON.stringify({ messageId, status, type: 'action_resolved' }))
  }
  const suggestions = [
    `Why is ${selected.symbol} vol ${volatilityVerdict(selected)}?`,
    'Show my active positions',
    'Explain the safest bullish structure',
  ]
  const hasUserMessage = state?.messages.some((message) => message.role === 'user')

  return (
    <div className="agent-screen">
      <header className="agent-header">
        <span className="dan-avatar"><Bot size={21} aria-hidden="true" /></span>
        <div><h1>Dan</h1><p><i className={connected ? 'connected' : ''} />{connected ? `${state?.model ?? 'pi'} runtime` : 'Reconnecting…'}</p></div>
        <button className="icon-button" disabled={running} onClick={() => agent.send(JSON.stringify({ type: 'clear' }))} type="button" aria-label="Clear conversation"><Trash2 size={17} /></button>
      </header>

      <div className="chat-scroll" ref={scrollRef} aria-live="polite">
        {(state?.messages ?? []).map((message) => <TranscriptMessage key={message.id} message={message} onResolved={resolved} />)}
        {running && provisional && (
          <article className="agent-message assistant provisional">
            <div className="agent-message-meta"><span>dan</span><span className="streaming-label">streaming</span></div>
            {!provisional.text && !provisional.reasoning && provisional.tools.length === 0 && <div className="thinking-shimmer">Thinking</div>}
            {provisional.reasoning && <details className="reasoning-trace" open><summary>Thinking</summary><RichText text={provisional.reasoning} /></details>}
            {provisional.text && <RichText text={provisional.text} />}
            {provisional.tools.map((tool) => <ToolCallRow key={tool.id} tool={tool} />)}
          </article>
        )}
        {running && !provisional && <div className="thinking-shimmer">Thinking</div>}
        {state?.error && !running && <div className="agent-runtime-error">{state.error}</div>}
      </div>

      {!hasUserMessage && <div className="suggestion-row">{suggestions.map((suggestion) => <button disabled={!connected} onClick={() => send(suggestion)} key={suggestion} type="button">{suggestion}</button>)}</div>}
      <div className="composer-shell">
        <form className="chat-composer" onSubmit={submit}>
          <label><span className="sr-only">Message Dan</span><textarea onChange={(event) => setInput(event.target.value)} onKeyDown={keyDown} placeholder="Ask about a ticker or draft an order…" rows={1} value={input} /></label>
          {running
            ? <button className="stop-button" onClick={() => agent.send(JSON.stringify({ type: 'cancel' }))} type="button" aria-label="Stop agent"><CircleStop size={18} /></button>
            : <button disabled={!input.trim() || !connected} type="submit" aria-label="Send message"><Send size={17} /></button>}
        </form>
        <div className="composer-hints"><span><Clock3 size={11} /> durable history</span><span><ShieldCheck size={11} /> orders require confirmation</span></div>
        <RuntimeFooter state={state} />
      </div>
    </div>
  )
}
