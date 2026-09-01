import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { TooltipProvider } from '#/components/ui/tooltip'
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
        title: 'Spice Must Flow',
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
        href: '/spice-mark.svg',
      },
      {
        rel: 'apple-touch-icon',
        href: '/spice-mark-180.png',
      },
    ],
  }),
  shellComponent: RootDocument,
})

/** Long enough that a slow first paint is never mistaken for a build that cannot load. */
const BOOT_RECOVERY_DELAY_MS = 10_000

/**
 * The body is empty until the app hydrates, so anything that stops the entry module from
 * running leaves a blank page and no code of ours to notice. A shell held by an obsolete
 * service worker does exactly that: it names hashed files that no longer exist, every one
 * 404s, and nothing runs.
 *
 * This is deliberately inline, dependency-free, and ES5: it has to survive in a document
 * whose modules never loaded. If nothing has reported hydration by the deadline, it drops
 * the caches and workers that could be pinning the reader to a dead build, and reloads —
 * once, recorded in session storage, so a genuinely broken deploy cannot loop.
 */
const BOOT_RECOVERY_SCRIPT = `(function(){
  var KEY='spice.boot-recovery.v1';
  function stored(){ try { return sessionStorage.getItem(KEY) } catch (error) { return '1' } }
  function remember(){ try { sessionStorage.setItem(KEY, String(Date.now())) } catch (error) {} }
  window.__spiceBooted=function(){ clearTimeout(timer); try { sessionStorage.removeItem(KEY) } catch (error) {} };
  var timer=setTimeout(function(){
    if (stored()) return;
    remember();
    var reload=function(){ location.reload() };
    var work=[];
    if (navigator.serviceWorker) work.push(navigator.serviceWorker.getRegistrations().then(function(all){
      return Promise.all(all.map(function(one){ return one.unregister() }));
    }));
    if (window.caches) work.push(caches.keys().then(function(names){
      return Promise.all(names.map(function(name){ return caches.delete(name) }));
    }));
    Promise.all(work).then(reload, reload);
  }, ${BOOT_RECOVERY_DELAY_MS});
})()`

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: BOOT_RECOVERY_SCRIPT }} />
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

const LEGACY_SPICE_CACHE_PREFIX = 'spice-public-shell-'

async function clearLegacySpiceCaches(): Promise<void> {
  if (!('caches' in globalThis)) return
  const names = await caches.keys()
  await Promise.all(names
    .filter((name) => name.startsWith(LEGACY_SPICE_CACHE_PREFIX))
    .map((name) => caches.delete(name)))
}

async function retireLegacyServiceWorker(): Promise<void> {
  await clearLegacySpiceCaches()
  const registration = await navigator.serviceWorker.getRegistration('/')
  if (registration) {
    // Registering the same URL updates the installed offline-shell worker to the
    // recovery-only worker, which clears its caches and unregisters itself.
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  }
}

declare global {
  /** Installed by the inline recovery guard in the document head, before any module runs. */
  var __spiceBooted: (() => void) | undefined
}

/** Rendering at all is the proof the entry module ran; the recovery guard needs nothing more. */
function BootSignal() {
  useEffect(() => {
    globalThis.__spiceBooted?.()
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
      Spice could not clear an obsolete offline copy. Clear this site's browser data, then reload.
    </aside>
  ) : null
}
