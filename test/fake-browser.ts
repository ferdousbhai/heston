function unsupported(): never {
  throw new Error('UnsupportedBrowserRunCall')
}

/**
 * A Browser Run binding whose only working call is the markdown quick action that the
 * research `read_page` tool makes. Every other call throws, so a code path reaching for
 * more than that fails loudly instead of reading a silent stub.
 */
export function markdownBrowser(markdown: string): BrowserRun {
  return {
    fetch: unsupported,
    quickAction: async () => Response.json({ result: markdown, success: true }),
  }
}
