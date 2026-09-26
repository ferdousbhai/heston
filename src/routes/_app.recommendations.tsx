import { createFileRoute } from '@tanstack/react-router'

import { RecommendationsView } from '../components/spice-app'

export const Route = createFileRoute('/_app/recommendations')({
  component: RecommendationsView,
  head: () => ({ meta: [{ title: 'Recommendations | spicy.trade' }] }),
})
