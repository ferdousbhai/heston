import { createFileRoute } from '@tanstack/react-router'

import { ConnectView } from '../components/spice-app'

export const Route = createFileRoute('/_app/connect')({
  component: ConnectView,
  head: () => ({ meta: [{ title: 'Connect | Spice' }] }),
})
