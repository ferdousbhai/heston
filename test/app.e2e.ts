import { expect, test } from '@playwright/test'

test('unauthenticated visitors get the branded Google entry point', async ({ page }) => {
  await page.route('**/api/viewer', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ authRequired: true, user: null }),
  }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your market. In motion.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  await expect(page.getByText('One authorized account')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
})

test('mobile market, research, picker, and agent flows remain coherent', async ({ page, context }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/Spice Must Flow/)
  await expect(page.locator('.brand')).toHaveAccessibleName('Spice Must Flow')
  await expect(page.locator('.brand')).toHaveText('SPICEMUST FLOW')
  await expect(page.getByText('tastytrade live')).toHaveCount(0)
  await expect(page.getByText('Demo market')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sync|refresh market data/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /SPY/ }).first()).toBeVisible()
  await expect(page.getByText('$691.24').first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Catalysts in the next 30 days' })).toBeVisible()
  await expect(page.getByText('Upcoming catalysts')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Active Positions/ })).toHaveCount(0)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.locator('.story').first()).toContainText('EARN 13D')
  await expect(page.getByText('Options temperature')).toHaveCount(0)
  await expect(page.getByText('Premium cool')).toHaveCount(0)

  await page.getByRole('button', { name: 'Change' }).click()
  await expect(page.getByRole('dialog', { name: 'Choose a ticker' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: /NVDA/ }).first().click()
  await expect(page.getByText('$191.68').first()).toBeVisible()

  await page.getByRole('button', { name: 'Brief' }).click()
  await expect(page.getByText('Market pulse')).toHaveCount(0)
  await expect(page.getByText('Today’s setups')).toHaveCount(0)
  await expect(page.getByText('3 ideas')).toHaveCount(0)
  await expect(page.getByText('Selective long vol')).toBeVisible()

  await page.getByRole('button', { name: 'Dan' }).click()
  await expect(page.getByRole('heading', { name: 'Dan' })).toBeVisible()
  const composer = page.getByPlaceholder('Ask about a ticker or draft an order…')
  await composer.fill('Why is NVDA volatility expensive?')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(/NVDA options look rich/)).toBeVisible()

  await composer.fill('Buy 1 SPY 700 call expiring 2026-09-18 at $5.20')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Brokerage confirmation')).toBeVisible()
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Demo action discarded')).toBeVisible()

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.getByRole('button', { name: 'Market' }).click()
  await expect(page.getByText('$191.68').first()).toBeVisible()
})
