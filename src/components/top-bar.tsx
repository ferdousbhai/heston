export function TopBar({
  viewerName,
}: {
  viewerName?: string
}) {
  return (
    <header className="top-bar">
      <div aria-label="Spice Must Flow" className="brand">
        <span>SPICE</span>
        <small>MUST FLOW</small>
      </div>
      <div className="top-actions">
        {viewerName && (
          <span aria-label={`Signed in as ${viewerName}`} className="viewer-avatar" title={viewerName}>
            {viewerName.trim().charAt(0).toUpperCase()}
          </span>
        )}
      </div>
    </header>
  )
}
