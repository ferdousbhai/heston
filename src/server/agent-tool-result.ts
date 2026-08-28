export function textResult<T>(result: T) {
  return { content: [{ text: JSON.stringify(result), type: 'text' as const }], details: result }
}
