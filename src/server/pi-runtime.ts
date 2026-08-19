import { type Model, type StreamFunction } from '@earendil-works/pi-ai'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'

const XAI_MODEL: Model<'openai-responses'> = {
  ...XAI_MODELS['grok-4.5'],
  id: 'grok-4.6',
  name: 'Grok 4.6',
}

export type PiRuntime = {
  model: Model<'openai-responses'>
  stream: StreamFunction
}

/**
 * The one call this codebase makes into the Pi Responses adapter. Production goes
 * through `responsesApi()` so a test can install a recording stand-in with
 * `setResponsesApi` instead of replacing the library module; the entry is the library
 * function itself, so the contract cannot drift from it.
 */
function createResponsesApi() {
  return { stream: streamOpenAIResponses }
}

export type ResponsesApi = ReturnType<typeof createResponsesApi>

let installedResponsesApi: ResponsesApi = createResponsesApi()

/** The Responses transport currently in force. */
export function responsesApi(): ResponsesApi {
  return installedResponsesApi
}

/** Install a stand-in transport for a test; pair every call with `resetResponsesApi()`. */
export function setResponsesApi(next: ResponsesApi): void {
  installedResponsesApi = next
}

/** Restore the live Pi Responses transport. */
export function resetResponsesApi(): void {
  installedResponsesApi = createResponsesApi()
}

export function createPiRuntime(apiKey: string): PiRuntime {
  return {
    model: XAI_MODEL,
    stream: (model, context, options) => responsesApi().stream(
      // SAFETY: the runtime only ever streams XAI_MODEL, the single model this factory returns.
      model as typeof XAI_MODEL,
      context,
      {
        ...options,
        apiKey,
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        timeoutMs: 360_000,
      },
    ),
  }
}
