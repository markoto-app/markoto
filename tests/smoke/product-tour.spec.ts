import { test, expect, type Page } from '@playwright/test'

// The hosted product page: with NUXT_MARKETING_SITE_ENABLED on, `/`
// shows logged-out visitors the scroll-driven tour instead of the plain
// hero. The flag is read from the instance config the server ships in the
// Nuxt payload (`useState('instance-config')`), NOT inferred from the tour
// markup — so an environment with the flag off skips, while one with the
// flag on but a broken tour fails.

/** `marketingSite` from the SSR payload; null when it can't be found. */
async function marketingSiteFlag(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const el = document.getElementById('__NUXT_DATA__')
    if (!el?.textContent) return null
    let data: unknown
    try {
      data = JSON.parse(el.textContent)
    } catch {
      return null
    }
    if (!Array.isArray(data)) return null
    // devalue's flat form: objects map keys to indices into the array.
    for (const entry of data) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>
        const ref = record.marketingSite
        if ('loginProviders' in record && typeof ref === 'number') {
          const value: unknown = data[ref]
          return typeof value === 'boolean' ? value : null
        }
      }
    }
    return null
  })
}

test('logged-out home page shows the product tour when the instance enables it', async ({ page }) => {
  await page.goto('/')
  const flag = await marketingSiteFlag(page)
  test.skip(flag !== true, `marketing site not enabled on this instance (flag: ${String(flag)})`)

  const tour = page.getByTestId('product-tour')
  await expect(tour).toBeVisible()
  await expect(tour.getByRole('heading', { level: 1 })).toHaveText('Beautifully rendered Markdown.')
  await expect(page.getByTestId('tour-start-writing')).toBeVisible()
  // All scene copy is server-rendered, and the closing CTAs are reachable.
  await expect(tour.getByRole('heading', { level: 2, name: 'Write Markdown, get paged documents.' })).toBeAttached()
  await expect(page.getByTestId('tour-self-host')).toHaveAttribute('href', '/docs/getting-started/self-hosting')

  // The CTA still creates a document, like the plain hero's button.
  await page.getByTestId('tour-start-writing').click()
  await expect(page.getByRole('dialog')).toBeVisible()
})
