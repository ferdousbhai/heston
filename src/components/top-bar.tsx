import { RefreshCw, WifiOff } from 'lucide-react'

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error'

export function TopBar({
  onSignOut,
  onSync,
  phase,
  source,
  viewerName,
}: {
  onSignOut?: () => void
  onSync: () => void
  phase: SyncPhase
  source: string
  viewerName?: string
}) {
  const offline = phase === 'offline'
  return (
    <header className="top-bar">
      <div aria-label="Spice Must Flow" className="brand">
        <span>SPICE</span>
        <small>MUST FLOW</small>
      </div>
      <div className="top-actions">
        <button className={`sync-pill ${phase}`} onClick={onSync} type="button">
          {offline ? <WifiOff size={13} /> : <RefreshCw className={phase === 'syncing' ? 'spin' : ''} size={13} />}
          <span>{offline ? 'Offline cache' : phase === 'syncing' ? 'Syncing' : source === 'tastytrade' ? 'tastytrade live' : 'Demo market'}</span>
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
