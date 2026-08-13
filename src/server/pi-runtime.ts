import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamFunction,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'

import { type Ticker } from '../domain/market'
import { demoPlan } from './agent-planner'

const DEMO_MODEL: Model<'spice-demo'> = {
  api: 'spice-demo',
  baseUrl: 'local',
  contextWindow: 24_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: 'spice-demo',
  input: ['text'],
  maxTokens: 2_000,
  name: 'Spice demo',
  provider: 'spice',
  reasoning: false,
}

const XAI_MODEL = XAI_MODELS['grok-4.5']

function usage(input: number, output: number): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input,
    output,
    totalTokens: input + output,
  }
}

function messageFor(model: Model<any>, content: AssistantMessage['content'] = []): AssistantMessage {
  return {
    api: model.api,
    content,
    model: model.id,
    provider: model.provider,
    stopReason: 'pending',
    timestamp: Date.now(),
    usage: usage(0, 0),
    role: 'assistant',
  }
}

function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const candidate = context.messages[index]
    if (candidate?.role !== 'user') continue
    if (typeof candidate.content === 'string') return candidate.content
    return candidate.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  }
  return ''
}

function followsToolResult(context: Context): boolean {
  return context.messages[context.messages.length - 1]?.role === 'toolResult'
}

async function emitText(stream: AssistantMessageEventStream, partial: AssistantMessage, text: string, signal?: AbortSignal) {
  const contentIndex = partial.content.length
  partial.content.push({ type: 'text', text: '' })
  stream.push({ contentIndex, partial, type: 'text_start' })
  const chunks = text.match(/\S+\s*/g) ?? [text]
  for (const delta of chunks) {
    signal?.throwIfAborted()
    const block = partial.content[contentIndex]
    if (block?.type === 'text') block.text += delta
    stream.push({ contentIndex, delta, partial, type: 'text_delta' })
    await Promise.resolve()
  }
  stream.push({ content: text, contentIndex, partial, type: 'text_end' })
}

function finish(stream: AssistantMessageEventStream, partial: AssistantMessage, reason: 'stop' | 'toolUse', input: number) {
  const outputText = partial.content.map((part) => part.type === 'text' ? part.text : '').join('')
  partial.stopReason = reason
  partial.usage = usage(input, Math.max(1, Math.ceil(outputText.length / 4)))
  stream.push({ message: partial, reason, type: 'done' })
}

/**
 * Credential-free demo inference still speaks pi's AssistantMessageEventStream protocol, so
 * local and Playwright runs exercise the same agent loop, tools, persistence, and UI event sink.
 */
export function createDemoPiStream(ticker: Ticker | undefined): StreamFunction {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream()
    const partial = messageFor(model)
    stream.push({ partial, type: 'start' })

    void (async () => {
      try {
        if (options?.signal?.aborted) throw options.signal.reason
        const userText = latestUserText(context)
        const plan = demoPlan(userText, ticker)
        const inputTokens = Math.max(1, Math.ceil(JSON.stringify(context.messages).length / 4))
        if (plan.action && !followsToolResult(context)) {
          const toolCall: ToolCall = {
            arguments: plan.action,
            id: crypto.randomUUID(),
            name: 'prepare_brokerage_action',
            type: 'toolCall',
          }
          const contentIndex = partial.content.length
          partial.content.push(toolCall)
          stream.push({ contentIndex, partial, type: 'toolcall_start' })
          stream.push({ contentIndex, delta: JSON.stringify(plan.action), partial, type: 'toolcall_delta' })
          stream.push({ contentIndex, partial, toolCall, type: 'toolcall_end' })
          finish(stream, partial, 'toolUse', inputTokens)
          return
        }
        await emitText(stream, partial, plan.message, options?.signal)
        finish(stream, partial, 'stop', inputTokens)
      } catch (error) {
        partial.errorMessage = error instanceof Error ? error.message : 'Operation aborted'
        partial.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
        stream.push({ error: partial, reason: partial.stopReason, type: 'error' })
      }
    })()

    return stream
  }
}

export function createPiRuntime(apiKey: string | undefined, ticker: Ticker | undefined): {
  model: Model<any>
  stream: StreamFunction
} {
  if (!apiKey) return { model: DEMO_MODEL, stream: createDemoPiStream(ticker) }
  return {
    model: XAI_MODEL,
    stream: (model, context, options) => streamOpenAIResponses(
      model as typeof XAI_MODEL,
      context,
      {
        ...options,
        apiKey,
        reasoningEffort: 'low',
        reasoningSummary: 'auto',
        timeoutMs: 360_000,
      },
    ),
  }
}
