import { expect, test } from '@playwright/test'
import { z } from 'zod'

import { marketSnapshotFixture } from './fixtures/market'

/** `postDataJSON()` hands back an unparsed body; decode it before the route acts on it. */
const FavoriteMutationRequestSchema = z.object({
  kind: z.enum(['merge', 'remove']),
  symbols: z.array(z.string()),
})

function isoDateAfter(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function publicSnapshotJson(snapshot: ReturnType<typeof marketSnapshotFixture>): string {
  return JSON.stringify({
    ...snapshot,
    tickers: snapshot.tickers.map(({ position: _position, ...ticker }) => ticker),
  })
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
    symbols: ['SPCX', 'META', 'BE', 'INTC', 'NVDA'],
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
    body: publicSnapshotJson(publicSnapshot),
  }))
  await page.addInitScript(() => {
    localStorage.setItem('spice.tickers.v6', 'stale owner ticker rows')
    localStorage.setItem('spice.watchlists.v6', 'stale owner watchlist rows')
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText('Premium looks')).toHaveCount(0)
  await expect(page.locator('.intent-label')).toHaveCount(0)
  await expect(page.locator('.premium-data-table [data-slot="badge"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, Expensive option premium/ })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => (
    key === 'spice.snapshot.v8'
      || /^spice\.(?:tickers|watchlists|research|catalysts|sync-state)\.v/.test(key)
  )))).toEqual(['spice.snapshot.v8'])
  await expect(page.getByRole('button', { name: 'Manage Options Watch' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Watchlist' })).toHaveCount(0)
  await expect(page.locator('.watchlist-title')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.getByText('Pin a ticker to see its upcoming events.')).toBeVisible()
  await expect(page.locator('.story')).toHaveCount(0)
  await expect(page.locator('.selected-instrument')).toContainText('NVIDIA')
  await expect(page.locator('.focus-tape')).toContainText('Front +6.6 pts')
  await expect(page.locator('.selected-price')).toContainText('$191.68')
  await expect(page.getByRole('button', { exact: true, name: 'Market cap' })).toBeVisible()
  await expect(page.getByRole('button', { exact: true, name: 'Price' })).toBeVisible()
  await expect(page.getByRole('button', { exact: true, name: 'Volume' })).toBeVisible()
  await expect(page.getByRole('button', { exact: true, name: 'Session' })).toHaveCount(0)
  await expect(page.getByRole('button', { exact: true, name: 'Activity' })).toHaveCount(0)
  await expect(page.locator('.premium-data-table tbody .sparkline')).toHaveCount(0)
  const nvdaRow = page.locator('.premium-data-table tbody tr', { hasText: 'NVDA' })
  await expect(nvdaRow.locator('.market-cap-cell')).toContainText('$4.7T')
  await expect(nvdaRow.locator('.price-cell')).toContainText('$191.68')
  await expect(nvdaRow.locator('.price-cell')).toContainText('+2.6%')
  await expect(nvdaRow.getByRole('progressbar', { name: /% of 52-week range/ })).toBeVisible()
  await expect(nvdaRow.locator('.volume-cell')).toContainText('128.4M')
  await expect(nvdaRow.locator('.liquidity-cell')).toContainText('5/5')
  await expect(nvdaRow.locator('.liquidity-cell')).toContainText('Easy To Borrow')
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

  await page.getByRole('tab', { name: 'Brief' }).click()
  await expect(page.getByText('Selective long vol')).toBeVisible()

  await page.getByRole('tab', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan can trade. Only for you.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()

  await page.goto('/support')
  await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible()
  await expect(page.getByText(/public, information-only market page/i)).toBeVisible()
  await expect(page.getByText(/Google-authenticated members can sync ticker favorites across devices/i)).toBeVisible()
  await expect(page.getByText('Market information is read-only')).toBeVisible()

  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'privacy@tryspice.xyz' }).first()).toHaveAttribute('href', 'mailto:privacy@tryspice.xyz')
})

