import { describe, expect, it } from 'vitest'

import { hasStoragePurge, STORAGE_PURGE_COOKIE } from '../src/domain/storage-purge'

describe('storage purge receipt', () => {
  it('reads the receipt among other cookies, whatever the spacing', () => {
    expect(hasStoragePurge(`a=1;${STORAGE_PURGE_COOKIE}=1 ; b=2`)).toBe(true)
    expect(hasStoragePurge(`better-auth.session=x; ${STORAGE_PURGE_COOKIE}=1`)).toBe(true)
  })

  it('accepts only the current generation, and never a lookalike', () => {
    expect(hasStoragePurge(null)).toBe(false)
    expect(hasStoragePurge('')).toBe(false)
    expect(hasStoragePurge(`${STORAGE_PURGE_COOKIE}=0`)).toBe(false)
    expect(hasStoragePurge(`${STORAGE_PURGE_COOKIE}`)).toBe(false)
    expect(hasStoragePurge(`x${STORAGE_PURGE_COOKIE}=1`)).toBe(false)
    expect(hasStoragePurge(`${STORAGE_PURGE_COOKIE}=1`, '2')).toBe(false)
  })
})
