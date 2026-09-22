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

describe('the channel archive on the recommendations tab', () => {
  it('lists the surviving posts newest first and pages older on a tap', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.startsWith('/api/public-channel-archive?before=3100')) {
        return Response.json({ posts: [{ id: 3084, links: ['https://www.bloomberg.com/x'], postedAt: '2026-03-16T13:30:16.000Z', text: 'https://www.bloomberg.com/x' }] })
      }
      return Response.json({
        nextBefore: 3100,
        posts: [{ id: 3548, links: [], postedAt: '2026-09-08T13:42:03.000Z', text: 'PCG · Neutral\nPCG still has a Wednesday liability event.' }],
      })
    }))
    const snapshot = marketSnapshotFixture()

    render(createElement(RecommendationScreen, {
      availableSymbols: new Set(snapshot.tickers.map((ticker) => ticker.symbol)),
      dailyRecommendations: snapshot.recommendations,
      onSymbol: () => undefined,
    }))

    await waitFor(() => expect(screen.getByText(/PCG still has a Wednesday liability event/)).toBeTruthy())
    // The channel's markup never reaches the page: the text is text, and the link is a link.
    fireEvent.click(screen.getByRole('button', { name: 'Older posts' }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'www.bloomberg.com' })).toBeTruthy())
    expect(screen.getByText('That is the whole surviving channel.')).toBeTruthy()
    expect(requests.filter((url) => url.startsWith('/api/public-channel-archive'))).toEqual([
      '/api/public-channel-archive',
      '/api/public-channel-archive?before=3100',
    ])
  })
})
