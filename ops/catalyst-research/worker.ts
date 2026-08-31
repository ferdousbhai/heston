import {
  applyCatalystBootstrapArtifact,
  readCatalystBootstrapInstruments,
  validateCatalystBootstrapArtifact,
} from '../../src/server/catalyst-bootstrap'
import { readBoundedJson } from '../../src/server/bounded-response'
import { type OpsEnv, serveOpsRequest } from '../shared/worker-auth'

// The temporary Worker buffers and validates this untrusted local-run artifact in memory.
const MAX_ARTIFACT_BYTES = 8_000_000
const CATALYST_PATHS = ['/input', '/validate', '/apply']

export default {
  fetch(request: Request, env: OpsEnv): Promise<Response> {
    return serveOpsRequest(request, env, CATALYST_PATHS, 'CatalystBootstrap:operation-failed', async (path) => {
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
        // What the runner fetched and refused before sending. The findings that arrive here
        // are the ones it could prove, so reporting zero would hide the size of the gap.
        rejectedCount: result.rejectedCount,
        researchedSymbolCount: result.researchedSymbolCount,
        runId: result.runId,
      })
    })
  },
}
