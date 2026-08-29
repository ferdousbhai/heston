import {
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolResultMessage,
  type Usage,
} from '@earendil-works/pi-ai'
import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentTool,
} from '@earendil-works/pi-agent-core'
import { Agent, type Connection, type WSMessage } from 'agents'
import { z } from 'zod'

import {
  type AgentChatMessage,
  type AgentToolCall,
  type DanAgentEvent,
  type DanAgentState,
  type PendingAction,
} from '../domain/agent-chat'
import { compactTranscript } from '../domain/agent-transcript'
import { EQUITY_SYMBOL_PATTERN } from '../domain/instrument'
import { toError } from '../domain/failure'
import { jsonObject, jsonObjectOrEmpty, type JsonValue } from '../domain/json-payload'
import { newYorkClock } from '../domain/market-clock'
import { preparePendingAction } from './agent'
import { ChatRequestSchema, OrderPlacementSchema } from './agent-contracts'
import {
  createCancelOrderTool,
  createRememberTradeSymbolsTool,
  createWatchlistManagementTool,
} from './account-action-tools'
import { createBrokerageReadTools, readMarketStatus } from './brokerage-read-tools'
import { buildAgentRuntimeContext, loadBrokerageContext } from './brokerage-context'
import { createBrokerageReconciliationTool } from './brokerage-reconciliation'
import { DAN_SYSTEM_PROMPT } from './dan-doctrine'
import { type AppEnv } from './env'
import { createPiRuntime } from './pi-runtime'
import { grokGatewayBaseUrl } from './ai-gateway'
import { readStoredSecret } from './secrets'
import { buildPortfolioPolicyContext } from './portfolio-risk'
import { createMarketResearchTools } from './market-research-tools'
import { createResearchReadTools } from './research-read-tools'
import { createResearchAgentTools } from './research-agent-tools'
import { createWatchlistReadTool } from './watchlist-tool'
import { createExactOptionGreeksReadTool } from './option-greeks-tool'

const MAX_STORED_TOOL_RESULT_CHARS = 4_000

/** The chat relay delivers text frames; binary frames are not part of the client protocol. */
const ClientFrameSchema = z.string()

const ActionResolvedSchema = z.looseObject({ messageId: z.string(), status: z.string() })

// Model-facing JSON Schema only; OrderPlacementSchema.parse stays the sole validator.
const OrderActionType = Type.Union([
  Type.Literal('Buy to Open'), Type.Literal('Sell to Open'),
  Type.Literal('Buy to Close'), Type.Literal('Sell to Close'),
])
const ExpiryDateType = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
const PositivePriceType = Type.Number({ exclusiveMinimum: 0 })
const OptionTypeType = Type.Union([Type.Literal('C'), Type.Literal('P')])
const PriceEffectType = Type.Union([Type.Literal('Debit'), Type.Literal('Credit')])
const UnderlyingSymbolType = Type.String({ pattern: EQUITY_SYMBOL_PATTERN })

const OrderPlacementParameters = Type.Union([
  Type.Object({
    action: OrderActionType,
    expiry: ExpiryDateType,
    kind: Type.Literal('place_option_order'),
    limitPrice: PositivePriceType,
    optionType: OptionTypeType,
    priceEffect: PriceEffectType,
    quantity: Type.Integer({ maximum: 100, minimum: 1 }),
    strike: PositivePriceType,
    underlying: UnderlyingSymbolType,
  }),
  Type.Object({
    action: OrderActionType,
    kind: Type.Literal('place_equity_order'),
    limitPrice: PositivePriceType,
    priceEffect: PriceEffectType,
    quantity: Type.Integer({ maximum: 10_000, minimum: 1 }),
    symbol: UnderlyingSymbolType,
  }),
  Type.Object({
    expiry: ExpiryDateType,
    kind: Type.Literal('place_vertical_spread_order'),
    limitPrice: PositivePriceType,
    longStrike: PositivePriceType,
    optionType: OptionTypeType,
    priceEffect: Type.Literal('Debit'),
    quantity: Type.Integer({ maximum: 100, minimum: 1 }),
    shortStrike: PositivePriceType,
    underlying: UnderlyingSymbolType,
  }),
  Type.Object({
    kind: Type.Literal('replace_order'),
    limitPrice: PositivePriceType,
    orderId: Type.String({ pattern: '^\\d{1,40}$' }),
  }),
])

function welcomeMessage(): AgentChatMessage {
  return {
    createdAt: new Date().toISOString(),
    id: 'welcome',
    role: 'assistant',
    text: 'Ask me about option premium, account state, watchlists, or a defined-risk order. I can inspect and reason freely; only order placement stops at a confirmation boundary.',
  }
}

