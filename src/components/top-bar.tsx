import { RefreshCw, WifiOff } from 'lucide-react'

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error'

export function TopBar({ phase, source, onSync }: { onSync: () => void; phase: SyncPhase; source: string }) {
  const offline = phase === 'offline'
  return (
    <header className="top-bar">
      <div aria-label="Spice Must Flow" className="brand">
        <span>SPICE<i>.</i></span>
        <small>MUST FLOW</small>
      </div>
      <button className={`sync-pill ${phase}`} onClick={onSync} type="button">
        {offline ? <WifiOff size={13} /> : <RefreshCw className={phase === 'syncing' ? 'spin' : ''} size={13} />}
        <span>{offline ? 'Offline cache' : phase === 'syncing' ? 'Syncing' : source === 'tastytrade' ? 'tastytrade live' : 'Demo market'}</span>
      </button>
    </header>
  )
}
