import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useAgent } from 'agents/react'
import { Bot, Check, ChevronRight, CircleStop, Send, ShieldCheck, Trash2, Wrench, X } from 'lucide-react'
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
import { toError } from '../domain/failure'
import { jsonObject, type JsonValue } from '../domain/json-payload'
import {
  isDanAgentEvent,
  type AgentChatMessage,
  type AgentToolCall,
  type DanAgentState,
  type PendingAction,
} from '../domain/agent-chat'
import { type Ticker } from '../domain/market'

/** The relay delivers text frames; binary frames are not part of the agent protocol. */
const RelayFrameSchema = z.string()

export const ActionResponseSchema = z.looseObject({
  detail: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
})
type ActionResponse = z.infer<typeof ActionResponseSchema>
type ActionResponseResult =
  | { detail: string; error?: never }
  | { detail?: never; error: string }

export function actionResponseResult(
  payload: ActionResponse | undefined,
  responseOk: boolean,
): ActionResponseResult {
  if (!responseOk) return { error: payload?.error ?? 'The action could not be resolved' }
  if (!payload?.detail) return { error: 'The action service returned an invalid response' }
  return { detail: payload.detail }
}

type ProvisionalTurn = { reasoning: string; text: string; tools: AgentToolCall[] }

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
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
  return (
    <Collapsible className={cn('tool-call', tool.status)} onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger render={<Button aria-expanded={open} type="button" variant="ghost" />}>
        <span className="tool-call-icon"><Wrench aria-hidden="true" /></span>
        <span className="tool-call-label">{tool.label}</span>
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
  onAccountMutation,
  onResolved,
}: {
  action: PendingAction
  messageId: string
  onAccountMutation: () => Promise<void>
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
      const payload = ActionResponseSchema.safeParse(await response.json().catch(() => undefined)).data
      const result = actionResponseResult(payload, response.ok)
      if (!result.detail) {
        setError(result.error)
        return
      }
      if (decision === 'confirm') await onAccountMutation()
      onResolved(messageId, result.detail)
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

function TranscriptMessage({ message, onAccountMutation, onResolved }: {
  message: AgentChatMessage
  onAccountMutation: () => Promise<void>
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
        {message.pendingAction && (
          <ActionCard
            action={message.pendingAction}
            messageId={message.id}
            onAccountMutation={onAccountMutation}
            onResolved={onResolved}
          />
        )}
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
  // Before a turn has run there is nothing to account for, and a row of zeros beside
  // "context n/a" reports only that nothing has happened yet.
  if (!totals.input && !totals.output) return null
  const context = state?.contextWindow
    ? `${contextPercent.toFixed(1)}%/${formatTokens(state.contextWindow)}`
    : undefined
  return (
    <div className="runtime-footer" aria-label="Agent runtime usage">
      <span>↑{formatTokens(totals.input)} ↓{formatTokens(totals.output)}{totals.cacheRead ? ` R${formatTokens(totals.cacheRead)}` : ''}{totals.cost ? ` $${totals.cost.toFixed(3)}` : ''}</span>
      {context && <span>{context}</span>}
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
  const [accountRefreshError, setAccountRefreshError] = useState<string>()

  const refreshAccount = useCallback(async () => {
    if (!onAccountMutation) return
    setAccountRefreshError(undefined)
    try {
      await onAccountMutation()
    } catch (cause: unknown) {
      const failure = toError(cause)
      if (failure?.name === 'AbortError') return
      const detail = failure?.message
      setAccountRefreshError(detail
        ? `The account action succeeded, but refresh failed: ${detail}`
        : 'The account action succeeded, but the latest account data could not be refreshed.')
    }
  }, [onAccountMutation])

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
    } else if (event.type === 'dan:tool_execution_start') {
      setProvisional((current) => ({
        reasoning: current?.reasoning ?? '', text: current?.text ?? '',
        tools: [...(current?.tools ?? []), {
          id: event.toolCallId,
          input: event.input,
          label: event.label,
          name: event.toolName,
          status: 'running',
        }],
      }))
    } else if (event.type === 'dan:tool_execution_end') {
      if (!event.error && (
        event.toolName === 'apply_direct_account_action'
        || event.toolName === 'remember_trade_symbols'
        || event.toolName === 'prepare_brokerage_action'
      )) {
        void refreshAccount()
      }
      setProvisional((current) => current ? { ...current, tools: current.tools.map((tool) => tool.id === event.toolCallId ? { ...tool, error: event.error, output: event.output, status: event.error ? 'error' : 'complete' } : tool) } : current)
    } else if (event.type === 'dan:turn_end') {
      setProvisional(null)
    }
  }, [refreshAccount])

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
  // An empty transcript has no opening line yet. The agent refuses a second one, so a
  // reconnect or a re-render cannot talk over a session already under way.
  const greetable = connected && !running && state?.messages.length === 0
  useEffect(() => {
    if (!greetable) return
    agent.send(JSON.stringify({ selectedSymbol: selected.symbol, type: 'greet' }))
  }, [agent, greetable, selected.symbol])

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
        {/* Only a state the reader must wait out is worth a badge; naming the model is not. */}
        <div><h1>Dan</h1>{!connected && <Badge variant="secondary">Reconnecting…</Badge>}</div>
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
                    {group.map((message) => (
                      <TranscriptMessage
                        key={message.id}
                        message={message}
                        onAccountMutation={refreshAccount}
                        onResolved={resolved}
                      />
                    ))}
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
              {accountRefreshError && (
                <MessageScrollerItem messageId="account-refresh-error">
                  <Alert variant="destructive">
                    <AlertTitle>Account refresh failed</AlertTitle>
                    <AlertDescription>{accountRefreshError}</AlertDescription>
                  </Alert>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

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
        <RuntimeFooter state={state} />
      </div>
    </div>
  )
}
