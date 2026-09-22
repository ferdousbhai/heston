/*
 * A quote is bound to what this Worker actually read. Native web search runs inside the
 * provider, so a page the model reports opening leaves nothing here to check; a page read
 * through the Worker's browser leaves its text, and a quote has to appear in one of those.
 *
 * The check is deterministic: the quote's words must appear in the page's retained text. It
 * never asks a model whether a claim is supported — an earlier attempt did, and a model
 * vouching for a model is the self-check this pipeline learned to distrust.
 *
 * What this bounds is fabrication, not interpretation: a real sentence can still be quoted
 * beside a wrong inference. That residual belongs to the reader, which is why the quote
 * travels with the record rather than being discarded after the check.
 */

/**
 * Markdown renders the same sentence many ways; only its words decide a match. Exported because
 * every surface that binds a quote to a page this Worker read must normalize it identically --
 * a second copy of these replacements is a second, quietly different definition of "verbatim",
 * and a challenge would then fail on punctuation alone and read as the source having changed.
 */
export function normalizedCitationText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Enough of a refused quote for its author to find it again, without reprinting a paragraph of
 * untrusted text back to the agent that sent it. One definition, because every surface that
 * binds a quote refuses it in exactly these words.
 */
const REJECTED_QUOTE_EXCERPT_CHARS = 80

export function quoteAbsentFromSourceReason(quote: string): string {
  return `quote absent from its source: "${quote.slice(0, REJECTED_QUOTE_EXCERPT_CHARS)}"`
}
