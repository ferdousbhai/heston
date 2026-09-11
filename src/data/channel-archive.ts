import { ChannelArchivePageSchema, type ChannelArchivePage } from '../domain/channel-post'

export async function loadChannelArchivePage(before?: number, signal?: AbortSignal): Promise<ChannelArchivePage> {
  const query = before === undefined ? '' : `?${new URLSearchParams({ before: String(before) })}`
  const response = await fetch(`/api/public-channel-archive${query}`, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`Channel archive request failed (${response.status})`)
  return ChannelArchivePageSchema.parse(await response.json())
}
