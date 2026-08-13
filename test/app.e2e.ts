import { expect, test } from '@playwright/test'

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
  await page.goto('/')
  await expect(page).toHaveTitle(/Spice Must Flow/)
  await expect(page.locator('.brand')).toHaveAccessibleName('Spice Must Flow home')
  await expect(page.locator('.brand')).toHaveText('SPICEMUST FLOW')
  await expect(page.getByText('tastytrade live')).toHaveCount(0)
  await expect(page.getByText('Demo market')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sync|refresh market data/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /SPY/ }).first()).toBeVisible()
  await expect(page.getByText('$691.24').first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.getByText('Upcoming catalysts')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Active Positions/ })).toHaveCount(0)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.locator('.story').first()).toContainText('EARN 13D')
  await expect(page.getByText('Options temperature')).toHaveCount(0)
  await expect(page.getByText('Premium cool')).toHaveCount(0)

  await page.getByRole('button', { name: 'Change' }).click()
  const tickerPicker = page.getByRole('dialog', { name: 'Choose a ticker' })
  await expect(tickerPicker).toBeVisible()
  await expect(tickerPicker.locator('.sheet-group > h3')).toHaveText([
    'Open positions',
    'Private watchlists',
    'Tastytrade public lists',
  ])
  await page.getByRole('dialog').getByRole('button', { name: /NVDA/ }).first().click()
  await expect(page.getByText('$191.68').first()).toBeVisible()

  await page.getByRole('button', { name: 'Brief' }).click()
  await expect(page.getByText('Market pulse')).toHaveCount(0)
  await expect(page.getByText('Today’s setups')).toHaveCount(0)
  await expect(page.getByText('3 ideas')).toHaveCount(0)
  await expect(page.getByText('Selective long vol')).toBeVisible()
  const sources = page.locator('.source-list')
  await expect(sources.getByText('Sources')).toBeVisible()
  await expect(sources).not.toHaveAttribute('open', '')

  await page.getByRole('button', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear conversation' }).click()
  const composer = page.getByPlaceholder('Ask about a ticker or draft an order…')
  await composer.fill('Why is NVDA volatility expensive?')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(/NVDA options look rich/)).toBeVisible()

  await composer.fill('Buy 1 SPY 700 call expiring 2026-09-18 at $5.20')
  await page.getByRole('button', { name: 'Send message' }).click()
  const toolCall = page.getByRole('button', { name: /Preparing order/ }).last()
  await expect(toolCall).toBeVisible()
  await toolCall.click()
  await expect(page.locator('.tool-call-detail').last()).toContainText('place_option_order')
  await expect(page.getByText('Order confirmation')).toBeVisible()
  await expect(page.getByLabel('Agent runtime usage')).toContainText('pi · spice-demo')
  await page.route('**/api/actions/*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Action service temporarily unavailable' }),
    status: 503,
  }))
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('alert')).toHaveText('Action service temporarily unavailable')
  await expect(page.getByText('Order confirmation')).toBeVisible()
  await page.unroute('**/api/actions/*')
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Demo action discarded')).toBeVisible()

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.getByRole('button', { name: 'Market' }).click()
  await expect(page.getByText('$191.68').first()).toBeVisible()
})
