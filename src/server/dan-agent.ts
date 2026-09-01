import { type Message } from '@earendil-works/pi-ai'
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
import { toError } from '../domain/failure'
import { jsonObject, type JsonValue } from '../domain/json-payload'
import { newYorkClock } from '../domain/market-clock'
import { preparePendingAction } from './agent'
import { ChatRequestSchema, OrderPlacementParameters } from './agent-contracts'
import {
  createDirectAccountActionTool,
  createRememberTradeSymbolsTool,
} from './account-action-tools'
import { createBrokerageReadTools, readMarketStatus } from './brokerage-read-tools'
import { buildAgentRuntimeContext, loadBrokerageContext } from './brokerage-context'
import { createBrokerageReconciliationTool } from './brokerage-reconciliation'
import { DAN_GREETING_PROMPT, DAN_SYSTEM_PROMPT } from './dan-doctrine'
import { readOwnerFavoriteSymbols } from './favorites'
import { type AppEnv } from './env'
import { createPiRuntime } from './pi-runtime'
import { grokGatewayBaseUrl } from './ai-gateway'
import { readStoredSecret } from './secrets'
import { buildPortfolioPolicyContext } from './portfolio-risk'
import { createMarketResearchTools } from './market-research-tools'
import { createResearchReadTools } from './research-read-tools'
import { createResearchAgentTools, type RetainedPage } from './research-agent-tools'
import { createCatalystWriteTool } from './catalyst-write-tool'
import { createWatchlistReadTool } from './watchlist-tool'
import { createExactOptionGreeksReadTool } from './option-greeks-tool'
import {
  completedToolCall,
  projectTurnEnd,
  replayTranscript,
  toolResultText,
} from './dan-transcript'

/** The chat relay delivers text frames; binary frames are not part of the client protocol. */
const ClientFrameSchema = z.string()

const GreetRequestSchema = z.strictObject({
  selectedSymbol: z.string().min(1).max(16).optional(),
  type: z.literal('greet'),
})

const ActionResolvedSchema = z.strictObject({
  messageId: z.string(),
  status: z.string().min(1).max(240),
  type: z.literal('action_resolved'),
})

