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
