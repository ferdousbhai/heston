export type GrokNativeSearchTool =
  | { type: 'web_search' }
  | { from_date?: string; to_date?: string; type: 'x_search' }

export function grokNativeSearchTools(
  xDateRange: { fromDate: string; toDate: string } | undefined = undefined,
): GrokNativeSearchTool[] {
  const xSearch: GrokNativeSearchTool = { type: 'x_search' }
  if (xDateRange) {
    xSearch.from_date = xDateRange.fromDate
    xSearch.to_date = xDateRange.toDate
  }
  return [{ type: 'web_search' }, xSearch]
}
