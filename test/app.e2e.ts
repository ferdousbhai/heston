import { expect, test } from '@playwright/test'
import { z } from 'zod'

import { marketSnapshotFixture } from './fixtures/market'

/** `postDataJSON()` hands back an unparsed body; decode it before the route acts on it. */
const WatchlistMutationRequestSchema = z.object({ kind: z.string(), symbols: z.array(z.string()) })

test('unauthenticated visitors get the branded Google entry point', async ({ page }) => {
  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authRequired: true, user: null }),
  }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your market. In motion.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)

  await page.getByRole('link', { name: 'Privacy' }).click()
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'privacy@tryspice.xyz' }).first()).toHaveAttribute('href', 'mailto:privacy@tryspice.xyz')
})

test('mobile market, research, picker, and agent flows remain coherent', async ({ page, context }) => {
  const snapshot = marketSnapshotFixture()
  snapshot.catalysts.forEach((catalyst, index) => {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() + 10 + index * 7)
    catalyst.date = date.toISOString().slice(0, 10)
  })
  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authRequired: true, user: { name: 'Owner' } }),
  }))
  await page.route('**/api/snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(snapshot),
  }))
  await page.route('**/api/watchlists', async (route) => {
    const action = WatchlistMutationRequestSchema.parse(route.request().postDataJSON())
    const watchlist = snapshot.watchlists.find((candidate) => candidate.kind === 'private')!
    const requested = new Set(action.symbols)
    watchlist.symbols = action.kind === 'add_watchlist_symbols'
      ? [...new Set([...watchlist.symbols, ...action.symbols])]
      : watchlist.symbols.filter((symbol) => !requested.has(symbol))
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ detail: 'updated' }) })
  })
  await page.goto('/')
  await expect(page).toHaveTitle(/Spice Must Flow/)
  await expect(page.locator('.brand')).toHaveAccessibleName('Spice Must Flow home')
  await expect(page.locator('.brand')).toHaveText('SPICEMUST FLOW')
  await expect(page.getByText('tastytrade live')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sync|refresh market data/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /SPY/ }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Market' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('$691.24').first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.getByText('Upcoming catalysts')).toHaveCount(0)
  const watchlistSelector = page.getByRole('combobox', { name: 'Watchlist' })
  await expect(watchlistSelector).toHaveValue('positions')
  const watchlistNames = await watchlistSelector.locator('option').allTextContents()
  expect(watchlistNames.slice(0, 2)).toEqual(['Active Positions', 'Watchlist'])
  expect(watchlistNames.slice(2)).toEqual(expect.arrayContaining(['Liquid ETFs', 'Options Volume', 'Upcoming Earnings']))
  await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(0)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.locator('.story').first()).toContainText('EARN')
  await expect(page.getByText('Options temperature')).toHaveCount(0)
  await expect(page.getByText('Premium cool')).toHaveCount(0)

  await watchlistSelector.selectOption('watchlist')
  await page.getByRole('button', { name: 'Manage Watchlist' }).click()
  const watchlistEditor = page.getByRole('dialog', { name: 'Manage watchlist' })
  await expect(watchlistEditor).toBeVisible()
  await watchlistEditor.getByLabel('Add a symbol').fill('META')
  await watchlistEditor.getByRole('button', { name: 'Add symbol' }).click()
  await expect(watchlistEditor.locator('.watchlist-member', { hasText: 'META' })).toBeVisible()
  await watchlistEditor.getByRole('button', { name: 'Remove TSLA from Watchlist' }).click()
  await expect(watchlistEditor.locator('.watchlist-member', { hasText: 'TSLA' })).toHaveCount(0)
  await watchlistEditor.getByRole('button', { name: 'Close watchlist editor' }).click()
  await watchlistSelector.selectOption('public-liquid')
  await expect(page.getByRole('button', { name: 'Manage Watchlist' })).toHaveCount(0)

  await page.getByRole('button', { name: /SPY/ }).first().click()
  const tickerPicker = page.getByRole('dialog', { name: 'Choose a ticker' })
  await expect(tickerPicker).toBeVisible()
  await expect(tickerPicker.locator('.sheet-group > h3')).toHaveText([
    'Open positions',
    'Private watchlists',
    'Tastytrade public lists',
  ])
  await page.getByRole('dialog').getByRole('button', { name: /NVDA/ }).first().click()
  await expect(page.getByText('$191.68').first()).toBeVisible()
  await expect(page.locator('.ticker-switcher')).toContainText('NVDA')

  await page.getByRole('button', { name: 'Brief' }).click()
  await expect(page.getByRole('button', { name: 'Brief' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Market pulse')).toHaveCount(0)
  await expect(page.getByText('Today’s setups')).toHaveCount(0)
  await expect(page.getByText('3 ideas')).toHaveCount(0)
  await expect(page.getByText('Selective long vol')).toBeVisible()
  const sources = page.locator('.source-list')
  await expect(sources.getByText('Sources')).toBeVisible()
  await expect(sources).not.toHaveAttribute('open', '')

  await page.getByRole('button', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan' })).toBeVisible()

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.getByRole('button', { name: 'Market' }).click()
  await expect(page.getByText('$191.68').first()).toBeVisible()
})
