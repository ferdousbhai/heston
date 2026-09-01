export const SPICE_DEPLOYMENT_ID_HEADER = 'X-Spice-Deployment-Id'
export const SPICE_DEPLOYMENT_QUERY_PARAMETER = 'app'

export function deploymentScopedPath(path: string, deploymentId: string): string {
  const url = new URL(path, 'https://spice.local')
  url.searchParams.set(SPICE_DEPLOYMENT_QUERY_PARAMETER, deploymentId)
  return `${url.pathname}${url.search}${url.hash}`
}
