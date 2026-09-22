import { z } from 'zod'

/** One rule for every page address model output may cite, stated once. */
export const HttpsSourceUrlSchema = z.string().url()
  .refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL')

/**
 * The envelope a cited source arrives in, wherever it is cited: a page address and the page's
 * own title. Every surface that admits a citation -- a recorded catalyst, an evidence card, a
 * brief's reading list -- holds it to these, so a page one may cite is a page the others may
 * cite. The address bound is a rendering and storage envelope, not a URL-spec limit; the title
 * is held to one line at the card's measure.
 */
export const MAX_CITED_SOURCE_URL_LENGTH = 2_000
export const MAX_CITED_SOURCE_TITLE_LENGTH = 180
