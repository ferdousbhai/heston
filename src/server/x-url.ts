import { z } from 'zod'

import { type JsonValue } from '../domain/json-payload'

/** A post ID, unlike the model-supplied handle, is the provider-cited X identity. */
export function canonicalXPostUrl(value: JsonValue): string | undefined {
  const raw = z.string().safeParse(value).data
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return undefined
    const statusId = url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status\/(\d+)$/)?.[1]
    return statusId ? `https://x.com/i/status/${statusId}` : undefined
  } catch {
    return undefined
  }
}
