import { describe, expect, it, vi } from 'vitest'

import {
  DEPLOYMENT_RELOAD_COOLDOWN_MS,
  DEPLOYMENT_RELOAD_STORAGE_KEY,
  clearDeploymentReload,
  newerResponseDeployment,
  reloadForDeployment,
} from '../src/data/deployment'
import { deploymentScopedPath, HESTON_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

describe('deployment-aware snapshot recovery', () => {
  it('scopes a snapshot URL without dropping an existing query', () => {
    expect(deploymentScopedPath('/api/public-snapshot?source=reader', 'build 2'))
      .toBe('/api/public-snapshot?source=reader&app=build+2')
  })

  it('reports a newer deployment rather than refusing the response', () => {
    const current = new Response(null, { headers: { [HESTON_DEPLOYMENT_ID_HEADER]: 'current' } })
    expect(newerResponseDeployment(current, 'current')).toBeUndefined()

    const newer = new Response(null, { headers: { [HESTON_DEPLOYMENT_ID_HEADER]: 'newer' } })
    expect(newerResponseDeployment(newer, 'current')).toBe('newer')

    // A response without the header says nothing about compatibility, and blocking on its
    // absence took the app down for anything that stripped the header.
    expect(newerResponseDeployment(new Response(), 'current')).toBeUndefined()
  })

  it('retries a declined reload once the cooldown passes', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const start = Date.parse('2026-09-01T12:00:00.000Z')

    expect(reloadForDeployment(storage, reload, start)).toBe(true)
    expect(reloadForDeployment(storage, reload, start + 1_000)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)

    // iOS restores tabs, so session storage there outlives the "close and reopen" advice. A
    // latch that never expired left such a device unable to load the app again at all.
    expect(reloadForDeployment(storage, reload, start + DEPLOYMENT_RELOAD_COOLDOWN_MS + 1)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)

    clearDeploymentReload(storage)
    expect(storage.values.has(DEPLOYMENT_RELOAD_STORAGE_KEY)).toBe(false)
  })

  it('fails closed when session storage is blocked', () => {
    const blockedStorage = {
      getItem: () => { throw new DOMException('Storage is blocked', 'SecurityError') },
      removeItem: () => { throw new DOMException('Storage is blocked', 'SecurityError') },
      setItem: () => { throw new DOMException('Storage is blocked', 'SecurityError') },
    }
    const reload = vi.fn()

    expect(reloadForDeployment(blockedStorage, reload)).toBe(false)
    expect(() => clearDeploymentReload(blockedStorage)).not.toThrow()
    expect(reload).not.toHaveBeenCalled()
  })
})
