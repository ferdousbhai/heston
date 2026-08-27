import { expect, test } from '@playwright/test'
import { z } from 'zod'

import { marketSnapshotFixture } from './fixtures/market'

/** `postDataJSON()` hands back an unparsed body; decode it before the route acts on it. */
const WatchlistMutationRequestSchema = z.object({ kind: z.string(), symbols: z.array(z.string()) })

function isoDateAfter(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

test('unauthenticated visitors can read market data but Dan stays behind Google sign-in', async ({ page }) => {
  const publicSnapshot = marketSnapshotFixture()
  publicSnapshot.catalysts = publicSnapshot.catalysts.map((catalyst) => (
    catalyst.symbol === 'NVDA' ? { ...catalyst, date: isoDateAfter(10) } : catalyst
  ))
  publicSnapshot.watchlists = [{
    id: 'public-options-watch',
    kind: 'public',
    name: 'Options Watch',
    symbols: ['NVDA', 'SPCX', 'META', 'BE', 'INTC'],
  }]
  publicSnapshot.tickers = publicSnapshot.tickers
    .filter((ticker) => publicSnapshot.watchlists[0]!.symbols.includes(ticker.symbol))
    .map((ticker) => ({ ...ticker, position: false, sparkline: ticker.sparkline.slice(-2) }))
  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authRequired: true, user: null }),
  }))
  await page.route('**/api/public-snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(publicSnapshot),
  }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Owner sign in' })).toBeVisible()
  await expect(page.getByText('Premium looks')).toHaveCount(0)
  await expect(page.locator('.intent-label')).toHaveCount(0)
  await expect(page.locator('.premium-data-table [data-slot="badge"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, Expensive option premium/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Manage Options Watch' })).toHaveCount(0)
  // A visitor sees one watchlist, so it is named in place rather than behind a chooser.
  await expect(page.getByRole('combobox', { name: 'Watchlist' })).toHaveCount(0)
  await expect(page.locator('.watchlist-title')).toHaveText('Options Watch')
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.getByText('Pin a ticker to see its upcoming events.')).toBeVisible()
  await expect(page.locator('.story')).toHaveCount(0)
  await expect(page.locator('.selected-instrument')).toContainText('NVIDIA')
  await expect(page.locator('.premium-stats')).toContainText('Front +6.6 pts')
  await expect(page.locator('.year-range')).toContainText('$191.68')
  await expect(page.getByRole('button', { exact: true, name: 'Price' })).toBeVisible()
  await expect(page.getByRole('button', { exact: true, name: 'Volume' })).toBeVisible()
  await expect(page.getByRole('button', { exact: true, name: 'Session' })).toHaveCount(0)
  await expect(page.getByRole('button', { exact: true, name: 'Activity' })).toHaveCount(0)
  await expect(page.locator('.premium-data-table tbody .sparkline')).toHaveCount(0)
  const nvdaRow = page.locator('.premium-data-table tbody tr', { hasText: 'NVDA' })
  await expect(nvdaRow.locator('.price-cell')).toContainText('$191.68')
  await expect(nvdaRow.locator('.price-cell')).toContainText('+2.6%')
  await expect(nvdaRow.locator('.volume-cell')).toContainText('128.4M shares')
  await expect(nvdaRow.locator('.volume-cell')).toContainText('$4.7T cap')
  await page.getByRole('button', { name: 'Pin META' }).click()
  await expect(page.locator('.premium-data-table tbody tr').first()).toContainText('META')
  await expect(page.locator('.story')).toHaveCount(0)
  await page.getByRole('button', { name: 'Pin NVDA' }).click()
  await expect(page.locator('.story')).toHaveCount(1)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unpin META' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Unpin NVDA' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.getByText('Long vol')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Daily read' }).click()
  await expect(page.getByText('Worth your attention')).toBeVisible()

  await page.getByRole('tab', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan can trade. Only for you.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  await expect(page.getByText('Watch and Daily read remain public.')).toBeVisible()

  await page.goto('/support')
  await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible()
  await expect(page.getByText(/single-owner application with a public, information-only market page/i)).toBeVisible()
  await expect(page.getByText(/There is no public registration or public trading access/i)).toBeVisible()
  await expect(page.getByText('Public information is read-only')).toBeVisible()

  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'privacy@tryspice.xyz' }).first()).toHaveAttribute('href', 'mailto:privacy@tryspice.xyz')
})

