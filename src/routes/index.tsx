import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/` was the whole application before its views became routes, so every bookmark, installed
 * shortcut and shared link still points here. It forwards to Watch -- the view `/` always opened
 * on -- carrying the query and fragment untouched, and replaces the history entry so Back does not
 * return to a page that only redirects.
 *
 * Client-side, like the shell it forwards to (see `_app.tsx`): with `ssr: false` the server
 * renders the document and the browser runs this check.
 */
export const Route = createFileRoute('/')({
  ssr: false,
  beforeLoad: ({ location }) => {
    throw redirect({
      hash: location.hash || undefined,
      replace: true,
      search: location.search,
      to: '/watch',
    })
  },
})
