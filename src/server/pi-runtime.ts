import { type Model, type StreamFunction } from '@earendil-works/pi-ai'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'
import { z } from 'zod'

import {
  JsonArraySchema,
  JsonObjectSchema,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { aiGatewayHeaders } from './ai-gateway'
import { grokNativeSearchTools } from './grok-native-tools'
import { defineSeam, type SeamValue } from './seam'

export const GROK_MODEL: Model<'openai-responses'> = {
  ...XAI_MODELS['grok-4.5'],
  id: 'grok-4.6',
  name: 'Grok 4.6',
}

export type PiRuntime = {
  model: Model<'openai-responses'>
  stream: StreamFunction
}

type NativeReplay = { callIds: Set<string>; items: JsonObject[] }
const ResponseIdSchema = z.string()

function responseId(value: JsonValue): string | undefined {
  return ResponseIdSchema.safeParse(value).data
}

function responseItem(event: JsonValue): JsonObject | undefined {
  const record = jsonObject(event)
  return record?.type === 'response.output_item.done' ? jsonObject(record.item) : undefined
}

async function streamItems(response: Response): Promise<JsonObject[]> {
  if (!response.body) return []
  const items: JsonObject[] = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const consume = (line: string) => {
    if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') return
    try {
      const event: JsonValue = JSON.parse(line.slice(5).trim())
      const item = responseItem(event)
      if (item) items.push(item)
    } catch { /* Ignore non-JSON provider event lines. */ }
  }
  for (;;) {
    const { done, value } = await reader.read()
    buffered += decoder.decode(value, { stream: !done })
    const lines = buffered.split('\n')
    buffered = done ? '' : lines.pop() ?? ''
    for (const line of lines) consume(line)
    if (done) break
  }
  return items
}

function createNativeReplay() {
  const turns: NativeReplay[] = []
  let capture = Promise.resolve()
  const fetchWithCapture = (baseFetch: typeof fetch): typeof fetch => async (input, init) => {
    const response = await baseFetch(input, init)
    capture = streamItems(response.clone()).then((items) => {
      const nativeItems = items.filter((item) => item.type === 'web_search_call' || item.type === 'x_search_call')
      const callIds = new Set(items.flatMap((item) => {
        if (item.type !== 'function_call') return []
        const callId = responseId(item.call_id)
        return callId ? [callId] : []
      }))
      if (nativeItems.length && callIds.size) turns.push({ callIds, items: nativeItems })
    }).catch(() => undefined)
    return response
  }
  const addTo = async (request: JsonObject): Promise<JsonObject> => {
    await capture
    const input = [...(JsonArraySchema.safeParse(request.input).data ?? [])]
    const presentIds = new Set(input.flatMap((item) => {
      const id = responseId(jsonObject(item)?.id)
      return id ? [id] : []
    }))
    for (const turn of turns) {
      const callIndex = input.findIndex((item) => {
        const record = jsonObject(item)
        const callId = responseId(record?.call_id)
        return record?.type === 'function_call'
          && callId !== undefined
          && turn.callIds.has(callId)
      })
      if (callIndex < 0) continue
      const missing = turn.items.filter((item) => {
        const id = responseId(item.id)
        return id === undefined || !presentIds.has(id)
      })
      input.splice(callIndex, 0, ...missing)
      for (const item of missing) {
        const id = responseId(item.id)
        if (id) presentIds.add(id)
      }
    }
    return { ...request, input }
  }
  return { addTo, fetchWithCapture }
}

const responsesApiSeam = defineSeam(() => ({ stream: streamOpenAIResponses }))

export type ResponsesApi = SeamValue<typeof responsesApiSeam>

const responsesApi = responsesApiSeam.current

function withNativeSearch(request: JsonObject) {
  const localTools = JsonArraySchema.safeParse(request.tools).data ?? []
  return { ...request, tools: [...localTools, ...grokNativeSearchTools()] }
}

export const setResponsesApi = responsesApiSeam.set

export const resetResponsesApi = responsesApiSeam.reset

export function createPiRuntime(
  apiKey: string,
  gatewayToken: string,
  gatewayBaseUrl: string,
  runId: string,
): PiRuntime {
  const model = { ...GROK_MODEL, baseUrl: gatewayBaseUrl }
  const nativeReplay = createNativeReplay()
  return {
    model,
    stream: (model, context, options) => responsesApi().stream(
      // SAFETY: the runtime only ever streams GROK_MODEL, the single model this factory returns.
      model as typeof GROK_MODEL,
      context,
      {
        ...options,
        apiKey,
        headers: {
          ...options?.headers,
          ...aiGatewayHeaders(gatewayToken, { app: 'spice', feature: 'dan-agent', run_id: runId }),
        },
        fetch: nativeReplay.fetchWithCapture(options?.fetch ?? fetch),
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        sessionId: runId,
        onPayload: async (payload, targetModel) => {
          const callerPayload = await options?.onPayload?.(payload, targetModel) ?? payload
          const request = JsonObjectSchema.safeParse(callerPayload).data
          if (!request) throw new Error('Pi produced an invalid Responses payload.')
          return withNativeSearch(await nativeReplay.addTo(request))
        },
      },
    ),
  }
}
