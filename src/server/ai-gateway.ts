import { type AppEnv } from './env'

export const SPICE_AI_GATEWAY = 'spice'

type GatewayMetadata = Record<string, boolean | number | string>

/** Provider-native Gateway headers; payload logging is intentional for owner inspection. */
export function aiGatewayHeaders(token: string, metadata: GatewayMetadata) {
  return {
    'cf-aig-authorization': `Bearer ${token}`,
    'cf-aig-collect-log': 'true',
    'cf-aig-collect-log-payload': 'true',
    'cf-aig-metadata': JSON.stringify(metadata),
    'cf-aig-skip-cache': 'true',
  }
}

/** Resolve the account-specific URL from the binding instead of embedding account IDs. */
export async function grokGatewayBaseUrl(env: AppEnv): Promise<string> {
  if (!env.AI) throw new Error('AiGatewayUnavailable')
  const providerUrl = await env.AI.gateway(SPICE_AI_GATEWAY).getUrl('grok')
  return `${providerUrl.replace(/\/+$/, '')}/v1`
}
