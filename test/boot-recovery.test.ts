import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { BOOT_RECOVERY_STORAGE_KEY, bootRecoveryScript } from '../src/boot-recovery'
import { STORAGE_PURGE_COOKIE } from '../src/domain/storage-purge'

const DELAY_MS = 10_000
const COOLDOWN_MS = 600_000
const CLEANUP_TIMEOUT_MS = 3_000

type Harness = ReturnType<typeof loadDocument>

/** The globals the inline guard touches on the page, as the guard sees them. */
type RecoveryWindow = {
  __spiceBooted?: () => void
  caches: { delete: (name: string) => Promise<boolean>; keys: () => Promise<string[]> }
}

function loadDocument(options: { blockedStorage?: boolean; hungWorkerApis?: boolean; stored?: Map<string, string> } = {}) {
  const stored = options.stored ?? new Map<string, string>()
  const clock = { now: 1_700_000_000_000 }
  const timers = new Map<number, { delay: number; fire: () => void }>()
  let nextTimer = 1
  const document = { cookie: `${STORAGE_PURGE_COOKIE}=1` }
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
    clearTimeout: (id: number) => { timers.delete(id) },
    document,
    location: { reload },
    navigator: { serviceWorker: { getRegistrations: () => options.hungWorkerApis ? new Promise<never>(() => undefined) : Promise.resolve([registration]) } },
    sessionStorage,
    setTimeout: (fire: () => void, delay: number) => { const id = nextTimer++; timers.set(id, { delay, fire }); return id },
    window,
  }
  runInNewContext(bootRecoveryScript(DELAY_MS, COOLDOWN_MS, CLEANUP_TIMEOUT_MS), context)
  return {
    booted: () => {
      if (!window.__spiceBooted) throw new Error('BootSignalNotInstalled')
      window.__spiceBooted()
    },
    cacheStorage,
    clock,
    document,
    /** Fire the one scheduled timer whose delay matches, as the browser would once it passes. */
    async elapse(delay: number): Promise<void> {
      const due = [...timers.entries()].find(([, timer]) => timer.delay === delay)
      if (!due) throw new Error(`BootRecoveryTimerNotScheduled:${delay}`)
      timers.delete(due[0])
      due[1].fire()
      // The cleanup chains two promise layers before the reload; let both settle.
      await new Promise((resolve) => setImmediate(resolve))
    },
    registration,
    reload,
    scheduled: () => timers.size > 0,
    stored,
  }
}

describe('boot recovery guard', () => {
  it('drops workers and caches and reloads once when nothing hydrates in time', async () => {
    const page = loadDocument()

    await page.elapse(DELAY_MS)

    expect(page.registration.unregister).toHaveBeenCalledOnce()
    expect(page.cacheStorage.delete).toHaveBeenCalledWith('spice-public-shell-v2')
    expect(page.reload).toHaveBeenCalledOnce()
    expect(page.stored.get(BOOT_RECOVERY_STORAGE_KEY)).toBe(String(page.clock.now))
    // The reloaded document must arrive without the purge receipt, so the server purges again.
    expect(page.document.cookie).toBe(`${STORAGE_PURGE_COOKIE}=; Max-Age=0; Path=/`)
    // Cleanup finished first, so the bounded wait must not reload a second time.
    await page.elapse(CLEANUP_TIMEOUT_MS)
    expect(page.reload).toHaveBeenCalledOnce()
  })

  it('reloads anyway when the worker APIs never answer, because the reload is the fix', async () => {
    const page = loadDocument({ hungWorkerApis: true })

    await page.elapse(DELAY_MS)
    expect(page.reload).not.toHaveBeenCalled()
    await page.elapse(CLEANUP_TIMEOUT_MS)

    expect(page.reload).toHaveBeenCalledOnce()
    expect(page.document.cookie).toBe(`${STORAGE_PURGE_COOKIE}=; Max-Age=0; Path=/`)
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
    await first.elapse(DELAY_MS)
    const second: Harness = loadDocument({ stored: first.stored })
    second.clock.now = first.clock.now + COOLDOWN_MS - 1

    await second.elapse(DELAY_MS)

    expect(second.reload).not.toHaveBeenCalled()
    expect(second.registration.unregister).not.toHaveBeenCalled()
  })

  it('tries again after the cooldown, because iOS keeps session storage across restarts', async () => {
    const first = loadDocument()
    await first.elapse(DELAY_MS)
    const later = loadDocument({ stored: first.stored })
    later.clock.now = first.clock.now + COOLDOWN_MS

    await later.elapse(DELAY_MS)

    expect(later.reload).toHaveBeenCalledOnce()
    expect(later.stored.get(BOOT_RECOVERY_STORAGE_KEY)).toBe(String(later.clock.now))
  })

  it('never reloads when storage cannot record the attempt', async () => {
    const page = loadDocument({ blockedStorage: true })

    await page.elapse(DELAY_MS)

    expect(page.reload).not.toHaveBeenCalled()
  })
})