function emptyUsage(): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  }
}

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

function contentText(content: ToolResultMessage['content']): string {
  return content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function boundedText(value: string, max = MAX_STORED_TOOL_RESULT_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`
}

/** Tool results are stored asymmetrically: errors stay short, successful output keeps more context. */
function applyToolOutcome(call: AgentToolCall, output: string, isError: boolean) {
  call.error = isError ? boundedText(output, 1_000) : undefined
  call.output = isError ? undefined : boundedText(output)
  call.status = isError ? 'error' : 'complete'
}

function replayTranscript(messages: AgentChatMessage[], model: Model<any>): Message[] {
  const replay: Message[] = []
  for (const message of messages) {
    if (message.id === 'welcome') continue
    const timestamp = Date.parse(message.createdAt)
    if (message.role === 'user') {
      replay.push({ content: message.text, role: 'user', timestamp })
      continue
    }
    const content: AssistantMessage['content'] = []
    if (message.text) content.push({ text: message.text, type: 'text' })
    for (const tool of message.toolCalls ?? []) {
      content.push({ arguments: tool.input, id: tool.id, name: tool.name, type: 'toolCall' })
    }
    if (content.length === 0) continue
    replay.push({
      api: model.api,
      content,
      model: message.model ?? model.id,
      provider: model.provider,
      role: 'assistant',
      stopReason: (message.stopReason === 'toolUse' ? 'toolUse' : 'stop'),
      timestamp,
      usage: message.usage ? {
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: message.usage.cost },
        input: message.usage.input,
        output: message.usage.output,
        totalTokens: message.usage.totalTokens,
      } : emptyUsage(),
    })
    for (const tool of message.toolCalls ?? []) {
      replay.push({
        content: [{ text: boundedText(tool.error ?? tool.output ?? 'Tool completed.'), type: 'text' }],
        isError: Boolean(tool.error),
        role: 'toolResult',
        timestamp,
        toolCallId: tool.id,
        toolName: tool.name,
      })
    }
  }
  return replay
}

export class DanAgent extends Agent<AppEnv & Cloudflare.Env, DanAgentState> {
  initialState: DanAgentState = {
    contextWindow: 0,
    messages: [welcomeMessage()],
    model: 'pi · ready',
    status: 'idle',
  }

  private abortController?: AbortController

  override onStart() {
    if (this.state.status === 'running') {
      this.setState({
        ...this.state,
        error: 'The previous run was interrupted before it could finish.',
        status: 'error',
      })
    }
  }

  override validateStateChange(_nextState: DanAgentState, source: Connection | 'server') {
    if (source !== 'server') throw new Error('Chat state is server-owned')
  }

  override onMessage(_connection: Connection, raw: WSMessage) {
    const frame = ClientFrameSchema.safeParse(raw).data
    if (frame === undefined) return
    let decoded: JsonValue
    try {
      decoded = JSON.parse(frame)
    } catch {
      return
    }
    const command = jsonObject(decoded)
    if (!command) return
    if (command.type === 'cancel') {
      this.abortController?.abort(new Error('Operation aborted'))
      return
    }
    if (command.type === 'clear') {
      if (this.state.status === 'running') return
      this.setState({ contextWindow: this.state.contextWindow, messages: [welcomeMessage()], model: this.state.model, status: 'idle' })
      return
    }
    if (command.type === 'action_resolved') {
      const resolved = ActionResolvedSchema.safeParse(command).data
      if (!resolved) return
      const status = resolved.status.slice(0, 240)
      this.setState({
        ...this.state,
        messages: this.state.messages.map((message) => message.id === resolved.messageId
          ? { ...message, actionStatus: status, pendingAction: undefined }
          : message),
      })
      return
    }
    if (command.type !== 'submit' || this.state.status === 'running') return
    const parsed = ChatRequestSchema.safeParse(command)
    if (!parsed.success) {
      this.sendEvent({ message: 'Enter a valid message.', type: 'dan:error' })
      return
    }
    const userMessage: AgentChatMessage = {
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      role: 'user',
      text: parsed.data.message,
    }
    this.setState({
      ...this.state,
      error: undefined,
      messages: compactTranscript([...this.state.messages, userMessage]),
      status: 'running',
    })
    // Model/tool turns can span minutes; the SDK heartbeat prevents idle eviction while waitUntil
    // keeps the WebSocket event alive. onStart still closes any truly interrupted turn after restart.
    const run = this.keepAliveWhile(
      () => this.runTurn(parsed.data.selectedSymbol, parsed.data.message, userMessage.id),
    ).catch((cause: unknown) => {
      const error = toError(cause)
      console.error('DanAgentTurnFailed', error ? error.message.slice(0, 500) : 'UnknownError')
    })
    this.ctx.waitUntil(run)
  }

  private sendEvent(event: DanAgentEvent) {
    this.broadcast(JSON.stringify(event))
  }

  private async runTurn(selectedSymbol: string | undefined, currentUserMessage: string, runId: string) {
    const controller = new AbortController()
    this.abortController = controller
    let turnFailure: string | undefined
    try {
      const [account, liveMarketSession] = await Promise.all([
        loadBrokerageContext(this.env),
        readMarketStatus(this.env).catch((cause: unknown) => {
          const error = toError(cause)
          console.warn('DanMarketStatusUnavailable', error ? error.message.slice(0, 200) : 'UnknownError')
          return {
            asOf: new Date().toISOString(),
            source: 'tastytrade' as const,
            state: 'Unavailable',
            truncated: false as const,
          }
        }),
      ])
      const portfolioPolicy = await buildPortfolioPolicyContext(this.env, account)
      let apiKey: string
      let gatewayToken: string
      let gatewayBaseUrl: string
      try {
        [apiKey, gatewayToken, gatewayBaseUrl] = await Promise.all([
          readStoredSecret(this.env.XAI_API_KEY, 'XAI_API_KEY'),
          readStoredSecret(this.env.AI_GATEWAY_TOKEN, 'AI_GATEWAY_TOKEN'),
          grokGatewayBaseUrl(this.env),
        ])
      } catch {
        throw new Error("Dan's model credential is unavailable.")
      }
      const runtime = createPiRuntime(apiKey, gatewayToken, gatewayBaseUrl, runId)
      this.setState({ ...this.state, contextWindow: runtime.model.contextWindow, model: `pi · ${runtime.model.id}` })

      const pendingActions = new Map<string, PendingAction>()
      const brokerageActionTool: AgentTool<typeof OrderPlacementParameters, { pendingAction: PendingAction }> = {
        description: 'Prepare one tastytrade equity, single option, two-leg debit vertical, or price-only order replacement. This never places or replaces the order; it creates a short-lived draft that the user must explicitly confirm.',
        execute: async (toolCallId, params) => {
          const action = OrderPlacementSchema.parse(params)
          const pendingAction = await preparePendingAction(this.env, action)
          pendingActions.set(toolCallId, pendingAction)
          return {
            content: [{
              text: JSON.stringify({
                expiresAt: pendingAction.expiresAt,
                preview: pendingAction.preview,
                status: 'awaiting_user_confirmation',
              }),
              type: 'text',
            }],
            details: { pendingAction },
          }
        },
        label: 'Preparing order',
        name: 'prepare_brokerage_action',
        parameters: OrderPlacementParameters,
      }
      const accountContext = buildAgentRuntimeContext(account)
      const turnContext = { clock: newYorkClock(), marketSession: liveMarketSession, portfolioPolicy }
      const runtimeContext = JSON.stringify(selectedSymbol
        ? { ...accountContext, selectedSymbol, ...turnContext }
        : { ...accountContext, ...turnContext })
      const tools = [
        brokerageActionTool,
        createBrokerageReconciliationTool(this.env),
        createCancelOrderTool(this.env, currentUserMessage),
        createWatchlistManagementTool(this.env, currentUserMessage),
        createRememberTradeSymbolsTool(this.env),
        createWatchlistReadTool(this.env),
        createExactOptionGreeksReadTool(this.env),
        ...createBrokerageReadTools(this.env),
        ...createMarketResearchTools(),
        ...createResearchAgentTools(this.env),
        ...createResearchReadTools(this.env),
      ]
      const toolLabel = new Map(tools.map((tool) => [tool.name, tool.label] as const))
      const context: AgentContext = {
        messages: replayTranscript(this.state.messages, runtime.model),
        systemPrompt: `${DAN_SYSTEM_PROMPT}\n\n<runtime_context>${runtimeContext}</runtime_context>`,
        tools,
      }
      let turnCount = 0
      const toolStartedAt = new Map<string, number>()
      let turnTools = new Map<string, AgentToolCall>()

      const emit = async (event: AgentEvent) => {
        switch (event.type) {
          case 'agent_end':
            this.sendEvent({ type: 'dan:agent_end' })
            break
          case 'turn_start':
            turnTools = new Map()
            this.sendEvent({ type: 'dan:turn_start' })
            break
          case 'message_update': {
            const update = event.assistantMessageEvent
            if (update.type === 'text_delta') {
              this.sendEvent({ delta: update.delta, type: 'dan:text_delta' })
            } else if (update.type === 'thinking_delta') {
              this.sendEvent({ delta: update.delta, type: 'dan:reasoning_delta' })
            } else if (update.type === 'toolcall_start') {
              const block = update.partial.content[update.contentIndex]
              if (block?.type !== 'toolCall') break
              turnTools.set(block.id, {
                id: block.id,
                input: block.arguments,
                label: toolLabel.get(block.name) ?? block.name,
                name: block.name,
                status: 'running',
              })
              this.sendEvent({ toolCallId: block.id, toolName: block.name, type: 'dan:tool_call_start' })
            } else if (update.type === 'toolcall_delta') {
              const block = update.partial.content[update.contentIndex]
              if (block?.type !== 'toolCall') break
              const existing = turnTools.get(block.id)
              if (existing) existing.input = block.arguments
              this.sendEvent({ delta: update.delta, toolCallId: block.id, type: 'dan:tool_call_delta' })
            }
            break
          }
          case 'tool_execution_start': {
            toolStartedAt.set(event.toolCallId, Date.now())
            const existing = turnTools.get(event.toolCallId)
            const toolInput = jsonObjectOrEmpty(event.args)
            if (existing) existing.input = toolInput
            this.sendEvent({
              input: toolInput,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              type: 'dan:tool_execution_start',
            })
            break
          }
          case 'tool_execution_end': {
            const durationMs = Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now())
            const output = contentText(event.result.content)
            const existing = turnTools.get(event.toolCallId)
            if (existing) {
              existing.durationMs = durationMs
              applyToolOutcome(existing, output, event.isError)
            }
            this.sendEvent({
              durationMs,
              error: event.isError ? output : undefined,
              output: event.isError ? undefined : output,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              type: 'dan:tool_execution_end',
            })
            break
          }
          case 'turn_end': {
            const message = event.message
            if (message.role !== 'assistant') break
            if (message.stopReason === 'error' || message.stopReason === 'aborted') {
              turnFailure = message.errorMessage ?? 'The model request failed.'
              break
            }
            const toolResults = new Map(event.toolResults.map((result) => [result.toolCallId, result]))
            for (const block of message.content) {
              if (block.type !== 'toolCall') continue
              const stored: AgentToolCall = turnTools.get(block.id) ?? {
                id: block.id,
                input: block.arguments,
                label: toolLabel.get(block.name) ?? block.name,
                name: block.name,
                status: 'complete' as const,
              }
              const result = toolResults.get(block.id)
              if (result) applyToolOutcome(stored, contentText(result.content), result.isError)
              turnTools.set(block.id, stored)
            }
            const toolCalls = [...turnTools.values()]
            const pendingAction = toolCalls.map((call) => pendingActions.get(call.id)).find(Boolean)
            const transcriptMessage: AgentChatMessage = {
              createdAt: new Date(message.timestamp).toISOString(),
              id: crypto.randomUUID(),
              model: message.model,
              pendingAction,
              reasoning: message.content.flatMap((part) => part.type === 'thinking' && !part.redacted ? [part.thinking] : []).join('\n\n') || undefined,
              role: 'assistant',
              stopReason: message.stopReason,
              text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''),
              toolCalls: toolCalls.length ? toolCalls : undefined,
              usage: transcriptUsage(message.usage),
            }
            this.setState({
              ...this.state,
              messages: compactTranscript([...this.state.messages, transcriptMessage]),
            })
            this.sendEvent({ type: 'dan:turn_end' })
            break
          }
        }
      }

      if (context.messages.length === 0 || context.messages[context.messages.length - 1]?.role === 'assistant') {
        throw new Error('The conversation has no user message to answer.')
      }
      await runAgentLoopContinue(context, {
        // SAFETY: this agent never appends CustomMessage values, so the context holds only pi Message values.
        convertToLlm: (messages) => messages as Message[],
        maxTokens: 1_200,
        model: runtime.model,
        shouldStopAfterTurn: () => controller.signal.aborted || ++turnCount >= 8,
        toolExecution: 'sequential',
      }, emit, controller.signal, runtime.stream)
      if (controller.signal.aborted) turnFailure = 'Operation aborted'
    } catch (error) {
      turnFailure = error instanceof Error ? error.message : 'The agent runtime failed.'
    } finally {
      if (this.abortController === controller) this.abortController = undefined
      if (turnFailure) this.sendEvent({ message: turnFailure, type: 'dan:error' })
      this.setState({
        ...this.state,
        error: turnFailure,
        status: turnFailure ? 'error' : 'idle',
      })
    }
  }
}
