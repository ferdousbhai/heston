import { z } from 'zod'

import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import { citedPageKey } from './research-url'

export type RetainedPage = { markdown: string; readAt: string }

/**
 * One call may read at most this many public pages. A member recording catalysts cites a page
 * per event and records a handful of events, so this is comfortably above any honest call and
 * well inside what one browser session can open before the caller's turn times out.
 */
export const MAX_RESEARCH_PAGE_READS = 30

/*
 * A citation is worth what this Worker can show was read. Native web search happens inside
 * the provider, so a page it opened leaves nothing here to bind a claim to; a page read
 * through this function leaves its text behind, and the binder afterwards refuses any citation
 * or quote absent from it.
 *
 * Markdown is capped so one page cannot exhaust the isolate on its own.
 */
const MAX_PAGE_MARKDOWN_CHARS = 120_000
const MAX_PAGE_RESPONSE_BYTES = 4_000_000

/**
 * One page read through the Worker's browser, used wherever a model-authored citation is
 * checked against text this Worker fetched itself.
 * A browser timeout, session limit, or oversized body all return undefined: the caller's
 * contract is "cite something else", never a run-ending error.
 */
export async function readResearchPageMarkdown(
  browser: NonNullable<AppEnv['BROWSER']>,
  key: string,
): Promise<string | undefined> {
  try {
    const response = await browser.quickAction('markdown', { url: key })
    if (!response.ok) return undefined
    const payload = await readBoundedJson(response, MAX_PAGE_RESPONSE_BYTES, 'ResearchReadPage')
    const parsed = z.object({ result: z.string(), success: z.literal(true) }).safeParse(payload).data
    return parsed?.result.slice(0, MAX_PAGE_MARKDOWN_CHARS)
  } catch {
    return undefined
  }
}

export interface RetainedCitedPages {
  rejected: string[]
  /** Empty whenever anything was rejected: no binder may run on a partial set of reads. */
  retained: Map<string, RetainedPage>
}

/**
 * Read every page a set of citations points at, once each, and retain its text for the binders.
 *
 * Every surface that admits model-authored citations faces the same sequence in the same order:
 * canonicalize the cited addresses, refuse before spending a browser budget the citations would
 * overrun, then read each distinct page and refuse if one did not open. One definition, so no
 * surface can quietly hold a citation to a weaker rule than another.
 *
 * Indices are not deduplicated: a bad address cited twice is named once per citation, which is
 * what an agent fixes. Distinct pages are, because a page that will not open is one fact about
 * that page however many citations lean on it.
 */
export async function retainCitedPages(
  browser: NonNullable<AppEnv['BROWSER']>,
  sources: readonly { sourceUrl: string }[],
  citedIndices: Iterable<number>,
  readAt: string,
): Promise<RetainedCitedPages> {
  const rejected: string[] = []
  const pageKeys = new Set<string>()
  for (const index of citedIndices) {
    const sourceUrl = sources[index]?.sourceUrl
    // An index past the end of sources has no page to read; the binders reject the citation.
    if (sourceUrl === undefined) continue
    const key = citedPageKey(sourceUrl)
    if (key === undefined) rejected.push(`source ${index}: not a readable https page address`)
    else pageKeys.add(key)
  }
  if (pageKeys.size > MAX_RESEARCH_PAGE_READS) {
    return {
      rejected: [`cites ${pageKeys.size} pages; at most ${MAX_RESEARCH_PAGE_READS} are read in one call`],
      retained: new Map(),
    }
  }
  if (rejected.length) return { rejected, retained: new Map() }

  const retained = new Map<string, RetainedPage>()
  for (const key of pageKeys) {
    const markdown = await readResearchPageMarkdown(browser, key)
    if (markdown === undefined) rejected.push(`page did not open: ${key}`)
    else retained.set(key, { markdown, readAt })
  }
  if (rejected.length) return { rejected, retained: new Map() }
  return { rejected, retained }
}
