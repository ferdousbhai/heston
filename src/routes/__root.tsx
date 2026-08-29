import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { TooltipProvider } from '#/components/ui/tooltip'
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
        content: '#08090c',
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
        href: '/api/public-snapshot',
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

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <ServiceWorkerRegistration />

        <Scripts />
      </body>
    </html>
  )
}

function ServiceWorkerRegistration() {
  useEffect(() => {
    // The SSR integration does not transform an index.html, so own registration
    // here and keep development sessions free of persistent worker caches.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    void navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      // A deploy may leave the worker source URL unchanged while its shell and
      // hashed assets change. Always revalidate the worker rather than an HTTP copy.
      updateViaCache: 'none',
    }).catch(() => undefined)
  }, [])
  return null
}
