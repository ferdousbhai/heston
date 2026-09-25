// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
} from '@tanstack/react-router'
import { expect, it } from 'vitest'

import { Route as EntryRoute } from '../src/routes/index'

/**
 * `/` only forwards to Watch now. The real tree would pull in every API route, so this mounts the
 * real `/` route under a bare root beside a stand-in `/watch`, which is all the redirect reaches.
 */
function entryRouter(initialEntry: string) {
  const root = createRootRoute()
  // SAFETY: `update` is typed for the generated tree's parent; this bare root has the same shape.
  const entry = EntryRoute.update({ getParentRoute: () => root, id: '/', path: '/' } as never)
  const watch = createRoute({ getParentRoute: () => root, path: '/watch' })
  const history = createMemoryHistory({ initialEntries: [initialEntry] })
  return { history, router: createRouter({ history, routeTree: root.addChildren([entry, watch]) }) }
}

it('forwards the application root to Watch', async () => {
  const { router } = entryRouter('/')
  await router.load()
  expect(router.state.location.pathname).toBe('/watch')
  expect(router.state.location.searchStr).toBe('')
  expect(router.state.location.hash).toBe('')
})

it('keeps the query and fragment a bookmark or link to the root carried', async () => {
  const { router } = entryRouter('/?from=bookmark&page=2#main-content')
  await router.load()
  expect(router.state.location.pathname).toBe('/watch')
  expect(router.state.location.search).toEqual({ from: 'bookmark', page: 2 })
  expect(router.state.location.searchStr).toBe('?from=bookmark&page=2')
  expect(router.state.location.hash).toBe('main-content')
})

it('replaces the root entry, so Back does not return to a page that only redirects', async () => {
  const { history, router } = entryRouter('/')
  await router.load()
  expect(history.length).toBe(1)
  expect(history.location.pathname).toBe('/watch')
})

it('decides in the browser, as the client-rendered shell it forwards to does', () => {
  expect(EntryRoute.options.ssr).toBe(false)
  const beforeLoad = EntryRoute.options.beforeLoad
  if (!beforeLoad) throw new Error('the entry route lost its redirect')
  let thrown: unknown
  try {
    // SAFETY: the redirect reads only `location`; the rest of the context is never touched.
    void beforeLoad({ location: { hash: '', search: {} } } as never)
  } catch (error) {
    thrown = error
  }
  expect(isRedirect(thrown)).toBe(true)
})
