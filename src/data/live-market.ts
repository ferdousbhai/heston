import { useEffect } from 'react'
import { z } from 'zod'

import { type JsonValue } from '../domain/json-payload'
import { applyLiveMarketEvent } from './collections'
import { MarketFeedStatusSchema } from '../server/market-feed-contracts'

/** The relay delivers text frames; binary frames are not part of the market protocol. */
const RelayFrameSchema = z.string()
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_MAX_EXPONENT = 5
/**
 * A hidden tab is nobody looking. The relay holds one upstream connection for as long as any
 * client socket exists, so an abandoned overnight tab would stream a market nobody is reading.
 * The grace period keeps a tab switch or a brief alt-tab from cycling the connection.
 */
const HIDDEN_DISCONNECT_MS = 90 * 1_000
/**
 * The relay drops readers that stop announcing themselves, so a crashed or suspended browser
 * cannot hold its upstream connection open. This must stay well inside the relay's own idle
 * timeout, which allows several missed beats before closing.
 */
const HEARTBEAT_MS = 30 * 1_000

/**
 * Opens the subscription and writes what it receives into the market collections. The
 * connection's own transient states are deliberately not rendered: a reconnect is the feed
 * healing itself, and how old the data is — which the bar already states — is what tells a
 * reader whether the feed is working. Holding them in state re-rendered the whole market tree
 * on every status frame to update a value nothing read.
 */
export function useLiveMarket(symbols: readonly string[], enabled: boolean): void {
  const key = [...new Set(symbols)].sort().join(',')

  useEffect(() => {
    if (!enabled || !key) {
      return
    }
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let stopped = false
    let idle = false
    let attempts = 0

    const connect = () => {
      if (stopped || idle) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = new URL('/api/stream', `${protocol}//${window.location.host}`)
      url.searchParams.set('symbols', key)
      socket = new WebSocket(url)
      socket.addEventListener('message', (event) => {
        try {
          const frame = RelayFrameSchema.parse(event.data)
          const payload: JsonValue = JSON.parse(frame)
          // A status frame is not a market event: it only tells the backoff that the upstream
          // feed is live again.
          const status = MarketFeedStatusSchema.safeParse(payload)
          if (status.success) {
            if (status.data.state === 'live') attempts = 0
            return
          }
          applyLiveMarketEvent(payload)
        } catch {
          // A frame this bundle cannot read is dropped; the data on screen keeps its own age.
        }
      })
      socket.addEventListener('open', () => {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' }))
        }, HEARTBEAT_MS)
      })
      socket.addEventListener('close', () => {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = undefined
        if (stopped || idle) return
        // Cap browser reconnect backoff so a recovered live feed resumes without user action.
        const delay = Math.min(
          RECONNECT_MAX_DELAY_MS,
          RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempts++, RECONNECT_MAX_EXPONENT),
        )
        reconnectTimer = setTimeout(connect, delay)
      })
    }

    const goIdle = () => {
      if (idle) return
      idle = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      // Closing the last client socket is what lets the relay drop its upstream connection.
      socket?.close(1000, 'Viewer idle')
      socket = undefined
    }

    const onVisibilityChange = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      if (document.visibilityState === 'hidden') {
        idleTimer = setTimeout(goIdle, HIDDEN_DISCONNECT_MS)
        return
      }
      if (!idle) return
      idle = false
      attempts = 0
      connect()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    if (document.visibilityState === 'hidden') idleTimer = setTimeout(goIdle, HIDDEN_DISCONNECT_MS)
    connect()
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (heartbeat) clearInterval(heartbeat)
      socket?.close(1000, 'Subscription changed')
    }
  }, [enabled, key])
}
