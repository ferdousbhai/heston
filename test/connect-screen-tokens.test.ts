// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ConnectScreen } from '../src/components/connect-screen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const UNEXPECTED = 'Agent tokens returned an unexpected response.'
const token = { createdAt: '2026-09-01T00:00:00Z', label: 'Laptop', lastUsedAt: '2026-09-02T00:00:00Z', tokenId: 't1' }

it('stops the spinner and names the server refusal when the first read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Token store unavailable' }, { status: 503 })))
  const { container } = render(createElement(ConnectScreen, { owner: false }))
  await screen.findByText('Token store unavailable')
  expect(container.querySelector('[data-slot="spinner"], [role="status"]')).toBeNull()
})

it('reports a malformed token list as an unexpected response, never as the parser output', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tokens: [{ ...token, lastUsedAt: 7 }] })))
  const { container } = render(createElement(ConnectScreen, { owner: false }))
  await screen.findByText(UNEXPECTED)
  expect(container.textContent).not.toContain('invalid_type')
  expect(container.querySelector('[data-slot="spinner"], [role="status"]')).toBeNull()
})

it('reports a malformed issue response as an unexpected response', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ nope: true })
    : Response.json({ tokens: [token] }))
  vi.stubGlobal('fetch', fetchMock)
  const { container } = render(createElement(ConnectScreen, { owner: false }))
  await screen.findByText('Laptop')
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }))
  await screen.findByText(UNEXPECTED)
  expect(container.textContent).not.toContain('invalid_type')
  // The typed name survives a failed issue, so the member does not retype it.
  expect(screen.getByRole('textbox', { name: 'Token name' })).toHaveProperty('value', 'Phone')
})

it('reports a malformed revoke response as an unexpected response', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? Response.json({ tokens: 'nope' })
    : Response.json({ tokens: [token] })))
  render(createElement(ConnectScreen, { owner: false }))
  await screen.findByText('Laptop')
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await screen.findByText(UNEXPECTED)
})

it('keeps the server message for a refused revoke and shows the list it returns on success', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? Response.json({ error: 'No such token' }, { status: 404 })
    : Response.json({ tokens: [token] })))
  render(createElement(ConnectScreen, { owner: false }))
  await screen.findByText('Laptop')
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await screen.findByText('No such token')

  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tokens: [] })))
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await screen.findByText('No tokens yet.')
})

it('shows the spinner only while the first read is in flight', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
  const { container } = render(createElement(ConnectScreen, { owner: false }))
  const spinner = () => container.querySelector('[data-slot="spinner"], [role="status"]')
  expect(spinner()).not.toBeNull()
  finish(Response.json({ tokens: [] }))
  await screen.findByText('No tokens yet.')
  await waitFor(() => expect(spinner()).toBeNull())
})
