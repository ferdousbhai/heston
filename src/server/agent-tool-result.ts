/** The result envelope every Dan tool returns: JSON text for the model, the typed value for the UI. */
export function textResult<T>(result: T) {
  return { content: [{ text: JSON.stringify(result), type: 'text' as const }], details: result }
}
