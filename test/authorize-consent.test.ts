// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { Route } from '../src/routes/authorize.consent'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// SAFETY: the route is declared with `component: ConsentPage`, which takes no props.
const ConsentPage = Route.options.component as ComponentType

it('says the session check failed instead of stopping at the heading', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
  render(createElement(ConsentPage))
  await screen.findByText('Heston could not check whether you are signed in. Reload to try again.')
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('asks for approval once the member is known', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: { id: 'm', name: 'Dana', role: 'member' } })))
  render(createElement(ConsentPage))
  await screen.findByRole('button', { name: 'Approve' })
  expect(screen.queryByText(/could not check whether you are signed in/)).toBeNull()
})
