import { test, expect } from '@playwright/test'

// The /docs site reads its pages from a SQLite database Nuxt Content builds
// at runtime. Twice it broke only in the deployed container (wrong driver
// bundled; read-only root filesystem) while every other check stayed green,
// so smoke opens a docs page both server-rendered and via client navigation.
test('docs pages render, server-side and on client navigation', async ({ page }) => {
  const failedContentQueries: string[] = []
  page.on('response', (res) => {
    if (res.url().includes('/__nuxt_content/') && res.status() >= 400) failedContentQueries.push(`${res.status()} ${res.url()}`)
  })

  const res = await page.goto('/docs/workspaces/invite')
  expect(res?.status()).toBe(200)
  await expect(page.locator('main h1').first()).toHaveText(/invite a teammate/i)

  await page.goto('/docs')
  const docLink = page.locator('a[href^="/docs/"]').first()
  await expect(docLink).toBeVisible()
  await docLink.click()
  // eslint-disable-next-line playwright/no-networkidle -- the docs pages run no long-lived socket, and the content queries that follow the navigation are exactly what this test checks for failures
  await page.waitForLoadState('networkidle')
  await expect(page.locator('main h1').first()).toBeVisible()

  expect(failedContentQueries).toEqual([])
})
