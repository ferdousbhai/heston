const CACHE_PREFIX = 'spice-public-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v1`
const PUBLIC_SHELL_KEY = '/__spice-public-offline-shell__'
const MAX_INSTALL_ASSETS = 200
const PUBLIC_ASSETS = [
  { url: '/manifest.webmanifest' },
  { url: '/spice-mark.svg' },
  { url: '/spice-mark-180.png' },
  { url: '/spice-mark-192.png' },
  { url: '/spice-mark-512.png' },
]

// Workbox replaces this expression when injectManifest runs. The current
// TanStack Start integration still copies this source worker without that pass.
const buildAssets = self.__WB_MANIFEST || []

function publicShellRequest() {
  return new Request(new URL(PUBLIC_SHELL_KEY, self.location.origin))
}

function staticAssetUrl(value) {
  const candidate = value?.url
  if (!candidate) return undefined
  const url = new URL(candidate, self.location.origin)
  if (url.origin !== self.location.origin) return undefined
  if (url.pathname.startsWith('/assets/')
    || PUBLIC_ASSETS.some((asset) => asset.url === url.pathname)) return url.href
  return undefined
}

function shellAssetUrls(html) {
  const urls = []
  const attributes = /(?:src|href)=["']([^"'#]+)["']/g
  for (const match of html.matchAll(attributes)) {
    const url = staticAssetUrl({ url: match[1] })
    if (url) urls.push({ url })
  }
  return urls
}

function dependencyAssetUrls(source, baseUrl) {
  const urls = []
  const references = /["'`(]((?:\/?assets\/|\.\.?\/)[A-Za-z0-9_.-]+\.(?:css|js|png|svg|webmanifest|woff2))[?"'`)]/g
  for (const match of source.matchAll(references)) {
    const reference = match[1].startsWith('assets/') ? `/${match[1]}` : match[1]
    const url = staticAssetUrl({ url: new URL(reference, baseUrl).href })
    if (url) urls.push({ url })
  }
  return urls
}

async function cacheStaticAsset(cache, value) {
  const url = staticAssetUrl(value)
  if (!url) return []
  const request = new Request(url, { credentials: 'omit' })
  const response = await fetch(request)
  if (!response.ok || response.type === 'opaque') return []
  const contentType = response.headers.get('content-type') || ''
  const dependencies = contentType.includes('javascript') || contentType.includes('css')
    ? dependencyAssetUrls(await response.clone().text(), url)
    : []
  await cache.put(request, response)
  return dependencies
}

async function cacheStaticAssets(cache, initialAssets) {
  const queue = [...initialAssets]
  const seen = new Set()
  while (queue.length && seen.size < MAX_INSTALL_ASSETS) {
    const batch = []
    while (queue.length && batch.length < 8 && seen.size < MAX_INSTALL_ASSETS) {
      const asset = queue.shift()
      const url = staticAssetUrl(asset)
      if (!url || seen.has(url)) continue
      seen.add(url)
      batch.push({ url })
    }
    const results = await Promise.allSettled(batch.map((asset) => cacheStaticAsset(cache, asset)))
    for (const result of results) {
      if (result.status === 'fulfilled') queue.push(...result.value)
    }
  }
}

async function installPublicShell() {
  const cache = await caches.open(CACHE_NAME)
  const shellRequest = new Request(new URL('/', self.location.origin), {
    cache: 'reload',
    credentials: 'omit',
  })
  const shellResponse = await fetch(shellRequest).catch(() => undefined)
  let discoveredAssets = []

  if (shellResponse?.ok && shellResponse.type !== 'opaque') {
    const html = await shellResponse.text()
    discoveredAssets = shellAssetUrls(html)
    const headers = new Headers(shellResponse.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.delete('set-cookie')
    headers.delete('set-cookie2')
    headers.delete('vary')
    await cache.put(publicShellRequest(), new Response(html, {
      headers,
      status: shellResponse.status,
      statusText: shellResponse.statusText,
    }))
  }

  await cacheStaticAssets(cache, [...PUBLIC_ASSETS, ...buildAssets, ...discoveredAssets])
}

async function cachedStaticAsset(request) {
  const cache = await caches.open(CACHE_NAME)
  const publicRequest = new Request(request.url, { credentials: 'omit' })
  const cached = await cache.match(publicRequest)
  if (cached) return cached
  const response = await fetch(publicRequest)
  if (response.ok && response.type !== 'opaque') await cache.put(publicRequest, response.clone())
  return response
}

async function networkNavigation(request) {
  try {
    // An authenticated navigation may contain owner-rendered state. It is returned
    // directly and never written to Cache Storage; offline fallback is the shell
    // fetched without cookies during service-worker installation.
    return await fetch(request)
  } catch (error) {
    const fallback = await (await caches.open(CACHE_NAME)).match(publicShellRequest())
    if (fallback) return fallback
    throw error
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installPublicShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))),
    self.clients.claim(),
  ]))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // API, agent, and stream traffic is owner-sensitive and must always bypass the
  // service-worker cache, including when the browser is offline.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agents/')) return
  if (request.mode === 'navigate') {
    event.respondWith(networkNavigation(request))
    return
  }
  if (staticAssetUrl({ url: url.href })) event.respondWith(cachedStaticAsset(request))
})
