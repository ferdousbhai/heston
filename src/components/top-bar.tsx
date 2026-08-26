import { Link } from '@tanstack/react-router'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import { GoogleSignInButton } from './auth-gate'

export function TopBar({
  viewerName,
}: {
  viewerName?: string
}) {
  return (
    <header className="top-bar">
      <Link aria-label="Spice Must Flow home" className="brand" to="/">
        <span>SPICE</span>
        <small>MUST FLOW</small>
      </Link>
      <div className="top-actions">
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
