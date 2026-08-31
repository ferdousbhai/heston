// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BriefScreen } from '../src/components/brief-screen'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('brief archive navigation', () => {
  it('loads one earlier run and returns to the newer brief without refetching', async () => {
    const latest = marketSnapshotFixture().research!
    const previous = {
      ...latest,
      id: 'brief-2026-08-12',
      publishedAt: '2026-08-12T13:35:00.000Z',
      regime: 'Earlier selective tape',
    }
    let archiveRequests = 0
    const fetchMock = vi.fn(async () => {
      archiveRequests += 1
      return Response.json({ brief: archiveRequests === 1 ? previous : null })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(createElement(BriefScreen, {
      availableSymbols: new Set(['NVDA']),
      brief: latest,
      onSymbol: () => undefined,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(await screen.findByText('Earlier selective tape')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/public-research-brief?before=${encodeURIComponent(latest.publishedAt)}`,
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
