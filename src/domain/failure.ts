/**
 * `throw` can carry any value, so a caught value is the one input this app cannot
 * type in advance. `toError` is the single decoder for that boundary: call it in the
 * `catch` (or rejection handler) that received the value, and pass the decoded
 * `Error | undefined` onward. Nothing downstream should re-inspect a raw throw.
 */
export function toError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}

// This repository's error codes are a PascalCase identifier, optionally followed by
// `:`-joined segments of letters, digits, `_`, `.`, or `-` (e.g.
// 'InternalWatchlist:too-many-entries:123', 'TastytradeAuth:401'). A message outside
// that shape is prose meant for a stack trace, not a code a caller should parse, and
// may carry provider or request detail that must not leave the boundary.
const FAILURE_CODE = /^[A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/

/** The error's message when it is one of this repository's codes, and otherwise nothing. */
export function failureCode(error: Error | undefined): string | undefined {
  return error && FAILURE_CODE.test(error.message) ? error.message : undefined
}

/** An error name is echoed only while it is an identifier; anything else is not ours to relay. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]*$/

export function errorName(error: Error | undefined): string {
  return error && ERROR_NAME.test(error.name) ? error.name : 'UnknownError'
}
