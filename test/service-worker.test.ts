import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type TestWorkerEvent = {
  request?: { method: string; mode: string; url: string }
  respondWith?: (response: Promise<Response>) => void
  waitUntil?: (task: Promise<unknown>) => void
}

function loadWorker(fetcher: typeof fetch) {
  const handlers = new Map<string, (event: TestWorkerEvent) => void>()
  const cache = {
    delete: vi.fn(async (_request: Request): Promise<boolean> => true),
    keys: vi.fn(async (): Promise<readonly Request[]> => []),
    match: vi.fn(async (_request: Request): Promise<Response | undefined> => undefined),
    put: vi.fn(async (_request: Request, _response: Response): Promise<void> => undefined),
  }
  const cacheStorage = {
    delete: vi.fn(async (_name: string): Promise<boolean> => true),
    keys: vi.fn(async (): Promise<string[]> => []),
    open: vi.fn(async (_name: string) => cache),
  }
  const worker = {
    __WB_MANIFEST: [],
    addEventListener: (
      type: string,
      handler: (event: TestWorkerEvent) => void,
    ) => handlers.set(type, handler),
    clients: { claim: vi.fn() },
    location: { origin: 'https://tryspice.xyz' },
    skipWaiting: vi.fn(),
  }
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    Headers,
    Promise,
    Request,
    Response,
    Set,
    URL,
    caches: cacheStorage,
    fetch: fetcher,
    self: worker,
  })
  return {
    activate: handlers.get('activate')!,
    cache,
    cacheStorage,
    fetch: handlers.get('fetch')!,
    install: handlers.get('install')!,
    worker,
  }
}

function dispatchFetch(
  handler: (event: TestWorkerEvent) => void,
  request: NonNullable<TestWorkerEvent['request']>,
) {
  let response: Promise<Response> | undefined
  const background: Promise<unknown>[] = []
  handler({
    request,
    respondWith: (value) => { response = value },
    waitUntil: (task) => { background.push(task) },
  })
  return { background, response }
}

function serviceWorkerRequest(input: RequestInfo | URL): Request {
  if (!(input instanceof Request)) throw new Error('The service worker made a non-Request fetch.')
  return input
}

describe('service-worker audience boundary', () => {
  it('installs its offline shell and discovered assets without browser credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const request = serviceWorkerRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/') {
        return new Response('<script src="/assets/index.js"></script>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      if (pathname === '/assets/index.js') {
        return new Response('import("./chunk.js")', {
          headers: { 'content-type': 'text/javascript' },
        })
      }
      return new Response('', { headers: { 'content-type': 'text/javascript' } })
    })
    const worker = loadWorker(fetcher)
    let installed: Promise<unknown> | undefined
    worker.install({ waitUntil: (task) => { installed = task } })
    await installed

    expect(fetcher.mock.calls.length).toBeGreaterThan(2)
    expect(fetcher.mock.calls.every(([request]) => serviceWorkerRequest(request).credentials === 'omit')).toBe(true)
    expect(fetcher.mock.calls.some(([request]) => new URL(serviceWorkerRequest(request).url).pathname === '/assets/chunk.js')).toBe(true)
    expect(worker.cache.put).toHaveBeenCalled()
    expect(worker.worker.skipWaiting).toHaveBeenCalledOnce()
  })

  it.each(['/api/snapshot', '/api/public-snapshot', '/agents/DanAgent/owner'])('never intercepts %s', (path) => {
    const fetcher = vi.fn<typeof fetch>()
    const worker = loadWorker(fetcher)
    const { response } = dispatchFetch(worker.fetch, {
      method: 'GET',
      mode: 'cors',
      url: `https://tryspice.xyz${path}`,
    })
    expect(response).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
    expect(worker.cacheStorage.open).not.toHaveBeenCalled()
  })

  it('deletes the prior public-shell cache when the updated worker activates', async () => {
    const worker = loadWorker(vi.fn<typeof fetch>())
    worker.cacheStorage.keys.mockResolvedValueOnce([
      'spice-public-shell-v1',
      'unrelated-browser-cache',
    ])
    let activated: Promise<unknown> | undefined
    worker.activate({ waitUntil: (task) => { activated = task } })
    await activated

    expect(worker.cacheStorage.delete).toHaveBeenCalledOnce()
    expect(worker.cacheStorage.delete).toHaveBeenCalledWith('spice-public-shell-v1')
    expect(worker.worker.clients.claim).toHaveBeenCalledOnce()
  })

  it('uses the network for static assets and reserves its credentialless cache for offline fallback', async () => {
    const onlineResponse = new Response('current asset')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(onlineResponse)
    const worker = loadWorker(fetcher)
    const request = new Request('https://tryspice.xyz/assets/current.js')
    const { response } = dispatchFetch(worker.fetch, request)

    await expect(response).resolves.toBe(onlineResponse)
    expect(fetcher).toHaveBeenCalledWith(request)
    expect(worker.cacheStorage.open).not.toHaveBeenCalled()

    const offlineResponse = new Response('offline asset')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    worker.cache.match.mockResolvedValueOnce(offlineResponse)
    const offline = dispatchFetch(worker.fetch, request)

    await expect(offline.response).resolves.toBe(offlineResponse)
    expect(worker.cache.match).toHaveBeenCalledWith(expect.objectContaining({
      credentials: 'omit',
      url: request.url,
    }))
  })

  it('does not persist an authenticated navigation response', async () => {
    const ownerPage = new Response('<html>owner context</html>', {
      headers: { 'content-type': 'text/html' },
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input instanceof Request && input.credentials === 'omit') {
        return new Response('<html>public shell</html>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      return ownerPage
    })
    const worker = loadWorker(fetcher)
    const staleAssets = Array.from({ length: 41 }, (_, index) =>
      new Request(`https://tryspice.xyz/assets/old-build-${index}.js`))
    worker.cache.keys.mockResolvedValueOnce(staleAssets)
    const { background, response } = dispatchFetch(worker.fetch, {
      method: 'GET',
      mode: 'navigate',
      url: 'https://tryspice.xyz/',
    })
    expect(response).toBeDefined()
    await expect(response).resolves.toBe(ownerPage)
    await Promise.all(background)
    const cachedBodies = await Promise.all(worker.cache.put.mock.calls.map(async ([, cachedResponse]) => {
      if (!(cachedResponse instanceof Response)) throw new Error('ServiceWorkerCachedInvalidResponse')
      return cachedResponse.clone().text()
    }))
    expect(cachedBodies).toContain('<html>public shell</html>')
    expect(cachedBodies).not.toContain('<html>owner context</html>')
    expect(worker.cache.delete).toHaveBeenCalledOnce()
    expect(staleAssets).toContain(worker.cache.delete.mock.calls[0]?.[0])
  })
})
