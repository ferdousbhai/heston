export const HESTON_DEPLOYMENT_ID_HEADER = 'X-Heston-Deployment-Id'
export const HESTON_DEPLOYMENT_QUERY_PARAMETER = 'app'

export function deploymentScopedPath(path: string, deploymentId: string): string {
  const url = new URL(path, 'https://heston.local')
  url.searchParams.set(HESTON_DEPLOYMENT_QUERY_PARAMETER, deploymentId)
  return `${url.pathname}${url.search}${url.hash}`
}
