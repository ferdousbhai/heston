/**
 * An error whose message this repository wrote for whoever made the call. It reaches every
 * caller who can reach the throwing path -- through an MCP tool result that is any member's
 * agent, not only the owner -- so its message is this repository's own vocabulary and never
 * carries a value from a provider payload, a frame, or a secret.
 */
export class CallerVisibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CallerVisibleError'
  }
}
