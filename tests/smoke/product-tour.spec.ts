import { test, expect, type Page } from '@playwright/test'
import { waitForHydration } from './_helpers'

// The hosted product page: with NUXT_MARKETING_SITE_ENABLED on, `/`
// shows logged-out visitors the scroll-driven tour instead of the plain
// hero. The flag is read from the instance config the server ships in the
// Nuxt payload (`useState('instance-config')`), NOT inferred from the tour
// markup: so an environment with the flag off skips, while one with the
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
  await expect(page.getByTestId('tour-self-host')).toHaveAttribute('href', '/docs/self-hosting')

  // The CTA still creates a document. A first-time visitor skips the
  // new-document dialog: the dialog that shows is the anonymous gate (terms
  // + bot check) before the Demo document. Only once the page has hydrated:
  // before that the server-rendered button has no handler (the app replays
  // such a click, see earlyClicks.ts, but the gate checks the dialog, not
  // the race).
  await waitForHydration(page)
  await page.getByTestId('tour-start-writing').click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('the hero picture plays the demo video in a dialog, loaded only on demand', async ({ page }) => {
  const media: string[] = []
  page.on('request', (req) => {
    if (/\/media\/markoto-demo-[0-9a-f]+\.mp4$/.test(new URL(req.url()).pathname)) media.push(req.url())
  })
  await page.goto('/')
  const flag = await marketingSiteFlag(page)
  test.skip(flag !== true, `marketing site not enabled on this instance (flag: ${String(flag)})`)
  await waitForHydration(page)
  expect(media).toEqual([])

  // One of the two play buttons is shown, depending on the layout.
  const play = page.locator('[data-testid="tour-demo-play"]:visible, [data-testid="tour-demo-play-stage"]:visible').first()
  await expect(play).toHaveText('Watch the 2-minute demo')
  await play.getByText('Watch the 2-minute demo').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('demo-video-overlay-video')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(play).toBeFocused()
})
