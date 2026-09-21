import { deploymentScopedPath } from './domain/deployment'

export const HESTON_DEPLOYMENT_ID = import.meta.env.VITE_HESTON_DEPLOYMENT_ID
export const PUBLIC_SNAPSHOT_URL = deploymentScopedPath('/api/public-snapshot', HESTON_DEPLOYMENT_ID)
export const OWNER_SNAPSHOT_URL = deploymentScopedPath('/api/snapshot', HESTON_DEPLOYMENT_ID)
