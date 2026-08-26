import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { VitePWA } from 'vite-plugin-pwa'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),

    tanstackStart(),
    viteReact(),
    VitePWA({
      // TanStack Start currently marks its client build as SSR, so vite-plugin-pwa
      // skips generated workers. Keep the privacy-aware worker in `public/` so it
      // is always copied, while injectManifest can add hashed assets once the
      // integration starts invoking its service-worker build.
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sw.js',
      outDir: 'dist/client',
      injectRegister: false,
      includeAssets: ['spice-mark.svg', 'spice-mark-180.png'],
      manifest: {
        name: 'Spice Must Flow — Options intelligence',
        short_name: 'Spice Must Flow',
        description: 'Public options intelligence and market research with owner-gated order placement.',
        theme_color: '#08090c',
        background_color: '#08090c',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/spice-mark-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/spice-mark-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{css,js,png,svg,webmanifest,woff2}'],
      },
    }),
  ],
})

export default config
