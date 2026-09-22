import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { loadChannelArchivePage } from '../data/channel-archive'
import { type ChannelPost } from '../domain/channel-post'

const issueDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric',
})

/**
 * What survives of the Telegram channel this site replaced. Telegram deleted the channel's
 * messages after a month until March 2026, so the archive begins there and ends with the
 * channel's last post; it is finite and read newest first, a page per tap.
 */
export function ChannelArchiveScreen() {
  const [posts, setPosts] = useState<ChannelPost[]>([])
  const [nextBefore, setNextBefore] = useState<number>()
  const [loading, setLoading] = useState(true)
  // A failed page is held apart from the paging state so it cannot take the control away with
  // it: the cursor is still known, so the next tap is the retry, and a reader who reloads
  // instead would lose every page already fetched.
  const [failed, setFailed] = useState(false)

  const take = (page: Awaited<ReturnType<typeof loadChannelArchivePage>>) => {
    setPosts((current) => [...current, ...page.posts])
    setNextBefore(page.nextBefore)
    setFailed(false)
  }
  // The first page arrives with the section; every later one is a tap away.
  useEffect(() => {
    const controller = new AbortController()
    loadChannelArchivePage(undefined, controller.signal)
      .then((page) => { if (!controller.signal.aborted) take(page) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  const loadOlder = async (before: number) => {
    setLoading(true)
    try {
      take(await loadChannelArchivePage(before))
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section aria-labelledby="channel-archive-title" className="channel-archive">
      <h2 id="channel-archive-title">From the Long Vol channel</h2>
      <p className="channel-archive-note">
        The Telegram channel this site replaced, March to September 2026. Telegram deleted older messages after a month.
      </p>
      <ol className="channel-posts">
        {posts.map((post) => {
          // A post that is only a link is shown as that link; otherwise the links follow the text.
          const bareLink = post.links.length === 1 && post.text === post.links[0]
          return (
            <li className="channel-post" key={post.id}>
              <time dateTime={post.postedAt}>{issueDate.format(new Date(post.postedAt))}</time>
              {bareLink
                ? <a href={post.links[0]} rel="noreferrer" target="_blank">{new URL(post.links[0]!).host}<ArrowUpRight aria-hidden="true" /></a>
                : (
                    <>
                      <p>{post.text}</p>
                      {post.links.length > 0 && (
                        <span className="channel-post-links">
                          {post.links.map((link) => (
                            <a href={link} key={link} rel="noreferrer" target="_blank">{new URL(link).host}<ArrowUpRight aria-hidden="true" /></a>
                          ))}
                        </span>
                      )}
                    </>
                  )}
            </li>
          )
        })}
      </ol>
      {failed && (
        <Alert className="channel-archive-error" variant="destructive">
          <AlertTitle>Channel archive unavailable</AlertTitle>
          <AlertDescription>The channel archive could not be loaded.</AlertDescription>
        </Alert>
      )}
      {loading && <div className="channel-archive-loading" role="status"><Spinner />Loading posts</div>}
      {!loading && nextBefore !== undefined && (
        <Button onClick={() => void loadOlder(nextBefore)} size="sm" type="button" variant="outline">Older posts</Button>
      )}
      {!loading && nextBefore === undefined && posts.length > 0 && (
        <p className="channel-archive-end">That is the whole surviving channel.</p>
      )}
    </section>
  )
}
