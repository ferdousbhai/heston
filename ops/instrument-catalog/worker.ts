import { type AppEnv } from '../../src/server/env'
import {
  previewInternalInstrumentCatalogFromTastytrade,
  refreshInternalInstrumentCatalogFromTastytrade,
} from '../../src/server/tastytrade'
import { authorizedOpsRequest } from '../shared/worker-auth'

export { BrokerGate } from '../../src/server/broker-gate'

type OpsEnv = AppEnv & { OPS_AUTH_TOKEN?: string }

export default {
  async fetch(request: Request, env: OpsEnv): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST'
      || !['/preview', '/apply'].includes(path)
      || !await authorizedOpsRequest(request, env.OPS_AUTH_TOKEN)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const result = path === '/preview'
        ? await previewInternalInstrumentCatalogFromTastytrade(env)
        : await refreshInternalInstrumentCatalogFromTastytrade(env)
      return Response.json({ mode: path.slice(1), result })
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'InstrumentCatalog:operation-failed'
      return Response.json({ error }, { status: 500 })
    }
  },
}

