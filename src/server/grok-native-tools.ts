export type GrokNativeSearchTool =
  | { type: 'web_search' }
  | { from_date?: string; to_date?: string; type: 'x_search' }

export function grokNativeXSearchTool(
  xDateRange: { fromDate: string; toDate: string } | undefined = undefined,
): Extract<GrokNativeSearchTool, { type: 'x_search' }> {
  if (!xDateRange) return { type: 'x_search' }
  return {
    from_date: xDateRange.fromDate,
    to_date: xDateRange.toDate,
    type: 'x_search',
  }
}

export function grokNativeSearchTools(
  xDateRange: { fromDate: string; toDate: string } | undefined = undefined,
): GrokNativeSearchTool[] {
  return [{ type: 'web_search' }, grokNativeXSearchTool(xDateRange)]
}
