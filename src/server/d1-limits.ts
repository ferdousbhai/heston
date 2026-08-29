/**
 * D1 accepts at most 100 bound parameters in one query. Keep the platform number
 * in one place so every multi-row statement derives its batch size from its own
 * column count instead of carrying an unexplained hand-tuned row cap.
 */
export const D1_MAX_BOUND_PARAMETERS = 100

export function rowsPerD1Statement(boundParametersPerRow: number): number {
  if (!Number.isSafeInteger(boundParametersPerRow)
    || boundParametersPerRow < 1
    || boundParametersPerRow > D1_MAX_BOUND_PARAMETERS) {
    throw new Error('D1 bound-parameter count must fit one statement')
  }
  return Math.floor(D1_MAX_BOUND_PARAMETERS / boundParametersPerRow)
}
