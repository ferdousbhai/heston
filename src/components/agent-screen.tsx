import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useAgent } from 'agents/react'
import { Bot, Check, ChevronRight, CircleStop, Clock3, Send, ShieldCheck, Trash2, Wrench, X } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#/components/ui/alert-dialog'
import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Badge } from '#/components/ui/badge'
import { Bubble, BubbleContent } from '#/components/ui/bubble'
import { Button } from '#/components/ui/button'
import { ButtonGroup } from '#/components/ui/button-group'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '#/components/ui/input-group'
import { Marker, MarkerContent, MarkerIcon } from '#/components/ui/marker'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader } from '#/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '#/components/ui/message-scroller'
import { Spinner } from '#/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'
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

function ReasoningTrace({ defaultOpen = false, text }: { defaultOpen?: boolean; text: string }) {
  return (
    <Collapsible className="reasoning-trace" defaultOpen={defaultOpen}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>Thinking</CollapsibleTrigger>
      <CollapsibleContent><RichText text={text} /></CollapsibleContent>
    </Collapsible>
  )
}

function ToolCallRow({ tool }: { tool: AgentToolCall }) {
  const [open, setOpen] = useState(false)
  const duration = formatDuration(tool.durationMs)
  return (
    <Collapsible className={cn('tool-call', tool.status)} onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger render={<Button aria-expanded={open} type="button" variant="ghost" />}>
        <span className="tool-call-icon"><Wrench aria-hidden="true" /></span>
        <span className="tool-call-label">{tool.label}</span>
        {duration && <span className="tool-call-duration">{duration}</span>}
        <span className="tool-call-status" aria-label={tool.status}>
          {tool.status === 'running' ? <Spinner /> : tool.status === 'error' ? <X /> : <Check />}
        </span>
        <ChevronRight className={open ? 'open' : ''} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="tool-call-detail">
          <span>Input</span>
          <pre>{JSON.stringify(tool.input, null, 2)}</pre>
          {(tool.output || tool.error) && <><span>{tool.error ? 'Error' : 'Output'}</span><pre>{tool.error ?? tool.output}</pre></>}
      </CollapsibleContent>
    </Collapsible>
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
    <Card className="action-card" size="sm" variant="feature">
      <CardHeader>
        <Badge className="action-label" variant="cheap"><ShieldCheck data-icon="inline-start" aria-hidden="true" />Order confirmation</Badge>
        <CardTitle>{action.preview}</CardTitle>
        <CardDescription>Short-lived draft · validated again before dispatch</CardDescription>
      </CardHeader>
      {error && (
        <CardContent>
          <Alert className="action-error" variant="destructive">
            <AlertTitle>Order action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      )}
      <CardFooter className="action-buttons">
        <ButtonGroup aria-label="Resolve order draft">
          <Button disabled={working} onClick={() => void resolve('deny')} type="button" variant="outline">Discard</Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button disabled={working} type="button" variant="success" />}>
              Place order
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Place this order?</AlertDialogTitle>
                <AlertDialogDescription>{action.preview}. The draft will be validated once more immediately before dispatch.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={working}>Back</AlertDialogCancel>
                <AlertDialogAction disabled={working} onClick={() => void resolve('confirm')} variant="success">
                  {working && <Spinner data-icon="inline-start" />}
                  {working ? 'Placing…' : 'Confirm and place'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </ButtonGroup>
      </CardFooter>
    </Card>
  )
}

