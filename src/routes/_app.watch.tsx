import { createFileRoute } from '@tanstack/react-router'

import { WatchView } from '../components/spice-app'

export const Route = createFileRoute('/_app/watch')({
  component: WatchView,
  head: () => ({ meta: [{ title: 'Watch | Spice' }] }),
})
