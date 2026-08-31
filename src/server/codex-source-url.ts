const SOCIAL_DOMAINS = ['reddit.com', 'redd.it', 'x.com', 'twitter.com', 't.co'] as const

function isSocialHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return SOCIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export function canonicalCodexSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || isSocialHost(url.hostname)) {
      return undefined
    }
    // A terminal DNS root dot is semantically equivalent but must not create a
    // second evidence identity or bypass exact hostname policy.
    url.hostname = url.hostname.replace(/\.$/, '')
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}
