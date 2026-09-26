import { SPICE_DEPLOYMENT_ID } from '../deployment'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../domain/deployment'

export const DEPLOYMENT_RELOAD_STORAGE_KEY = 'spice.deployment-reload.v1'

export class DeploymentMismatchError extends Error {
  /**
   * `hydrated` says whether the reader is looking at data despite the newer build. Only an
   * unreadable payload leaves the screen empty, and only that is worth telling them about.
   */
  constructor(readonly receivedDeploymentId: string, readonly hydrated = false) {
    super(`A newer spicy.trade deployment is available (${receivedDeploymentId})`)
    this.name = 'DeploymentMismatchError'
  }
}

type ReloadStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

/**
 * The id of a newer deployment, when the response came from one. It reports rather than
 * refuses: a deployment id is a proxy for compatibility, and the schema parse is the real
 * check. Treating the proxy as the verdict turned every deploy into a coin flip for every open
 * tab, and threw away payloads this bundle could read perfectly well.
 */
export function newerResponseDeployment(
  response: Pick<Response, 'headers'>,
  deploymentId = SPICE_DEPLOYMENT_ID,
): string | undefined {
  const receivedDeploymentId = response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)
  if (!receivedDeploymentId || receivedDeploymentId === deploymentId) return undefined
  return receivedDeploymentId
}

export function clearDeploymentReload(storage?: ReloadStorage): void {
  try {
    const reloadStorage = storage ?? globalThis.sessionStorage
    reloadStorage.removeItem(DEPLOYMENT_RELOAD_STORAGE_KEY)
  } catch {
    // A matching response is already success; blocked session storage must not undo it.
  }
}

/**
 * How long a failed reload suppresses the next one. A broken intermediary must not spin the
 * page, but iOS restores tabs across app restarts, so session storage there is effectively
 * permanent — a latch that never expired turned one bad deploy into a device that could never
 * load the app again, and the banner's "close and reopen" does not clear it.
 */
export const DEPLOYMENT_RELOAD_COOLDOWN_MS = 10 * 60 * 1_000

export function reloadForDeployment(
  storage?: ReloadStorage,
  reload: () => void = () => globalThis.location.reload(),
  now: number = Date.now(),
): boolean {
  try {
    const reloadStorage = storage ?? globalThis.sessionStorage
    const attemptedAt = Number(reloadStorage.getItem(DEPLOYMENT_RELOAD_STORAGE_KEY))
    if (Number.isFinite(attemptedAt) && attemptedAt > 0 && now - attemptedAt < DEPLOYMENT_RELOAD_COOLDOWN_MS) {
      return false
    }
    reloadStorage.setItem(DEPLOYMENT_RELOAD_STORAGE_KEY, String(now))
    reload()
    return true
  } catch {
    return false
  }
}
