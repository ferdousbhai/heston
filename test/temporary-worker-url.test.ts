import { describe, expect, it } from 'vitest'

import { extractTemporaryWorkerUrl } from '../ops/shared/temporary-worker-url.mjs'

describe('temporary Worker URL extraction', () => {
  it('selects the workers.dev route for the exact uniquely named Worker', () => {
    const output = `
      Dashboard: https://dash.cloudflare.com/account/workers/services/view/other
      Deployed spice-catalog-20260829T120000Z-a1b2c3d4
      https://spice-catalog-20260829T120000Z-a1b2c3d4.owner.workers.dev
    `
    expect(extractTemporaryWorkerUrl(output, 'spice-catalog-20260829T120000Z-a1b2c3d4')).toBe(
      'https://spice-catalog-20260829t120000z-a1b2c3d4.owner.workers.dev',
    )
  })

  it('rejects a route belonging to another deployment', () => {
    expect(() => extractTemporaryWorkerUrl(
      'https://spice-catalog-old.owner.workers.dev',
      'spice-catalog-new',
    )).toThrow('Wrangler did not report the workers.dev URL for spice-catalog-new.')
  })
})
