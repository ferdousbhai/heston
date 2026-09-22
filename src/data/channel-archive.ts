import { ChannelArchivePageSchema, type ChannelArchivePage } from '../domain/channel-post'
import { loadPublicJson } from './public-json'

export async function loadChannelArchivePage(before?: number, signal?: AbortSignal): Promise<ChannelArchivePage> {
  const query = before === undefined ? '' : `?${new URLSearchParams({ before: String(before) })}`
  return loadPublicJson(`/api/public-channel-archive${query}`, ChannelArchivePageSchema, signal)
}
