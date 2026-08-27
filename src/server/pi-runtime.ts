import { type Model, type StreamFunction } from '@earendil-works/pi-ai'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'

import { aiGatewayHeaders } from './ai-gateway'
import { defineSeam, type SeamValue } from './seam'

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
const responsesApiSeam = defineSeam(() => ({ stream: streamOpenAIResponses }))

export type ResponsesApi = SeamValue<typeof responsesApiSeam>

/** The Responses transport currently in force. */
const responsesApi = responsesApiSeam.current

/** Install a stand-in transport for a test; pair every call with `resetResponsesApi()`. */
export const setResponsesApi = responsesApiSeam.set

/** Restore the live Pi Responses transport. */
export const resetResponsesApi = responsesApiSeam.reset

export function createPiRuntime(
  apiKey: string,
  gatewayToken: string,
  gatewayBaseUrl: string,
  runId: string,
): PiRuntime {
  const model = { ...XAI_MODEL, baseUrl: gatewayBaseUrl }
  return {
    model,
    stream: (model, context, options) => responsesApi().stream(
      // SAFETY: the runtime only ever streams XAI_MODEL, the single model this factory returns.
      model as typeof XAI_MODEL,
      context,
      {
        ...options,
        apiKey,
        headers: {
          ...options?.headers,
          ...aiGatewayHeaders(gatewayToken, { app: 'spice', feature: 'dan-agent', run_id: runId }),
        },
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        sessionId: runId,
        timeoutMs: 360_000,
      },
    ),
  }
}
