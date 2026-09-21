import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { BOOT_RECOVERY_COOKIE, bootRecoveryScript } from '../src/boot-recovery'
import { STORAGE_PURGE_COOKIE } from '../src/domain/storage-purge'

const DELAY_MS = 10_000
const COOLDOWN_MS = 600_000
const CLEANUP_TIMEOUT_MS = 3_000

/** The globals the inline guard touches on the page, as the guard sees them. */
type RecoveryWindow = {
  __hestonBooted?: () => void
  caches: { delete: (name: string) => Promise<boolean>; keys: () => Promise<string[]> }
}

/** `document.cookie` as a browser implements it: one assignment edits one cookie. */
function cookieDocument(jar: Map<string, string>) {
  return {
    get cookie(): string {
      return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    },
    set cookie(assignment: string) {
      const [pair, ...attributes] = assignment.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator).trim()
      const maxAge = attributes
        .map((attribute) => attribute.trim().toLowerCase())
        .find((attribute) => attribute.startsWith('max-age='))
      if (maxAge && Number(maxAge.slice('max-age='.length)) <= 0) {
        jar.delete(name)
        return
      }
      jar.set(name, pair.slice(separator + 1).trim())
    },
  }
}

function loadDocument(options: { blockedCookies?: boolean; hungWorkerApis?: boolean; cookies?: Map<string, string> } = {}) {
  const jar = options.cookies ?? new Map([[STORAGE_PURGE_COOKIE, '1']])
  const clock = { now: 1_700_000_000_000 }
  const timers = new Map<number, { delay: number; fire: () => void }>()
  let nextTimer = 1
  const blocked = () => { throw new Error('SecurityError') }
  const document = options.blockedCookies
    ? { get cookie(): string { return blocked() }, set cookie(_assignment: string) { blocked() } }
    : cookieDocument(jar)
  const registration = { unregister: vi.fn(async (): Promise<boolean> => true) }
  const cacheStorage = {
    delete: vi.fn(async (_name: string): Promise<boolean> => true),
    keys: vi.fn(async (): Promise<string[]> => ['heston-public-shell-v2']),
  }
  const reload = vi.fn()
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
    location: { protocol: 'https:', reload },
    navigator: { serviceWorker: { getRegistrations: () => options.hungWorkerApis ? new Promise<never>(() => undefined) : Promise.resolve([registration]) } },
    setTimeout: (fire: () => void, delay: number) => { const id = nextTimer++; timers.set(id, { delay, fire }); return id },
    window,
  }
  runInNewContext(bootRecoveryScript(DELAY_MS, COOLDOWN_MS, CLEANUP_TIMEOUT_MS), context)
  return {
    booted: () => {
      if (!window.__hestonBooted) throw new Error('BootSignalNotInstalled')
      window.__hestonBooted()
    },
    cacheStorage,
    clock,
    cookies: jar,
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
  }
}

describe('boot recovery guard', () => {
  it('drops workers and caches and reloads once when nothing hydrates in time', async () => {
    const page = loadDocument()

    await page.elapse(DELAY_MS)

    expect(page.registration.unregister).toHaveBeenCalledOnce()
    expect(page.cacheStorage.delete).toHaveBeenCalledWith('heston-public-shell-v2')
    expect(page.reload).toHaveBeenCalledOnce()
    expect(page.cookies.get(BOOT_RECOVERY_COOKIE)).toBe(String(page.clock.now))
    // The reloaded document must arrive without the purge receipt, so the server purges again.
    expect(page.cookies.has(STORAGE_PURGE_COOKIE)).toBe(false)
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
    expect(page.cookies.has(STORAGE_PURGE_COOKIE)).toBe(false)
  })

  it('stands down and forgets the attempt once the app reports hydration', () => {
    const cookies = new Map([[BOOT_RECOVERY_COOKIE, '1']])
    const page = loadDocument({ cookies })

    page.booted()

    expect(page.scheduled()).toBe(false)
    expect(cookies.has(BOOT_RECOVERY_COOKIE)).toBe(false)
  })

  it('does not reload again inside the cooldown, so a broken deploy cannot loop', async () => {
    const first = loadDocument()
    await first.elapse(DELAY_MS)
    // The reload the guard just asked for purges storage on the way back, which is why the
    // latch is a cookie: only what the purge spares survives into the document that reads it.
    const second = loadDocument({ cookies: first.cookies })
    second.clock.now = first.clock.now + COOLDOWN_MS - 1

    await second.elapse(DELAY_MS)

    expect(second.reload).not.toHaveBeenCalled()
    expect(second.registration.unregister).not.toHaveBeenCalled()
  })

  it('tries again after the cooldown, because iOS keeps tabs across restarts', async () => {
    const first = loadDocument()
    await first.elapse(DELAY_MS)
    const later = loadDocument({ cookies: first.cookies })
    later.clock.now = first.clock.now + COOLDOWN_MS

    await later.elapse(DELAY_MS)

    expect(later.reload).toHaveBeenCalledOnce()
    expect(later.cookies.get(BOOT_RECOVERY_COOKIE)).toBe(String(later.clock.now))
  })

  it('never reloads when the attempt cannot be recorded', async () => {
    const page = loadDocument({ blockedCookies: true })

    await page.elapse(DELAY_MS)

    expect(page.reload).not.toHaveBeenCalled()
  })
})
