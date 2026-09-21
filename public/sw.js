// The recovery worker. Its whole job is to retire an obsolete offline shell: a worker that
// serves a cached document pins a browser to a build whose hashed assets no longer exist, and
// every one of them 404s into a blank page — so no page code of ours can run to undo it.
//
// The cleanup lives here rather than in the page for exactly that reason: this script is
// fetched fresh on the update check even when the document it would control is unreadable.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

// The only caches this app ever created. Named here rather than deleting everything on the
// origin, so a cache some later feature owns is not collateral to retiring an old shell.
//
// This is the retired `spice` brand's prefix on purpose: it names caches a browser already
// holds, which no later rename can change. Tracking the brand would point the cleanup at the
// current app's own caches and leave the ones it exists to delete untouched.
const LEGACY_CACHE_PREFIX = 'spice-public-shell-'

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Unregistering alone leaves the shell it served sitting in storage. Nothing survives this
    // activation to own those caches, and the page code that used to clear them cannot run on
    // the documents that need it most.
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith(LEGACY_CACHE_PREFIX))
      .map((name) => caches.delete(name)))
    await self.registration.unregister()
  })())
})
