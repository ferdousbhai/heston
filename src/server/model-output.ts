import { z } from 'zod'

import { JsonArraySchema, jsonObjectOrEmpty, type JsonValue } from '../domain/json-payload'

/**
 * Return the completed answer from an OpenAI-compatible Responses payload.
 * Agentic providers can emit several progress messages before the final response,
 * so the first output_text is explicitly not authoritative.
 */
export function lastResponsesOutputText(payload: JsonValue): string | undefined {
  let finalText: string | undefined
  const output = JsonArraySchema.safeParse(jsonObjectOrEmpty(payload).output).data ?? []
  for (const item of output.map(jsonObjectOrEmpty)) {
    for (const content of (JsonArraySchema.safeParse(item.content).data ?? []).map(jsonObjectOrEmpty)) {
      const text = z.string().safeParse(content.text).data
      if (content.type === 'output_text' && text !== undefined) finalText = text
    }
  }
  return finalText
}
