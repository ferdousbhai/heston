/**
 * `throw` can carry any value, so a caught value is the one input this app cannot
 * type in advance. `toError` is the single decoder for that boundary: call it in the
 * `catch` (or rejection handler) that received the value, and pass the decoded
 * `Error | undefined` onward. Nothing downstream should re-inspect a raw throw.
 */
export function toError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}
