import { afterEach, expect, it, vi } from 'vitest'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('does not cache malformed catalyst responses as a successful empty calendar', async () => {
  const catalysts = marketSnapshotFixture().catalysts.filter((row) => row.symbol === 'NVDA')
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ catalysts: [{}] }))
    .mockResolvedValueOnce(Response.json({ catalysts }))
  vi.stubGlobal('fetch', fetchMock)
  const { loadPublicCatalysts } = await import('../src/data/public-catalysts')
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual([])
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual(catalysts)
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual(catalysts)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('re-reads a symbol whose rows a search may have moved, rather than answering from the copy', async () => {
  // The cache has no expiry, so a forced search that moves a date would otherwise leave the
  // retired sighting on the runway beside the one it moved to for the rest of the session --
  // the very duplicate the reader pressed the button to resolve.
  const catalysts = marketSnapshotFixture().catalysts.filter((row) => row.symbol === 'NVDA')
  // A fresh Response per call: a body is read once, and this test asks for the same page twice.
  const fetchMock = vi.fn(() => Promise.resolve(Response.json({ catalysts })))
  vi.stubGlobal('fetch', fetchMock)
  const { forgetPublicCatalysts, loadPublicCatalysts } = await import('../src/data/public-catalysts')

  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual(catalysts)
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual(catalysts)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  forgetPublicCatalysts('NVDA')
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual(catalysts)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  // A symbol nobody searched keeps its copy; forgetting one name is not clearing the cache.
  forgetPublicCatalysts('not a symbol')
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual(catalysts)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
