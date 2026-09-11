import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { type MarketState } from '../domain/market'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
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
 * The session as the provider names it, and how long until the next bell. Outside the open
 * session the wait is what a reader wants from the bar; the age of the data is on the card.
 */
export type MarketStatus = { label: string; tone: 'open' | 'waiting' | 'closed' }

const SESSION_NAMES = {
  after: 'After hours',
  closed: 'Closed',
  open: 'Open',
  pre: 'Pre-market',
  unknown: 'Closed',
} satisfies Record<MarketState, string>

export function marketStatusLabel(
  state: MarketState,
  opensAt: string | undefined,
  now: number,
): MarketStatus {
  const name = SESSION_NAMES[state]
  if (state === 'open') return { label: name, tone: 'open' }
  const tone = state === 'pre' ? 'waiting' : 'closed'
  const opens = opensAt ? Date.parse(opensAt) : Number.NaN
  const minutes = Number.isFinite(opens) ? Math.ceil((opens - now) / 60_000) : Number.NaN
  // A bell already rung, or one the provider never named, leaves nothing honest to count down.
  if (!Number.isFinite(minutes) || minutes <= 0) return { label: name, tone }
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  const wait = hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours ? `${hours}h ${remainder}m` : `${remainder}m`
  return { label: `${name} · opens in ${wait}`, tone }
}

export function TopBar({
  lastUpdatedAt,
  marketOpensAt,
  marketState,
  viewerName,
}: {
  lastUpdatedAt?: string
  marketOpensAt?: string
  marketState?: MarketState
  viewerName?: string
}) {
  const updated = useElapsedLabel(lastUpdatedAt)
  // Shares the elapsed clock's tick, so the countdown advances without a second timer.
  const now = useTick(Boolean(marketState))
  const status = marketState ? marketStatusLabel(marketState, marketOpensAt, now) : undefined
  return (
    <header className="top-bar">
      <Link aria-label="Spice home" className="brand" to="/">
        <span>SPICE</span>
      </Link>
      <div className="top-actions">
        {status && (
          <span className="market-status" data-tone={status.tone}>
            <span aria-hidden="true" /><span>{status.label}</span>
          </span>
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
