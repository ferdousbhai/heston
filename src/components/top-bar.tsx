import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { useLiveFeedIndicator } from '../data/live-market'
import { type MarketState } from '../domain/market'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip'
import { GoogleSignInButton } from './auth-gate'

// Fine enough that "just now" becomes "1 min ago" while a reader is still looking at it.
const ELAPSED_TICK_MS = 15_000

/**
 * How old the data on screen is, in the terms a reader thinks in. This replaced a banner that
 * alarmed on every reconnect: what a reader needs is the age of what they are reading, not an
 * interruption each time a socket drops and heals itself.
 */
export function elapsedLabel(at: string, now: number): string | undefined {
  const updated = Date.parse(at)
  if (!Number.isFinite(updated)) return undefined
  // A provider clock a little ahead of the browser's must not read as the future.
  const seconds = Math.max(0, Math.round((now - updated) / 1_000))
  if (seconds < 45) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The same age at table-cell width: "3m", "5h", "2d". Under a minute reads as "now", since a
 * cell has no room to say "just" and a reader glancing at a column wants one glyph per row.
 */
export function compactElapsedLabel(at: string, now: number): string | undefined {
  const updated = Date.parse(at)
  if (!Number.isFinite(updated)) return undefined
  const seconds = Math.max(0, Math.round((now - updated) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Elapsed time only stays true if it keeps counting, so the clock is read on a timer and held
 * in state. Rendering may not read it directly, so a label can trail the real instant by up to
 * one tick — immaterial at the minute granularity a reader is being told about.
 */
function useTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export function useElapsedLabel(at: string | undefined): string | undefined {
  const now = useTick(Boolean(at))
  return at ? elapsedLabel(at, now) : undefined
}

/**
 * The session as a traffic light: green open, yellow waiting, red closed. What the color
 * means, the New York clock, and the wait to the next bell live on hover — the bar itself
 * has no room for that sentence.
 */
export type MarketStatus = { detail: string; tone: 'open' | 'waiting' | 'closed' }

const SESSION_NAMES = {
  after: 'After hours',
  closed: 'Closed',
  open: 'Open',
  pre: 'Pre-market',
  unknown: 'Closed',
} satisfies Record<MarketState, string>

export function marketClockLabel(now: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
    weekday: 'short',
  }).format(new Date(now))
}

function waitLabel(target: number, now: number): string | undefined {
  const minutes = Math.ceil((target - now) / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const rest = hours % 24
    return rest ? `${days}d ${rest}h` : `${days}d`
  }
  if (hours) return remainder ? `${hours}h ${remainder}m` : `${hours}h`
  return `${remainder}m`
}

export function marketStatusLabel(
  state: MarketState,
  opensAt: string | undefined,
  now: number,
  closesAt?: string,
): MarketStatus {
  const name = SESSION_NAMES[state]
  const tone = state === 'open' ? 'open' : state === 'pre' ? 'waiting' : 'closed'
  const lines = [name, marketClockLabel(now)]
  if (state === 'open') {
    const wait = closesAt ? waitLabel(Date.parse(closesAt), now) : undefined
    if (wait) lines.push(`Closes in ${wait}`)
  } else {
    const wait = opensAt ? waitLabel(Date.parse(opensAt), now) : undefined
    if (wait) lines.push(`Opens in ${wait}`)
  }
  return { detail: lines.join('\n'), tone }
}

export type LiveFeedSourceCopy = {
  label: 'Live' | 'Snapshot'
  title: string
}

export function liveFeedSourceLabel(source: 'live' | 'snapshot'): LiveFeedSourceCopy {
  if (source === 'live') {
    return { label: 'Live', title: 'Live quotes from the dxLink feed' }
  }
  return { label: 'Snapshot', title: 'Last stored print; live feed is off' }
}

export function TopBar({
  lastUpdatedAt,
  marketClosesAt,
  marketOpensAt,
  marketState,
  viewerName,
}: {
  lastUpdatedAt?: string
  marketClosesAt?: string
  marketOpensAt?: string
  marketState?: MarketState
  viewerName?: string
}) {
  // One clock for both readings, on one timer. It also keeps ticking while another tab is
  // open — the age used to stop with it, and resumed from the instant the reader left, so a
  // return to the market showed forty-minute-old quotes as "Updated just now".
  const now = useTick(Boolean(lastUpdatedAt) || Boolean(marketState))
  const updated = lastUpdatedAt ? elapsedLabel(lastUpdatedAt, now) : undefined
  const source = useLiveFeedIndicator()
  const feed = liveFeedSourceLabel(source)
  const status = marketState
    ? marketStatusLabel(marketState, marketOpensAt, now, marketClosesAt)
    : undefined
  return (
    <header className="top-bar">
      <Link aria-label="Spice home" className="brand" to="/">
        <span>SPICE</span>
      </Link>
      <div className="top-actions">
        {status && (
          <>
            <Tooltip>
              <TooltipTrigger
                aria-label={status.detail.replaceAll('\n', '. ')}
                className="market-status"
                data-tone={status.tone}
                type="button"
              />
              <TooltipContent className="market-status-tip" side="bottom">
                {status.detail}
              </TooltipContent>
            </Tooltip>
            <span
              className="quote-source"
              data-live={source === 'live' ? 'true' : undefined}
              title={feed.title}
            >
              {feed.label}
            </span>
          </>
        )}
        {/* The age matters while quotes move. Outside the session the bar counts down instead,
            and each reading's own age is stated on the card that shows it. */}
        {updated && marketState === 'open' && (
          <span className="last-updated" title={`Quotes last updated ${lastUpdatedAt}`}>
            <span className="last-updated-word">Updated </span>{updated}
          </span>
        )}
        <Button nativeButton={false} render={<Link className="top-link" to="/support" />} size="sm" variant="link">Support</Button>
        {viewerName && (
          <Avatar aria-label={`Signed in as ${viewerName}`} className="viewer-avatar" title={viewerName}>
            <AvatarFallback>{viewerName.trim().charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        )}
        {!viewerName && <GoogleSignInButton compact />}
      </div>
    </header>
  )
}
