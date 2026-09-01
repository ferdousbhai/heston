import { SPICE_DEPLOYMENT_ID } from '../deployment'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../domain/deployment'

export const DEPLOYMENT_RELOAD_STORAGE_KEY = 'spice.deployment-reload.v1'

export class DeploymentMismatchError extends Error {
  constructor(readonly receivedDeploymentId: string) {
    super(`A newer Spice deployment is available (${receivedDeploymentId})`)
    this.name = 'DeploymentMismatchError'
  }
}

export class DeploymentMetadataUnavailableError extends Error {
  constructor() {
    super('The Spice deployment identifier is missing')
    this.name = 'DeploymentMetadataUnavailableError'
  }
}

type ReloadStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

export function validateResponseDeployment(
  response: Pick<Response, 'headers'>,
  deploymentId = SPICE_DEPLOYMENT_ID,
  metadataRequired = import.meta.env.PROD,
): void {
  const receivedDeploymentId = response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)
  if (!receivedDeploymentId) {
    // Production must prove that the response and running bundle belong to the same
    // deployment. Dev permits headerless route fixtures and local proxy responses.
    if (metadataRequired) throw new DeploymentMetadataUnavailableError()
    return
  }
  if (receivedDeploymentId !== deploymentId) throw new DeploymentMismatchError(receivedDeploymentId)
}

export function clearDeploymentReload(storage?: ReloadStorage): void {
  try {
    const reloadStorage = storage ?? globalThis.sessionStorage
    reloadStorage.removeItem(DEPLOYMENT_RELOAD_STORAGE_KEY)
  } catch {
    // A matching response is already success; blocked session storage must not undo it.
  }
}

export function reloadForDeployment(
  deploymentId: string,
  storage?: ReloadStorage,
  reload: () => void = () => globalThis.location.reload(),
): boolean {
  try {
    // A broken intermediary can keep returning mismatched responses. Remember one
    // attempt until a current response succeeds, then end in a warning instead of a loop.
    const reloadStorage = storage ?? globalThis.sessionStorage
    if (reloadStorage.getItem(DEPLOYMENT_RELOAD_STORAGE_KEY)) return false
    reloadStorage.setItem(DEPLOYMENT_RELOAD_STORAGE_KEY, deploymentId)
    reload()
    return true
  } catch {
    return false
  }
}
