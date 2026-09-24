import { isCitablePageUrl, MAX_CITED_SOURCE_URL_LENGTH } from '../domain/https-url'

/** The one identity a cited page has here: what a citation is bound by and a re-read is keyed on. */
export function citedPageKey(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (!isCitablePageUrl(url)) return undefined
  url.hash = ''
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.toLowerCase().startsWith('utm_') || ['fbclid', 'gclid'].includes(key.toLowerCase())) {
      url.searchParams.delete(key)
    }
  }
  // Serialization percent-encodes what the parser admitted raw, so an address inside the
  // envelope on the way in can leave several times longer; the key is what gets stored and
  // cited, so the envelope binds the key rather than the input.
  const key = url.toString()
  return key.length <= MAX_CITED_SOURCE_URL_LENGTH ? key : undefined
}
