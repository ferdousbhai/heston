import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type TestWorkerEvent = {
  waitUntil: (task: Promise<unknown>) => void
}

function loadWorker(cacheNames: string[] = []) {
  const handlers = new Map<string, (event: TestWorkerEvent) => void>()
  const cacheStorage = {
    delete: vi.fn(async (_name: string): Promise<boolean> => true),
    keys: vi.fn(async (): Promise<string[]> => cacheNames),
  }
  const worker = {
    addEventListener: (
      type: string,
      handler: (event: TestWorkerEvent) => void,
    ) => handlers.set(type, handler),
    clients: { claim: vi.fn(async (): Promise<void> => undefined) },
    registration: { unregister: vi.fn(async (): Promise<boolean> => true) },
    skipWaiting: vi.fn(async (): Promise<void> => undefined),
  }
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    Promise,
    caches: cacheStorage,
    self: worker,
  })
  return { cacheStorage, handlers, worker }
}

async function dispatch(handler: (event: TestWorkerEvent) => void): Promise<void> {
  let task: Promise<unknown> | undefined
  handler({ waitUntil: (value) => { task = value } })
  if (!task) throw new Error('ServiceWorkerMissingWaitUntil')
  await task
}

describe('legacy service-worker retirement', () => {
  it('installs immediately without fetching or precaching application assets', async () => {
    const { cacheStorage, handlers, worker } = loadWorker()

    await dispatch(handlers.get('install')!)

    expect(worker.skipWaiting).toHaveBeenCalledOnce()
    expect(cacheStorage.keys).not.toHaveBeenCalled()
    expect(handlers.has('fetch')).toBe(false)
  })

  it('unregisters itself while the page owns legacy cache clearing', async () => {
    const { cacheStorage, handlers, worker } = loadWorker([
      'spice-public-shell-v1',
      'spice-public-shell-v2',
      'unrelated-browser-cache',
    ])

    await dispatch(handlers.get('activate')!)

    expect(cacheStorage.keys).not.toHaveBeenCalled()
    expect(cacheStorage.delete).not.toHaveBeenCalled()
    expect(worker.clients.claim).not.toHaveBeenCalled()
    expect(worker.registration.unregister).toHaveBeenCalledOnce()
  })
})
