import { type Model, type StreamFunction } from '@earendil-works/pi-ai'
import { stream as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'

const XAI_MODEL: Model<'openai-responses'> = {
  ...XAI_MODELS['grok-4.5'],
  id: 'grok-4.6',
  name: 'Grok 4.6',
}

export function createPiRuntime(apiKey: string): {
  model: Model<'openai-responses'>
  stream: StreamFunction
} {
  return {
    model: XAI_MODEL,
    stream: (model, context, options) => streamOpenAIResponses(
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
