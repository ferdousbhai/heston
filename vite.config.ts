import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { VitePWA } from 'vite-plugin-pwa'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),

    tanstackStart(),
    viteReact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['spice-mark.svg', 'spice-mark-180.png'],
      manifest: {
        name: 'Spice Must Flow — Options intelligence',
        short_name: 'Spice Must Flow',
        description: 'Private options intelligence, market research, and confirmation-gated order placement.',
        theme_color: '#08090c',
        background_color: '#08090c',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/spice-mark-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/spice-mark-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
})

export default config
