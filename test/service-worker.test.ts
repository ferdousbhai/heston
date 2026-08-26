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
  const cache = { match: vi.fn(), put: vi.fn() }
  const cacheStorage = {
    delete: vi.fn(),
    keys: vi.fn(async () => []),
    open: vi.fn(async () => cache),
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
  handler({ request, respondWith: (value) => { response = value } })
  return response
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
    const response = dispatchFetch(worker.fetch, {
      method: 'GET',
      mode: 'cors',
      url: `https://tryspice.xyz${path}`,
    })
    expect(response).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
    expect(worker.cacheStorage.open).not.toHaveBeenCalled()
  })

  it('does not persist an authenticated navigation response', async () => {
    const ownerPage = new Response('<html>owner context</html>', {
      headers: { 'content-type': 'text/html' },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ownerPage)
    const worker = loadWorker(fetcher)
    const response = dispatchFetch(worker.fetch, {
      method: 'GET',
      mode: 'navigate',
      url: 'https://tryspice.xyz/',
    })
    expect(response).toBeDefined()
    await expect(response).resolves.toBe(ownerPage)
    expect(worker.cache.put).not.toHaveBeenCalled()
  })
})
