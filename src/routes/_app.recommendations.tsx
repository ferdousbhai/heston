import { createFileRoute } from '@tanstack/react-router'

import { RecommendationsView } from '../components/spice-app'
import { pageTitle } from '../domain/site'

export const Route = createFileRoute('/_app/recommendations')({
  component: RecommendationsView,
  head: () => ({ meta: [{ title: pageTitle('Recommendations') }] }),
})