test('mobile market, research, search, sorting, and agent flows remain coherent', async ({ page, context }) => {
  const snapshot = marketSnapshotFixture()
  let rejectSnapshots = false
  snapshot.catalysts.forEach((catalyst, index) => {
    catalyst.date = isoDateAfter(10 + index * 7)
  })
  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authRequired: true, user: { id: 'owner-1', name: 'Owner', role: 'owner' } }),
  }))
  await page.route('**/api/snapshot', (route) => {
    if (rejectSnapshots) {
      return route.fulfill({ status: 503, body: '{}' })
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot),
    })
  })
  const ownerFavorites = new Set<string>()
  await page.route('**/api/favorites', async (route) => {
    if (route.request().method() === 'POST') {
      const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
      if (action.kind === 'merge') action.symbols.forEach((symbol) => ownerFavorites.add(symbol))
      else action.symbols.forEach((symbol) => ownerFavorites.delete(symbol))
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ symbols: [...ownerFavorites].sort() }),
    })
  })
  await page.goto('/')
  await expect(page).toHaveTitle(/Spice Must Flow/)
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  await expect(page.locator('.brand')).toHaveAccessibleName('Spice home')
  await expect(page.locator('.brand')).toHaveText('SPICE')
  await expect(page.getByText('tastytrade live')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sync|refresh market data/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await expect(page.getByText('Premium looks')).toHaveCount(0)
  await expect(page.locator('.intent-label')).toHaveCount(0)
  await expect(page.locator('.premium-data-table [data-slot="badge"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, held, Expensive option premium/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Watch', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.premium-verdict')).toHaveText('Expensive')
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
  await expect(page.locator('.focus-runway')).toContainText('NVDA earnings')
  await expect(page.locator('.focus-runway')).toContainText('earnings \u00b7 After hours \u00b7 estimated')
  await expect(page.locator('.focus-thesis')).toContainText('Demand checks keep the AI capex thesis alive')
  await expect(page.locator('.focus-thesis')).toContainText('A guide-down or capex pause would break the demand thesis.')
  await expect(page.locator('.watchlist-title')).toHaveText('Watchlist')
  await expect(page.getByRole('combobox', { name: 'Watchlist' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, held, Expensive/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /SPCX, SpaceX Corporation, held, Cheap/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /BE, Bloom Energy, Fair/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /BE, Bloom Energy, Fair/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /INTC, Intel, Cheap/ })).toBeVisible()

  const selectedSymbol = page.locator('.selected-symbol')
  const search = page.getByLabel('Search all symbols')
  await search.fill('intel')
  await expect(page.locator('.premium-data-table tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: /INTC, Intel, Cheap/ }).click()
  await expect(selectedSymbol).toHaveText('INTC')
  await page.reload()
  await expect(selectedSymbol).toHaveText('INTC')
  await search.fill('zzzz')
  await expect(page.getByText('No loaded symbol matches your search.')).toBeVisible()
  await search.fill('')

  const rows = page.locator('.premium-data-table tbody tr')
  const premiumHeader = page.getByRole('button', { exact: true, name: 'Option premium' })
  await premiumHeader.click()
  await expect(rows.nth(0)).toContainText('TSLA')
  await expect(rows.nth(1)).toContainText('NVDA')
  await expect(rows.nth(2)).toContainText('BE')
  await premiumHeader.click()
  await expect(rows.nth(0)).toContainText('NVDA')
  await expect(rows.nth(2)).toContainText('SPY')

  await page.getByRole('button', { exact: true, name: 'Price' }).click()
  await expect(rows.nth(0)).toContainText('TSLA')
  const beRow = page.locator('.premium-data-table tbody tr', { hasText: 'BE' })
  await expect(beRow.locator('.price-cell')).toContainText('$43.16')
  await expect(beRow.locator('.price-cell')).toContainText('+3%')
  await expect(page.locator('.premium-data-table tbody .sparkline')).toHaveCount(11)

  await page.getByRole('tab', { name: 'Brief' }).click()
  await expect(page.getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('NVDA 205c 10/16')).toBeVisible()
  await expect(page.getByText('Selective long vol')).toBeVisible()
  await expect(page.getByRole('button', { name: /NVDA/ })).toBeVisible()

  await page.getByRole('tab', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan' })).toBeVisible()

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.getByRole('tab', { name: 'Watch', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Market data may be stale')
  await expect(page.getByRole('alert')).toContainText('The live feed disconnected')
  await expect(selectedSymbol).toHaveText('INTC')

  rejectSnapshots = true
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByRole('alert')).toContainText('Latest market data could not be synchronized')
  rejectSnapshots = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.getByRole('alert')).not.toContainText('Latest market data could not be synchronized')
  await expect(page.getByRole('alert')).toContainText('The live feed disconnected')
})

test('authenticated favorites consume only unchanged anonymous staging across tabs', async ({ context, page }) => {
  test.setTimeout(60_000)
  const snapshot = marketSnapshotFixture()
  snapshot.watchlists = [{
    id: 'public-options-watch',
    kind: 'public',
    name: 'Options Watch',
    symbols: ['NVDA', 'META', 'INTC'],
  }]
  snapshot.tickers = snapshot.tickers
    .filter((ticker) => snapshot.watchlists[0]!.symbols.includes(ticker.symbol))
    .map((ticker) => ({ ...ticker, position: false, sparkline: ticker.sparkline.slice(-2) }))
  const serverFavorites = new Set<string>()
  const anonymousMerges: string[][] = []
  let signedIn = false
  let delayFirstMerge = true
  let releaseFirstMerge: () => void = () => undefined
  let signalFirstMerge: () => void = () => undefined
  const firstMergeReleased = new Promise<void>((resolve) => {
    releaseFirstMerge = resolve
  })
  const firstMergeStarted = new Promise<void>((resolve) => {
    signalFirstMerge = resolve
  })

  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      authRequired: true,
      user: signedIn ? { id: 'member-1', name: 'Member', role: 'member' } : null,
    }),
  }))
  await page.route('**/api/public-snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: publicSnapshotJson(snapshot),
  }))
  await page.route('**/api/favorites', async (route) => {
    if (route.request().method() === 'POST') {
      const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
      if (action.kind === 'merge') {
        anonymousMerges.push(action.symbols)
        if (delayFirstMerge) {
          delayFirstMerge = false
          signalFirstMerge()
          await firstMergeReleased
        }
        action.symbols.forEach((symbol) => serverFavorites.add(symbol))
      } else {
        action.symbols.forEach((symbol) => serverFavorites.delete(symbol))
      }
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ symbols: [...serverFavorites].sort() }),
    })
  })
  await page.addInitScript(() => {
    window.sessionStorage.setItem('spice.test.block-preference-storage', 'true')
    window.addEventListener('storage', (event) => {
      if (
        event.key !== 'spice.preferences.v2'
        || window.sessionStorage.getItem('spice.test.block-preference-storage') !== 'true'
      ) return
      event.stopImmediatePropagation()
      window.sessionStorage.setItem('spice.test.blocked-preference-value', event.newValue ?? '')
    }, { capture: true })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Pin NVDA' }).click()

  const staleAnonymous = await context.newPage()
  await staleAnonymous.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authRequired: true, user: null }),
  }))
  await staleAnonymous.route('**/api/public-snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: publicSnapshotJson(snapshot),
  }))
  await staleAnonymous.goto('/')
  await expect(staleAnonymous.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()

  signedIn = true
  const signedInReload = page.reload()
  await firstMergeStarted
  await staleAnonymous.getByRole('button', { name: 'Pin META' }).click()
  await expect(staleAnonymous.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  releaseFirstMerge()
  await signedInReload
  await expect(page.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()

  expect(await page.evaluate(() => {
    const newValue = window.sessionStorage.getItem('spice.test.blocked-preference-value')
    if (!newValue) return false
    window.sessionStorage.removeItem('spice.test.block-preference-storage')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'spice.preferences.v2',
      newValue,
      storageArea: window.localStorage,
      url: window.location.href,
    }))
    return true
  })).toBe(true)
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  expect(anonymousMerges.some((symbols) => symbols.includes('NVDA') && symbols.includes('META'))).toBe(true)

  await staleAnonymous.bringToFront()
  await expect(staleAnonymous.getByRole('button', { name: 'Pin NVDA' })).toBeVisible()
  const authenticatedTabObservedStage = page.evaluate(() => new Promise<boolean>((resolve) => {
    const observePreference = (event: StorageEvent) => {
      if (event.key !== 'spice.preferences.v2') return
      window.removeEventListener('storage', observePreference)
      resolve(event.storageArea === window.localStorage)
    }
    window.addEventListener('storage', observePreference)
  }))
  await staleAnonymous.getByRole('button', { name: 'Pin INTC' }).click()
  expect(await authenticatedTabObservedStage).toBe(true)
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: 'Unpin INTC' })).toBeVisible()
  expect(serverFavorites).toEqual(new Set(['INTC', 'META', 'NVDA']))
  await staleAnonymous.close()
})

