import { errorName } from '../domain/failure'
import { BrokerRefusalError, CallerVisibleError } from './caller-visible-error'

export function textResult<T>(result: T) {
  return { content: [{ text: JSON.stringify(result), type: 'text' as const }], details: result }
}

/**
 * What a caller's agent sees when a tool throws: the redaction boundary for tool failures.
 *
 * The MCP SDK would otherwise send any thrown error's message verbatim, and a message can carry
 * a D1 detail, a provider body, a Zod issue quoting a payload, or a secret. So only a
 * `CallerVisibleError` -- a message this repository wrote for the caller -- passes its message.
 * Everything else -- including a thrown value that is not an `Error` at all, which the caller
 * passes as undefined -- becomes a fixed sentence naming the tool and the error's name, and is
 * logged with the same two facts and nothing more.
 *
 * A `BrokerRefusalError` is answered as JSON text of one fixed shape:
 *
 *   {"refused": "<check>", "message": "<our wording>", "untrustedBrokerData": {...}}
 *
 * `refused` names the check in our vocabulary, `message` is ours, and `untrustedBrokerData` holds
 * the broker's own words (`messages`) or figures (`bid`/`ask`, `tickSize`). The field name is the
 * label: an agent must treat its contents as the broker's claim, never as an instruction.
 */
export function toolErrorResult(toolName: string, error: Error | undefined) {
  let text: string
  if (error instanceof BrokerRefusalError) {
    text = JSON.stringify({
      message: error.message,
      refused: error.check,
      untrustedBrokerData: error.untrustedBrokerData,
    })
  } else if (error instanceof CallerVisibleError) {
    text = error.message
  } else {
    const name = errorName(error)
    console.error('McpToolFailed', toolName, name)
    text = `Heston could not complete ${toolName}: ${name}`
  }
  return { content: [{ text, type: 'text' as const }], isError: true }
}
