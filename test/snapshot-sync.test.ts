import { afterEach, describe, expect, it, vi } from 'vitest'

import { HESTON_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { type JsonValue } from '../src/domain/json-payload'
import { marketSnapshotFixture } from './fixtures/market'

// vitest.config.ts defines the bundle's own deployment id.
const CURRENT_DEPLOYMENT = 'test'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function snapshotResponse(body: JsonValue, headers: Record<string, string>): Response {
  return Response.json(body, { headers: { [HESTON_DEPLOYMENT_ID_HEADER]: CURRENT_DEPLOYMENT, ...headers } })
}

function notModified(deploymentId = CURRENT_DEPLOYMENT): Response {
  return new Response(null, { status: 304, headers: { [HESTON_DEPLOYMENT_ID_HEADER]: deploymentId } })
}

/** A fresh module per test: the recorded ETag is module state and must not leak between cases. */
async function loadSync(responses: Response[]) {
  const sent: (string | null)[] = []
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('If-None-Match'))
    const next = responses.shift()
    if (!next) throw new Error('unexpected snapshot request')
    return next
  })
  vi.stubGlobal('fetch', fetchMock)
  const collections = await import('../src/data/collections')
  return { ...collections, sent }
}

describe('snapshot sync ETag', () => {
  it('records an ETag only once the body it names is stored', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud, sent } = await loadSync([
      snapshotResponse({ unreadable: true }, { ETag: '"malformed"' }),
      snapshotResponse(snapshot, { ETag: '"superseded"' }),
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      notModified(),
    ])

    // A body this bundle cannot parse was never stored, so its ETag must not buy a 304 later.
    await expect(syncFromCloud('owner')).rejects.toThrow()
    // Nor may a response that was superseded before it hydrated.
    const aborted = new AbortController()
    aborted.abort()
    await expect(syncFromCloud('owner', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)

    expect(sent).toEqual([null, null, null, '"stored"'])
  })
})

describe('snapshot sync deployment check', () => {
  it('tells an old bundle about a newer deployment even when the data is unchanged', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud } = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      notModified('next-deployment'),
      notModified(),
    ])
    await syncFromCloud('owner')

    // The ETag names the data, not the build, so a quiet market answers an old tab with 304s
    // indefinitely; the deployment header on that 304 is the only way the tab learns to reload.
    await expect(syncFromCloud('owner')).rejects.toMatchObject({
      hydrated: true,
      name: 'DeploymentMismatchError',
      receivedDeploymentId: 'next-deployment',
    })

    await expect(syncFromCloud('owner')).resolves.toEqual(snapshot)
  })

  it('refuses a 304 for an audience this browser holds no record of', async () => {
    const snapshot = marketSnapshotFixture()
    const { syncFromCloud } = await loadSync([
      snapshotResponse(snapshot, { ETag: '"stored"' }),
      notModified('next-deployment'),
    ])
    await syncFromCloud('owner')
    // With no stored record a 304 has nothing to answer with, whatever the deployment says.
    const { offlineSnapshotCollection } = await import('../src/data/collections')
    await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
    await expect(syncFromCloud('owner')).rejects.toThrow('Snapshot sync failed (304)')
  })
})
