import { useEffect } from 'react'

import { applyLiveMarketEvent } from './collections'
import { MarketFeedStatusSchema } from '../server/market-feed-contracts'

export function useLiveMarket(symbols: readonly string[], enabled: boolean): void {
  const key = [...new Set(symbols)].sort().join(',')

  useEffect(() => {
    if (!enabled || !key) return
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let attempts = 0

    const connect = () => {
      if (stopped) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = new URL('/api/stream', `${protocol}//${window.location.host}`)
      url.searchParams.set('symbols', key)
      socket = new WebSocket(url)
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        try {
          const payload: unknown = JSON.parse(event.data)
          const status = MarketFeedStatusSchema.safeParse(payload)
          if (status.success) {
            if (status.data.state === 'live') attempts = 0
            return
          }
          applyLiveMarketEvent(payload)
        } catch { /* Ignore malformed relay frames. */ }
      })
      socket.addEventListener('close', () => {
        if (stopped) return
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5))
        reconnectTimer = setTimeout(connect, delay)
      })
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close(1000, 'Subscription changed')
    }
  }, [enabled, key])
}
