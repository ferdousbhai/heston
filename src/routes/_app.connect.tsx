import { createFileRoute } from '@tanstack/react-router'

import { ConnectView } from '../components/spice-app'
import { pageTitle } from '../domain/site'

export const Route = createFileRoute('/_app/connect')({
  component: ConnectView,
  head: () => ({ meta: [{ title: pageTitle('Connect') }] }),
})
