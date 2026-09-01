import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

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
 * Elapsed time only stays true if it keeps counting, so the clock is read on a timer and held
 * in state. Rendering may not read it directly, so a label can trail the real instant by up to
 * one tick — immaterial at the minute granularity a reader is being told about.
 */
function useElapsedLabel(at: string | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!at) return
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [at])
  return at ? elapsedLabel(at, now) : undefined
}

export function TopBar({
  lastUpdatedAt,
  viewerName,
}: {
  lastUpdatedAt?: string
  viewerName?: string
}) {
  const updated = useElapsedLabel(lastUpdatedAt)
  return (
    <header className="top-bar">
      <Link aria-label="Spice home" className="brand" to="/">
        <span>SPICE</span>
      </Link>
      <div className="top-actions">
        {updated && (
          <span className="last-updated" title={`Market data last updated ${lastUpdatedAt}`}>
            Updated {updated}
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
