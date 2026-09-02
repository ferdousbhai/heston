import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { BOOT_RECOVERY_STORAGE_KEY, bootRecoveryScript } from '../src/boot-recovery'

const DELAY_MS = 10_000
const COOLDOWN_MS = 600_000

type Harness = ReturnType<typeof loadDocument>

/** The globals the inline guard touches on the page, as the guard sees them. */
type RecoveryWindow = {
  __spiceBooted?: () => void
  caches: { delete: (name: string) => Promise<boolean>; keys: () => Promise<string[]> }
}

function loadDocument(options: { blockedStorage?: boolean; stored?: Map<string, string> } = {}) {
  const stored = options.stored ?? new Map<string, string>()
  const clock = { now: 1_700_000_000_000 }
  let scheduled: { delay: number; fire: () => void } | undefined
  const registration = { unregister: vi.fn(async (): Promise<boolean> => true) }
  const cacheStorage = {
    delete: vi.fn(async (_name: string): Promise<boolean> => true),
    keys: vi.fn(async (): Promise<string[]> => ['spice-public-shell-v2']),
  }
  const reload = vi.fn()
  const blocked = () => { throw new Error('SecurityError') }
  const sessionStorage = options.blockedStorage
    ? { getItem: blocked, removeItem: blocked, setItem: blocked }
    : {
        getItem: (key: string) => stored.get(key) ?? null,
        removeItem: (key: string) => { stored.delete(key) },
        setItem: (key: string, value: string) => { stored.set(key, value) },
      }
  const window: RecoveryWindow = { caches: cacheStorage }
  const context = {
    Date: { now: () => clock.now },
    Infinity,
    Number,
    Promise,
    String,
    caches: cacheStorage,
    clearTimeout: () => { scheduled = undefined },
    location: { reload },
    navigator: { serviceWorker: { getRegistrations: async () => [registration] } },
    sessionStorage,
    setTimeout: (fire: () => void, delay: number) => { scheduled = { delay, fire }; return 1 },
    window,
  }
  runInNewContext(bootRecoveryScript(DELAY_MS, COOLDOWN_MS), context)
  return {
    booted: () => {
      if (!window.__spiceBooted) throw new Error('BootSignalNotInstalled')
      window.__spiceBooted()
    },
    cacheStorage,
    clock,
    async elapse(): Promise<void> {
      if (!scheduled) throw new Error('BootRecoveryNotScheduled')
      expect(scheduled.delay).toBe(DELAY_MS)
      scheduled.fire()
      // The cleanup chains two promise layers before the reload; let both settle.
      await new Promise((resolve) => setImmediate(resolve))
    },
    registration,
    reload,
    scheduled: () => scheduled !== undefined,
    stored,
  }
}

describe('boot recovery guard', () => {
  it('drops workers and caches and reloads once when nothing hydrates in time', async () => {
    const page = loadDocument()

    await page.elapse()

    expect(page.registration.unregister).toHaveBeenCalledOnce()
    expect(page.cacheStorage.delete).toHaveBeenCalledWith('spice-public-shell-v2')
    expect(page.reload).toHaveBeenCalledOnce()
    expect(page.stored.get(BOOT_RECOVERY_STORAGE_KEY)).toBe(String(page.clock.now))
  })

  it('stands down and forgets the attempt once the app reports hydration', () => {
    const stored = new Map([[BOOT_RECOVERY_STORAGE_KEY, '1']])
    const page = loadDocument({ stored })

    page.booted()

    expect(page.scheduled()).toBe(false)
    expect(stored.has(BOOT_RECOVERY_STORAGE_KEY)).toBe(false)
  })

  it('does not reload again inside the cooldown, so a broken deploy cannot loop', async () => {
    const first = loadDocument()
    await first.elapse()
    const second: Harness = loadDocument({ stored: first.stored })
    second.clock.now = first.clock.now + COOLDOWN_MS - 1

    await second.elapse()

    expect(second.reload).not.toHaveBeenCalled()
    expect(second.registration.unregister).not.toHaveBeenCalled()
  })

  it('tries again after the cooldown, because iOS keeps session storage across restarts', async () => {
    const first = loadDocument()
    await first.elapse()
    const later = loadDocument({ stored: first.stored })
    later.clock.now = first.clock.now + COOLDOWN_MS

    await later.elapse()

    expect(later.reload).toHaveBeenCalledOnce()
    expect(later.stored.get(BOOT_RECOVERY_STORAGE_KEY)).toBe(String(later.clock.now))
  })

  it('never reloads when storage cannot record the attempt', async () => {
    const page = loadDocument({ blockedStorage: true })

    await page.elapse()

    expect(page.reload).not.toHaveBeenCalled()
  })
})
