import { createFileRoute } from '@tanstack/react-router'

import { WatchView } from '../components/spice-app'
import { pageTitle } from '../domain/site'

export const Route = createFileRoute('/_app/watch')({
  component: WatchView,
  head: () => ({ meta: [{ title: pageTitle('Watch') }] }),
})
