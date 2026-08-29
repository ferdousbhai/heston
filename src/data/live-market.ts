import { useEffect, useState } from 'react'
import { z } from 'zod'

import { type JsonValue } from '../domain/json-payload'
import { applyLiveMarketEvent } from './collections'
import { MarketFeedStatusSchema } from '../server/market-feed-contracts'

/** The relay delivers text frames; binary frames are not part of the market protocol. */
const RelayFrameSchema = z.string()
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_MAX_EXPONENT = 5

export type LiveMarketState = {
  detail?: string
  state: 'connecting' | 'degraded' | 'disabled' | 'live' | 'reconnecting'
}

export function useLiveMarket(symbols: readonly string[], enabled: boolean): LiveMarketState {
  const key = [...new Set(symbols)].sort().join(',')
  const [status, setStatus] = useState<LiveMarketState>({ state: 'disabled' })

  useEffect(() => {
    if (!enabled || !key) {
      return
    }
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let attempts = 0

    const connect = () => {
      if (stopped) return
      setStatus({ state: attempts ? 'reconnecting' : 'connecting' })
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = new URL('/api/stream', `${protocol}//${window.location.host}`)
      url.searchParams.set('symbols', key)
      socket = new WebSocket(url)
      socket.addEventListener('message', (event) => {
        try {
          const frame = RelayFrameSchema.parse(event.data)
          const payload: JsonValue = JSON.parse(frame)
          const status = MarketFeedStatusSchema.safeParse(payload)
          if (status.success) {
            if (status.data.state === 'live') attempts = 0
            setStatus({ detail: status.data.detail, state: status.data.state })
            return
          }
          applyLiveMarketEvent(payload)
        } catch {
          setStatus({ detail: 'The live feed returned an invalid frame.', state: 'degraded' })
        }
      })
      socket.addEventListener('close', () => {
        if (stopped) return
        // Cap browser reconnect backoff so a recovered live feed resumes without user action.
        const delay = Math.min(
          RECONNECT_MAX_DELAY_MS,
          RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempts++, RECONNECT_MAX_EXPONENT),
        )
        setStatus({ detail: 'The live feed disconnected.', state: 'reconnecting' })
        reconnectTimer = setTimeout(connect, delay)
      })
      socket.addEventListener('error', () => {
        if (!stopped) setStatus({ detail: 'The live feed connection failed.', state: 'degraded' })
      })
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close(1000, 'Subscription changed')
    }
  }, [enabled, key])
  return enabled && key ? status : { state: 'disabled' }
}
