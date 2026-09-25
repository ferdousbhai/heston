import { deploymentScopedPath } from './domain/deployment'

export const SPICE_DEPLOYMENT_ID = import.meta.env.VITE_SPICE_DEPLOYMENT_ID
export const PUBLIC_SNAPSHOT_URL = deploymentScopedPath('/api/public-snapshot', SPICE_DEPLOYMENT_ID)
export const OWNER_SNAPSHOT_URL = deploymentScopedPath('/api/snapshot', SPICE_DEPLOYMENT_ID)
