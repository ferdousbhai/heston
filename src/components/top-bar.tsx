import { RefreshCw, WifiOff } from 'lucide-react'

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error'

export function TopBar({
  onSignOut,
  onSync,
  phase,
  viewerName,
}: {
  onSignOut?: () => void
  onSync: () => void
  phase: SyncPhase
  viewerName?: string
}) {
  const offline = phase === 'offline'
  const syncLabel = offline
    ? 'Offline — retry sync'
    : phase === 'syncing' ? 'Syncing market data'
      : phase === 'error' ? 'Sync failed — retry'
        : 'Refresh market data'
  return (
    <header className="top-bar">
      <div aria-label="Spice Must Flow" className="brand">
        <span>SPICE</span>
        <small>MUST FLOW</small>
      </div>
      <div className="top-actions">
        <button aria-label={syncLabel} className={`sync-button ${phase}`} onClick={onSync} title={syncLabel} type="button">
          {offline ? <WifiOff size={13} /> : <RefreshCw className={phase === 'syncing' ? 'spin' : ''} size={13} />}
        </button>
        {viewerName && onSignOut && (
          <button aria-label={`Sign out ${viewerName}`} className="viewer-button" onClick={onSignOut} title="Sign out" type="button">
            {viewerName.trim().charAt(0).toUpperCase()}
          </button>
        )}
      </div>
    </header>
  )
}
