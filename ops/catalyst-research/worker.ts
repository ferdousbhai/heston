import { type AppEnv } from '../../src/server/env'
import {
  applyCatalystBootstrapArtifact,
  readCatalystBootstrapInstruments,
  validateCatalystBootstrapArtifact,
} from '../../src/server/catalyst-bootstrap'
import { readBoundedJson } from '../../src/server/bounded-response'
import { authorizedOpsRequest } from '../shared/worker-auth'

const MAX_ARTIFACT_BYTES = 2_000_000
type OpsEnv = AppEnv & { OPS_AUTH_TOKEN?: string }

export default {
  async fetch(request: Request, env: OpsEnv): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST'
      || !['/input', '/validate', '/apply'].includes(path)
      || !await authorizedOpsRequest(request, env.OPS_AUTH_TOKEN)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      if (path === '/input') {
        return Response.json({ instruments: await readCatalystBootstrapInstruments(env) })
      }
      const artifact = await readBoundedJson(
        new Response(request.body, { headers: request.headers }),
        MAX_ARTIFACT_BYTES,
        'CatalystBootstrapArtifact',
      )
      const result = path === '/apply'
        ? await applyCatalystBootstrapArtifact(env, artifact)
        : validateCatalystBootstrapArtifact(artifact, await readCatalystBootstrapInstruments(env))
      return Response.json({
        accepted: result.catalysts,
        acceptedCount: result.catalysts.length,
        rejected: result.rejected,
        rejectedCount: result.rejected.length,
        researchedSymbolCount: result.researchedSymbolCount,
        runId: result.runId,
      })
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'CatalystBootstrap:operation-failed'
      return Response.json({ error }, { status: 500 })
    }
  },
}
