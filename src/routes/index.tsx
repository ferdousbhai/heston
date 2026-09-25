import { createFileRoute } from '@tanstack/react-router'

import { SpiceApp } from '../components/spice-app'

// TanStack DB's browser-backed collections intentionally make this app shell
// client-rendered; API routes and scheduled Workers remain server-rendered.
export const Route = createFileRoute('/')({ ssr: false, component: SpiceApp })