test('mobile market, research, search, sorting, and agent flows remain coherent', async ({ page, context }) => {
  const snapshot = marketSnapshotFixture()
  snapshot.catalysts.forEach((catalyst, index) => {
    catalyst.date = isoDateAfter(10 + index * 7)
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
    if (action.kind === 'add_watchlist_symbols' && action.symbols.includes('FULL')) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          appliedSymbols: [],
          detail: 'FULL could not be retained within the 100-symbol Watchlist',
          discardedSymbols: ['FULL'],
        }),
      })
      return
    }
    const requested = new Set(action.symbols)
    watchlist.symbols = action.kind === 'add_watchlist_symbols'
      ? [...new Set([...watchlist.symbols, ...action.symbols])]
      : watchlist.symbols.filter((symbol) => !requested.has(symbol))
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ appliedSymbols: action.symbols, detail: 'updated', discardedSymbols: [] }),
    })
  })
  await page.goto('/')
  await expect(page).toHaveTitle(/Spice Must Flow/)
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  await expect(page.locator('.brand')).toHaveAccessibleName('Spice Must Flow home')
  await expect(page.locator('.brand')).toHaveText('SPICEMUST FLOW')
  await expect(page.getByText('tastytrade live')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sync|refresh market data/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await expect(page.getByText('Premium looks')).toHaveCount(0)
  await expect(page.locator('.intent-label')).toHaveCount(0)
  await expect(page.locator('.premium-data-table [data-slot="badge"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, held, Expensive option premium/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Watch', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#selected-premium-title')).toHaveText('Expensive')
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.locator('.story')).toHaveCount(0)
  await page.getByRole('button', { name: 'Pin NVDA' }).click()
  await expect(page.locator('.story')).toHaveCount(1)
  await page.getByRole('button', { name: 'Pin TSLA' }).click()
  await expect(page.locator('.story')).toHaveCount(2)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.locator('.story').first()).toContainText('EARN')
  await page.getByRole('button', { name: /TSLA: TSLA earnings/ }).click()
  await expect(page.locator('.selected-symbol')).toHaveText('TSLA')
  await page.getByRole('button', { name: /NVDA: NVDA earnings/ }).click()
  await expect(page.locator('.selected-symbol')).toHaveText('NVDA')
  // The owner reads the one D1-backed list, so there is nothing to choose between.
  await expect(page.locator('.watchlist-title')).toHaveText('Watchlist')
  await expect(page.getByRole('combobox', { name: 'Watchlist' })).toHaveCount(0)
  // Held positions are marked in place of the retired Active Positions list.
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, held, Expensive/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /SPCX, SpaceX Corporation, held, Cheap/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /BE, Bloom Energy, Fair/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /BE, Bloom Energy, Fair/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /INTC, Intel, Cheap/ })).toBeVisible()

  await page.getByRole('button', { name: 'Manage Watchlist' }).click()
  const watchlistEditor = page.getByRole('dialog', { name: 'Manage watchlist' })
  await expect(watchlistEditor).toBeVisible()
  await watchlistEditor.getByLabel('Add a symbol').fill('PLTR')
  await expect(page.getByText('No loaded symbol matches. You can still add the typed equity symbol.')).toBeVisible()
  await page.keyboard.press('Escape')
  await watchlistEditor.getByRole('button', { name: 'Add symbol' }).click()
  await expect(watchlistEditor.locator('.watchlist-member', { hasText: 'PLTR' })).toBeVisible()
  await watchlistEditor.getByRole('button', { name: 'Remove PLTR from Watchlist' }).click()
  await expect(watchlistEditor.locator('.watchlist-member', { hasText: 'PLTR' })).toHaveCount(0)
  await watchlistEditor.getByLabel('Add a symbol').fill('FULL')
  await page.keyboard.press('Escape')
  await expect(watchlistEditor.getByRole('button', { name: 'Add symbol' })).toBeEnabled()
  await watchlistEditor.getByRole('button', { name: 'Add symbol' }).click()
  await expect(watchlistEditor.getByText('FULL could not be retained within the 100-symbol Watchlist')).toBeVisible()
  await expect(watchlistEditor.getByLabel('Add a symbol')).toHaveValue('FULL')
  await expect(watchlistEditor.locator('.watchlist-member', { hasText: 'FULL' })).toHaveCount(0)
  await watchlistEditor.getByRole('button', { name: 'Close watchlist editor' }).click()
  await expect(page.getByRole('button', { name: 'Manage Watchlist' })).toBeFocused()

  const selectedSymbol = page.locator('.selected-symbol')
  // Searching reaches every loaded instrument, not only the active watchlist.
  const search = page.getByLabel('Search all symbols')
  await search.fill('intel')
  await expect(page.locator('.premium-data-table tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: /INTC, Intel, Cheap/ }).click()
  await expect(selectedSymbol).toHaveText('INTC')
  await search.fill('zzzz')
  await expect(page.getByText('No loaded symbol matches your search.')).toBeVisible()
  await search.fill('')

  // Column headers sort the table and the same header toggles the direction.
  // Pinned NVDA and TSLA hold the top rows, ordered among themselves by the
  // active column, so the unpinned order is read from the third row down.
  const rows = page.locator('.premium-data-table tbody tr')
  const rankHeader = page.getByRole('button', { exact: true, name: 'IV rank' })
  await rankHeader.click()
  await expect(rows.nth(0)).toContainText('TSLA')
  await expect(rows.nth(1)).toContainText('NVDA')
  await expect(rows.nth(2)).toContainText('BE')
  await rankHeader.click()
  await expect(rows.nth(0)).toContainText('NVDA')
  await expect(rows.nth(2)).toContainText('SPY')

  // Price combines the quote, session move, genuine candle series, and range.
  await page.getByRole('button', { exact: true, name: 'Price' }).click()
  await expect(rows.nth(0)).toContainText('TSLA')
  const beRow = page.locator('.premium-data-table tbody tr', { hasText: 'BE' })
  await expect(beRow.locator('.price-cell')).toContainText('$43.16')
  await expect(beRow.locator('.price-cell')).toContainText('+3%')
  await expect(beRow.locator('.price-cell')).toContainText('52w range unavailable')
  await expect(page.locator('.premium-data-table tbody .sparkline')).toHaveCount(11)

  await page.getByRole('tab', { name: 'Daily read' }).click()
  await expect(page.getByRole('tab', { name: 'Daily read' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Worth your attention')).toBeVisible()
  await expect(page.getByText('NVDA 205c 10/16')).toBeVisible()
  await expect(page.getByText('Selective long vol')).toBeVisible()
  await expect(page.getByText('PLTR', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /PLTR/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA/ })).toBeVisible()
  const sources = page.locator('.source-list')
  await expect(sources.getByText('Evidence reviewed')).toBeVisible()
  await expect(sources).not.toHaveAttribute('open', '')

  await page.getByRole('tab', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan' })).toBeVisible()

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.getByRole('tab', { name: 'Watch', exact: true }).click()
  await expect(selectedSymbol).toHaveText('INTC')
})