export class DanAgent extends Agent<AppEnv & Cloudflare.Env, DanAgentState> {
  initialState: DanAgentState = {
    contextWindow: 0,
    messages: [],
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
      return
    }
    // The fixed welcome paragraph predates the generated opener. A transcript holding only it
    // is an empty conversation wearing old copy; clearing it lets the opener take over.
    if (this.state.messages.length === 1 && this.state.messages[0]?.id === 'welcome') {
      this.setState({ ...this.state, messages: [] })
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
      this.setState({ contextWindow: this.state.contextWindow, messages: [], model: this.state.model, status: 'idle' })
      return
    }
    if (command.type === 'action_resolved') {
      const resolved = ActionResolvedSchema.safeParse(command).data
      if (!resolved) return
      this.setState({
        ...this.state,
        messages: this.state.messages.map((message) => message.id === resolved.messageId
          ? { ...message, actionStatus: resolved.status, pendingAction: undefined }
          : message),
      })
      return
    }
    if (command.type === 'greet') {
      // Only ever opens an empty transcript: a reader who has already spoken has a session,
      // and re-greeting them would talk over it.
      if (this.state.status === 'running' || this.state.messages.length > 0) return
      const greeting = GreetRequestSchema.safeParse(command).data
      if (!greeting) return
      this.setState({ ...this.state, error: undefined, status: 'running' })
      const opening = this.keepAliveWhile(
        () => this.runTurn(greeting.selectedSymbol, DAN_GREETING_PROMPT, crypto.randomUUID(), true),
      ).catch((cause: unknown) => {
        const error = toError(cause)
        console.error('DanAgentGreetingFailed', error ? error.message.slice(0, 500) : 'UnknownError')
      })
      this.ctx.waitUntil(opening)
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
      messages: [...this.state.messages, userMessage],
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

  /**
   * Starred tickers are context, not ground truth for a trade, so a store that cannot answer
   * costs the turn its garnish and not its life.
   */
  private async readStarredSymbols(): Promise<string[] | undefined> {
    if (!this.env.DB) return undefined
    try {
      return await readOwnerFavoriteSymbols(this.env.DB)
    } catch (error) {
      console.error('DanStarredSymbolsUnavailable', error instanceof Error ? error.message : 'UnknownError')
      return undefined
    }
  }

  private sendEvent(event: DanAgentEvent) {
    this.broadcast(JSON.stringify(event))
  }

  /**
   * `ephemeral` carries an instruction the model must answer but the transcript must not keep:
   * the greeting asks for an opening line, and storing that request would leave the owner
   * reading a prompt they never wrote.
   */
  private async runTurn(
    selectedSymbol: string | undefined,
    currentUserMessage: string,
    runId: string,
    ephemeral = false,
  ) {
    const controller = new AbortController()
    this.abortController = controller
    let turnFailure: string | undefined
    try {
      const [account, liveMarketSession, starredSymbols] = await Promise.all([
        loadBrokerageContext(this.env),
        readMarketStatus(this.env),
        this.readStarredSymbols(),
      ])
      const portfolioPolicy = await buildPortfolioPolicyContext(this.env, account)
      const [apiKey, gatewayToken, gatewayBaseUrl] = await Promise.all([
        readStoredSecret(this.env.XAI_API_KEY, 'XAI_API_KEY'),
        readStoredSecret(this.env.AI_GATEWAY_TOKEN, 'AI_GATEWAY_TOKEN'),
        grokGatewayBaseUrl(this.env),
      ])
      const runtime = createPiRuntime(apiKey, gatewayToken, gatewayBaseUrl, runId)
      this.setState({ ...this.state, contextWindow: runtime.model.contextWindow, model: `pi · ${runtime.model.id}` })

      const pendingActions = new Map<string, PendingAction>()
      const brokerageActionTool: AgentTool<typeof OrderPlacementParameters, { pendingAction: PendingAction }> = {
        description: 'Draft an equity, option, debit vertical, or price replacement.',
        execute: async (toolCallId, params) => {
          const pendingAction = await preparePendingAction(this.env, params)
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
        executionMode: 'sequential',
        label: 'Preparing order',
        name: 'prepare_brokerage_action',
        parameters: OrderPlacementParameters,
      }
      const accountContext = buildAgentRuntimeContext(account)
      const turnContext = {
        clock: newYorkClock(),
        marketSession: liveMarketSession,
        portfolioPolicy,
        // What the owner is deliberately monitoring. Undefined when the store could not
        // answer, which serialization drops — absent, rather than empty, because an empty
        // list is a real fact about the owner.
        starredSymbols,
      }
      const runtimeContext = JSON.stringify(selectedSymbol
        ? { ...accountContext, selectedSymbol, ...turnContext }
        : { ...accountContext, ...turnContext })
      const retainedResearchPages = new Map<string, RetainedPage>()
      const tools = [
        brokerageActionTool,
        createBrokerageReconciliationTool(this.env),
        createDirectAccountActionTool(this.env, currentUserMessage),
        createRememberTradeSymbolsTool(this.env),
        createWatchlistReadTool(this.env),
        createExactOptionGreeksReadTool(this.env),
        ...createBrokerageReadTools(this.env),
        ...createMarketResearchTools(),
        ...createResearchAgentTools(this.env, {
          retained: retainedResearchPages,
        }),
        // Dan's explicit mutation stays separate from the daily workflow's read-only research
        // tools. It still requires a page retained during this turn and an exact date in its text.
        createCatalystWriteTool(this.env, 'dan', { retained: retainedResearchPages }),
        ...createResearchReadTools(this.env),
      ]
      const toolLabel = new Map(tools.map((tool) => [tool.name, tool.label] as const))
      const context: AgentContext = {
        messages: ephemeral
          ? [...replayTranscript(this.state.messages, runtime.model), {
            content: currentUserMessage,
            role: 'user' as const,
            timestamp: Date.now(),
          }]
          : replayTranscript(this.state.messages, runtime.model),
        systemPrompt: `${DAN_SYSTEM_PROMPT}\n\n<runtime_context>${runtimeContext}</runtime_context>`,
        tools,
      }
      let turnTools = new Map<string, AgentToolCall>()

      const emit = async (event: AgentEvent) => {
        switch (event.type) {
          case 'agent_end':
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
            }
            break
          }
          case 'tool_execution_start': {
            const toolInput = jsonObject(event.args)
            if (!toolInput) throw new Error(`DanAgent:invalid-tool-input:${event.toolCallId}`)
            const label = toolLabel.get(event.toolName) ?? event.toolName
            turnTools.set(event.toolCallId, {
              id: event.toolCallId,
              input: toolInput,
              label,
              name: event.toolName,
              status: 'running',
            })
            this.sendEvent({
              input: toolInput,
              label,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              type: 'dan:tool_execution_start',
            })
            break
          }
          case 'tool_execution_end': {
            const output = toolResultText(event.result.content)
            const existing = turnTools.get(event.toolCallId)
            if (!existing) throw new Error(`DanAgent:missing-tool-start:${event.toolCallId}`)
            turnTools.set(event.toolCallId, completedToolCall(existing, output, event.isError))
            this.sendEvent({
              error: event.isError ? output : undefined,
              output: event.isError ? undefined : output,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              type: 'dan:tool_execution_end',
            })
            break
          }
          case 'turn_end': {
            const projected = projectTurnEnd(event, turnTools, pendingActions, crypto.randomUUID())
            if (projected.kind === 'ignored') break
            if (projected.kind === 'failed') {
              turnFailure = projected.message
              break
            }
            turnTools = projected.toolCalls
            this.setState({
              ...this.state,
              messages: [...this.state.messages, projected.message],
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
        model: runtime.model,
        shouldStopAfterTurn: () => controller.signal.aborted,
        toolExecution: 'parallel',
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
