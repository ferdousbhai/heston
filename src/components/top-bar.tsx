import { Link } from '@tanstack/react-router'

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
        <Link className="top-link" to="/support">Support</Link>
        {viewerName && (
          <span aria-label={`Signed in as ${viewerName}`} className="viewer-avatar" title={viewerName}>
            {viewerName.trim().charAt(0).toUpperCase()}
          </span>
        )}
      </div>
    </header>
  )
}
