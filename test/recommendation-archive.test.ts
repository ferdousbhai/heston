// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RecommendationScreen } from '../src/components/recommendation-screen'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('recommendation archive navigation', () => {
  it('loads one earlier run and returns to the newer recommendations without refetching', async () => {
    const latest = marketSnapshotFixture().recommendations!
    const previous = {
      ...latest,
      id: 'recommendations-2026-08-12',
      publishedAt: '2026-08-12T13:35:00.000Z',
      regime: 'Earlier selective tape',
    }
    let archiveRequests = 0
    const fetchMock = vi.fn(async () => {
      archiveRequests += 1
      return Response.json({ dailyRecommendations: archiveRequests === 1 ? previous : null })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(createElement(RecommendationScreen, {
      availableSymbols: new Set(['NVDA']),
      dailyRecommendations: latest,
      onSymbol: () => undefined,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByText('Earlier selective tape')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/public-daily-recommendations?before=${encodeURIComponent(latest.publishedAt)}`,
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Selective long vol')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByText('Earlier selective tape')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
