/** The one identity a cited page has here: what a citation is bound by and a re-read is keyed on. */
export function citedPageKey(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  if (url.port !== '' && url.port !== '443') return undefined
  // A published source is never a literal address, and that shape is what turns a reading
  // tool into a probe of somewhere it was never meant to reach.
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return undefined
  url.hash = ''
  for (const key of Array.from(url.searchParams.keys())) {
    if (key.toLowerCase().startsWith('utm_') || ['fbclid', 'gclid'].includes(key.toLowerCase())) {
      url.searchParams.delete(key)
    }
  }
  return url.toString()
}
