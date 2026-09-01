import { describe, expect, it } from 'vitest'

import { localStorageOrMemory } from '../src/data/browser-storage'

class BlockedStorageHost {
  get localStorage(): Storage {
    throw new DOMException('Storage is blocked', 'SecurityError')
  }
}

describe('browser collection storage', () => {
  it('falls back to memory when the browser blocks local storage access', () => {
    const storage = localStorageOrMemory(new BlockedStorageHost())

    storage.setItem('snapshot', 'saved')

    expect(storage.getItem('snapshot')).toBe('saved')
    expect(storage.key(0)).toBe('snapshot')
    expect(storage.length).toBe(1)
  })
})