function TranscriptMessage({ message, onResolved }: {
  message: AgentChatMessage
  onResolved: (messageId: string, status: string) => void
}) {
  if (message.role === 'user') {
    return (
      <Message align="end" className="agent-message user">
        <MessageContent>
          <MessageHeader className="agent-message-meta"><span>you</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></MessageHeader>
          <Bubble align="end" variant="tinted"><BubbleContent className="user-prompt">{message.text}</BubbleContent></Bubble>
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message align="start" className="agent-message assistant">
      <MessageAvatar>
        <Avatar size="sm"><AvatarFallback><Bot aria-hidden="true" /></AvatarFallback></Avatar>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader className="agent-message-meta"><span>dan</span><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></MessageHeader>
        {message.reasoning && <ReasoningTrace text={message.reasoning} />}
        {message.text && <Bubble variant="ghost"><BubbleContent><RichText text={message.text} /></BubbleContent></Bubble>}
        {message.toolCalls?.map((tool) => <ToolCallRow key={tool.id} tool={tool} />)}
        {message.pendingAction && <ActionCard action={message.pendingAction} messageId={message.id} onResolved={onResolved} />}
        {message.actionStatus && (
          <Marker className="action-status" variant="border"><MarkerIcon><ShieldCheck aria-hidden="true" /></MarkerIcon><MarkerContent>{message.actionStatus}</MarkerContent></Marker>
        )}
        {message.usage && message.usage.totalTokens > 0 && (
          <MessageFooter className="message-usage">↑{formatTokens(message.usage.input)} ↓{formatTokens(message.usage.output)} · {message.stopReason ?? 'stop'}</MessageFooter>
        )}
      </MessageContent>
    </Message>
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
      if (!event.error && (
        event.toolName === 'manage_watchlist'
        || event.toolName === 'remember_trade_symbols'
        || event.toolName === 'prepare_brokerage_action'
      )) {
        void onAccountMutation?.()
      }
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
  const messageGroups = useMemo(() => (state?.messages ?? []).reduce<AgentChatMessage[][]>((groups, message) => {
    const current = groups.at(-1)
    if (current?.[0]?.role === message.role) current.push(message)
    else groups.push([message])
    return groups
  }, []), [state?.messages])

  return (
    <div className="agent-screen">
      <header className="agent-header">
        <Avatar className="dan-avatar" size="lg"><AvatarFallback><Bot aria-hidden="true" /></AvatarFallback></Avatar>
        <div><h1>Dan</h1><Badge variant={connected ? 'cheap' : 'secondary'}>{connected ? `${state?.model ?? 'pi'} runtime` : 'Reconnecting…'}</Badge></div>
        <Tooltip>
          <TooltipTrigger render={<Button className="icon-button" disabled={running} onClick={() => agent.send(JSON.stringify({ type: 'clear' }))} size="icon-lg" type="button" variant="outline" />}>
            <Trash2 />
            <span className="sr-only">Clear conversation</span>
          </TooltipTrigger>
          <TooltipContent>Clear conversation</TooltipContent>
        </Tooltip>
      </header>

      <MessageScrollerProvider autoScroll>
        <MessageScroller className="chat-scroll">
          <MessageScrollerViewport aria-live="polite">
            <MessageScrollerContent>
              {messageGroups.map((group) => (
                <MessageScrollerItem key={group[0].id} messageId={group[0].id} scrollAnchor={group[0].role === 'user'}>
                  <MessageGroup>
                    {group.map((message) => <TranscriptMessage key={message.id} message={message} onResolved={resolved} />)}
                  </MessageGroup>
                </MessageScrollerItem>
              ))}
              {running && provisional && (
                <MessageScrollerItem messageId="provisional-turn">
                  <Message align="start" className="agent-message assistant provisional">
                    <MessageAvatar><Avatar size="sm"><AvatarFallback><Bot aria-hidden="true" /></AvatarFallback></Avatar></MessageAvatar>
                    <MessageContent>
                      <MessageHeader className="agent-message-meta"><span>dan</span><Badge variant="secondary">streaming</Badge></MessageHeader>
                      {!provisional.text && !provisional.reasoning && provisional.tools.length === 0 && (
                        <Marker><MarkerContent className="shimmer">Thinking</MarkerContent></Marker>
                      )}
                      {provisional.reasoning && <ReasoningTrace defaultOpen text={provisional.reasoning} />}
                      {provisional.text && <Bubble variant="ghost"><BubbleContent><RichText text={provisional.text} /></BubbleContent></Bubble>}
                      {provisional.tools.map((tool) => <ToolCallRow key={tool.id} tool={tool} />)}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
              {running && !provisional && (
                <MessageScrollerItem messageId="agent-thinking"><Marker><MarkerContent className="shimmer">Thinking</MarkerContent></Marker></MessageScrollerItem>
              )}
              {state?.error && !running && (
                <MessageScrollerItem messageId="agent-runtime-error">
                  <Alert className="agent-runtime-error" variant="destructive"><AlertTitle>Dan stopped</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {!hasUserMessage && <div className="suggestion-row">{suggestions.map((suggestion) => <Button disabled={!connected} onClick={() => send(suggestion)} key={suggestion} size="sm" type="button" variant="outline">{suggestion}</Button>)}</div>}
      <div className="composer-shell">
        <form className="composer-form" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel className="sr-only" htmlFor="dan-message">Message Dan</FieldLabel>
              <InputGroup className="chat-composer">
                <InputGroupTextarea id="dan-message" onChange={(event) => setInput(event.target.value)} onKeyDown={keyDown} placeholder="Ask about a ticker or draft an order…" rows={1} value={input} />
                <InputGroupAddon align="inline-end">
                  {running
                    ? <InputGroupButton aria-label="Stop agent" className="stop-button" onClick={() => agent.send(JSON.stringify({ type: 'cancel' }))} size="icon-sm" type="button" variant="destructive"><CircleStop /></InputGroupButton>
                    : <InputGroupButton aria-label="Send message" disabled={!input.trim() || !connected} size="icon-sm" type="submit" variant="default"><Send /></InputGroupButton>}
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
        </form>
        <div className="composer-hints"><span><Clock3 /> durable history</span><span><ShieldCheck /> orders require confirmation</span></div>
        <RuntimeFooter state={state} />
      </div>
    </div>
  )
}
