import { describe, expect, it, vi } from 'vitest'

import {
  DEPLOYMENT_RELOAD_STORAGE_KEY,
  DeploymentMetadataUnavailableError,
  DeploymentMismatchError,
  clearDeploymentReload,
  reloadForDeployment,
  validateResponseDeployment,
} from '../src/data/deployment'
import { deploymentScopedPath, SPICE_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'

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

  it('accepts the current deployment and identifies a different one', () => {
    const current = new Response(null, { headers: { [SPICE_DEPLOYMENT_ID_HEADER]: 'current' } })
    expect(() => validateResponseDeployment(current, 'current', true)).not.toThrow()

    const newer = new Response(null, { headers: { [SPICE_DEPLOYMENT_ID_HEADER]: 'newer' } })
    expect(() => validateResponseDeployment(newer, 'current', true))
      .toThrow(new DeploymentMismatchError('newer'))
  })

  it('requires deployment metadata in production', () => {
    expect(() => validateResponseDeployment(new Response(), 'current', true))
      .toThrow(DeploymentMetadataUnavailableError)
    expect(() => validateResponseDeployment(new Response(), 'current', false)).not.toThrow()
  })

  it('reloads at most once until the current deployment succeeds', () => {
    const storage = memoryStorage()
    const reload = vi.fn()

    expect(reloadForDeployment('newer', storage, reload)).toBe(true)
    expect(reloadForDeployment('newer', storage, reload)).toBe(false)
    expect(reloadForDeployment('newest', storage, reload)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.values.get(DEPLOYMENT_RELOAD_STORAGE_KEY)).toBe('newer')

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

    expect(reloadForDeployment('newer', blockedStorage, reload)).toBe(false)
    expect(() => clearDeploymentReload(blockedStorage)).not.toThrow()
    expect(reload).not.toHaveBeenCalled()
  })
})
