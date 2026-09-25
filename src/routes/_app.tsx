import { createFileRoute } from '@tanstack/react-router'

import { SpiceApp } from '../components/spice-app'

/**
 * The application shell: a pathless layout over Watch, Recommendations and Connect. It owns the
 * market, favorites, viewer and live-feed state, so moving between the views swaps only the
 * outlet and never remounts or refetches what they share.
 *
 * TanStack DB's browser-backed collections intentionally make this app shell client-rendered;
 * API routes and scheduled Workers remain server-rendered. The views inherit that from here.
 */
export const Route = createFileRoute('/_app')({ ssr: false, component: SpiceApp })
