import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { TooltipProvider } from '#/components/ui/tooltip'
import { bootRecoveryScript } from '../boot-recovery'
import { PUBLIC_SNAPSHOT_URL } from '../deployment'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        name: 'theme-color',
        content: '#0d0e13',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
      {
        title: 'Heston',
      },
      {
        name: 'description',
        content: 'Public options intelligence and market research with owner-gated order placement.',
      },
    ],
    links: [
      // Starts the public boot read alongside the bundle. `syncFromCloud` only reuses this
      // preload while both sides stay a plain CORS fetch, so keep `crossOrigin` here and
      // request headers off the public read there.
      {
        rel: 'preload',
        href: PUBLIC_SNAPSHOT_URL,
        as: 'fetch',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/manifest.webmanifest',
      },
      {
        rel: 'icon',
        href: '/heston-mark.svg',
      },
      {
        rel: 'apple-touch-icon',
        href: '/heston-mark-180.png',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: bootRecoveryScript() }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <BootSignal />
        <LegacyServiceWorkerRetirement />

        <Scripts />
      </body>
    </html>
  )
}

const LEGACY_HESTON_CACHE_PREFIX = 'heston-public-shell-'

async function clearLegacyHestonCaches(): Promise<void> {
  if (!('caches' in globalThis)) return
  const names = await caches.keys()
  await Promise.all(names
    .filter((name) => name.startsWith(LEGACY_HESTON_CACHE_PREFIX))
    .map((name) => caches.delete(name)))
}

async function retireLegacyServiceWorker(): Promise<void> {
  // The worker clears caches on activation now, which is the path that survives a document
  // its own code cannot load. This covers the other case: caches orphaned by a worker that
  // is already gone, where no activation will ever come.
  await clearLegacyHestonCaches()
  const registration = await navigator.serviceWorker.getRegistration('/')
  if (registration) {
    // Registering the same URL updates the installed offline-shell worker to the
    // recovery-only worker, which clears its caches and unregisters itself.
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  }
}

declare global {
  /** Installed by the inline recovery guard in the document head, before any module runs. */
  var __hestonBooted: (() => void) | undefined
}

/** Rendering at all is the proof the entry module ran; the recovery guard needs nothing more. */
function BootSignal() {
  useEffect(() => {
    globalThis.__hestonBooted?.()
  }, [])
  return null
}

function LegacyServiceWorkerRetirement() {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    void retireLegacyServiceWorker().catch((cause: unknown) => {
      console.error('LegacyServiceWorkerRetirementFailed', cause)
      setFailed(true)
    })
  }, [])
  return failed ? (
    <aside className="service-worker-error" role="alert">
      Heston could not clear an obsolete offline copy. Clear this site's browser data, then reload.
    </aside>
  ) : null
}
