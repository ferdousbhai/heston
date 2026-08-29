const SPICE_CACHE_PREFIX = 'spice-public-shell-'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(SPICE_CACHE_PREFIX))
      .map((name) => caches.delete(name)))
    await self.clients.claim()
    await self.registration.unregister()
  })())
})
