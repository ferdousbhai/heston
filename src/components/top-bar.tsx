import { Link } from '@tanstack/react-router'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import { GoogleSignInButton } from './auth-gate'

/**
 * How old the data on screen is, stated plainly. This replaced a banner that alarmed on every
 * reconnect: a reader needs to know the age of what they are reading, not to be interrupted
 * each time a socket drops and heals itself.
 */
function lastUpdatedLabel(at: string): string | undefined {
  const updated = new Date(at)
  if (!Number.isFinite(updated.getTime())) return undefined
  return updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function TopBar({
  lastUpdatedAt,
  viewerName,
}: {
  lastUpdatedAt?: string
  viewerName?: string
}) {
  const updated = lastUpdatedAt ? lastUpdatedLabel(lastUpdatedAt) : undefined
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