test('two signed-out devices converge on the account union without granting owner access', async ({ browser, page }) => {
  test.setTimeout(60_000)
  const snapshot = marketSnapshotFixture()
  snapshot.watchlists = [{
    id: 'public-options-watch',
    kind: 'public',
    name: 'Options Watch',
    symbols: ['NVDA', 'SPCX', 'META', 'BE', 'INTC'],
  }]
  snapshot.tickers = snapshot.tickers
    .filter((ticker) => snapshot.watchlists[0]!.symbols.includes(ticker.symbol))
    .map((ticker) => ({ ...ticker, position: false, sparkline: ticker.sparkline.slice(-2) }))
  let laptopSignedIn = false
  let mobileSignedIn = false
  let ownerSnapshotRequests = 0
  let rejectNextFavoriteMutation = false
  let rejectedFavoriteMutations = 0
  const serverFavorites = new Set(['BE'])
  const anonymousMerges: string[][] = []

  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      authRequired: true,
      user: laptopSignedIn ? { id: 'member-1', name: 'Member', role: 'member' } : null,
    }),
  }))
  await page.route('**/api/public-snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: publicSnapshotJson(snapshot),
  }))
  await page.route('**/api/snapshot', (route) => {
    ownerSnapshotRequests += 1
    return route.fulfill({ status: 403, body: '{}' })
  })
  await page.route('**/api/favorites', async (route) => {
    if (route.request().method() === 'POST') {
      if (rejectNextFavoriteMutation) {
        rejectNextFavoriteMutation = false
        rejectedFavoriteMutations += 1
        await route.fulfill({ status: 503, body: '{"error":"temporarily unavailable"}' })
        return
      }
      const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
      if (action.kind === 'merge') {
        anonymousMerges.push(action.symbols)
        action.symbols.forEach((symbol) => serverFavorites.add(symbol))
      } else {
        action.symbols.forEach((symbol) => serverFavorites.delete(symbol))
      }
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ symbols: [...serverFavorites].sort() }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Pin NVDA' }).click()
  await page.getByRole('button', { name: 'Pin META' }).click()
  laptopSignedIn = true
  await page.reload()

  await expect(page.getByRole('button', { name: 'Unpin BE' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()
  expect(anonymousMerges.some((symbols) => symbols.includes('META') && symbols.includes('NVDA'))).toBe(true)
  expect(ownerSnapshotRequests).toBe(0)

  const mobileContext = await browser.newContext()
  const mobile = await mobileContext.newPage()
  await mobile.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      authRequired: true,
      user: mobileSignedIn ? { id: 'member-1', name: 'Member', role: 'member' } : null,
    }),
  }))
  await mobile.route('**/api/public-snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: publicSnapshotJson(snapshot),
  }))
  await mobile.route('**/api/snapshot', (route) => {
    ownerSnapshotRequests += 1
    return route.fulfill({ status: 403, body: '{}' })
  })
  await mobile.route('**/api/favorites', async (route) => {
    if (route.request().method() === 'POST') {
      if (rejectNextFavoriteMutation) {
        rejectNextFavoriteMutation = false
        rejectedFavoriteMutations += 1
        await route.fulfill({ status: 503, body: '{"error":"temporarily unavailable"}' })
        return
      }
      const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
      if (action.kind === 'merge') {
        anonymousMerges.push(action.symbols)
        action.symbols.forEach((symbol) => serverFavorites.add(symbol))
      } else {
        action.symbols.forEach((symbol) => serverFavorites.delete(symbol))
      }
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ symbols: [...serverFavorites].sort() }),
    })
  })

  await mobile.goto('/')
  await mobile.getByRole('button', { name: 'Pin SPCX' }).click()
  await mobile.getByRole('button', { name: 'Pin INTC' }).click()
  mobileSignedIn = true
  await mobile.reload()
  await expect(mobile.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  await expect(mobile.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()
  await expect(mobile.getByRole('button', { name: 'Unpin SPCX' })).toBeVisible()
  await expect(mobile.getByRole('button', { name: 'Unpin INTC' })).toBeVisible()
  expect(anonymousMerges.some((symbols) => symbols.includes('INTC') && symbols.includes('SPCX'))).toBe(true)

  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: 'Unpin SPCX' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin INTC' })).toBeVisible()

  rejectNextFavoriteMutation = true
  await mobile.getByRole('button', { name: 'Unpin NVDA' }).click()
  await expect.poll(() => rejectedFavoriteMutations).toBe(1)
  await expect(mobile.getByRole('alert')).toContainText('Favorite update failed')
  await expect(mobile.getByRole('alert')).toContainText('Favorite sync failed (503)')
  await expect(mobile.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()

  await page.getByRole('button', { name: 'Unpin META' }).click()
  await mobile.bringToFront()
  await mobile.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(mobile.getByRole('button', { name: 'Pin META' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Pin META' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin BE' })).toBeVisible()
  await page.getByRole('tab', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: /Dan is owner-only/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
  expect(ownerSnapshotRequests).toBe(0)
  await mobileContext.close()
})
