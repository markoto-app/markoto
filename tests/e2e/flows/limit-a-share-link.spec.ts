import { Pool } from 'pg'
import { test, expect } from '../fixtures/flow'

// "Limit a share link".
//
// User-job: a writer shares a draft by link but doesn't want it to end up
// as a file in someone's downloads, nor to stay open forever. Job done
// when the link is view-only with an end date, a visitor in their own
// browser can read but has no export or print, and after the end date
// the link says it expired.
//
// The flow stack runs the self-hosted free tier, which includes link
// settings (on markoto.app: Pro and up). The end date is moved into the
// past in the database to show the expired link without waiting.

const DB_URL = 'postgres://ypad:testpassword@localhost:5433/ypad_test'

test('Limit a share link', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'link settings are set at a desk')
  test.setTimeout(120_000)
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({
    title: 'Pricing proposal for Harbourline',
    body: '# Pricing proposal for Harbourline\n\nThree depots, one shared routing model, billed per booked slot.\n\n## Price\n\nEUR 0.40 per booked slot, minimum EUR 1 200 per month.\n',
    cover: false
  })
  const docUrl = page.url()
  const docId = new URL(docUrl).pathname.split('/').pop()!

  await flow.heading('View only, with an end date', 3)
  await flow.narrate(
    'A link to an "Anyone can view" document can be limited: turn off '
    + 'downloading and printing for the people you send it to, and let the '
    + 'link stop working on a date. You and your workspace keep full access.'
  )
  await flow.click(
    'Open the share dialog',
    editor.page.accessLockButton,
    { chain: true, after: () => page.getByTestId('share-modal').waitFor({ state: 'visible', timeout: 10_000 }) }
  )
  await flow.click(
    'Let anyone with the link view it',
    page.getByTestId('share-access-open-view'),
    { chain: true, after: () => page.getByTestId('share-modal').waitFor({ state: 'hidden', timeout: 10_000 }) }
  )
  // Choosing a mode closes the dialog; open it again for the link settings.
  await editor.page.accessLockButton.click()
  await page.getByTestId('share-controls').waitFor({ state: 'visible', timeout: 10_000 })
  await flow.step('Turn on view only and choose when the link stops working', async () => {
    await page.getByTestId('share-controls').scrollIntoViewIfNeeded()
    const toggle = page.locator('[data-testid="share-no-download"][role="switch"], [data-testid="share-no-download"] [role="switch"]').first()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    const until = new Date(Date.now() + 7 * 86_400_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const expiry = page.getByTestId('share-expiry')
    await expiry.fill(`${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}T17:00`)
    await expiry.dispatchEvent('change')
    await expect.poll(async () => {
      const res = await page.request.get(`/api/docs/${docId}/share-settings`)
      return (await res.json() as { expiresAt: string | null, noDownload: boolean })
    }, { timeout: 10_000 }).toMatchObject({ noDownload: true, expiresAt: expect.any(String) })
  }, {
    hero: true,
    highlights: [{ label: 'Link settings', selector: '[data-testid="share-controls"]' }]
  })
  await page.keyboard.press('Escape')

  // The visitor
  await flow.heading('What the people with the link see', 3)
  const visitor = await flow.spawn('visitor')
  await visitor.editor.loginAsTestUser('Sam Reeves')
  await visitor.page.goto(docUrl)
  await visitor.editor.waitForReady()
  const fileMenu = visitor.page.locator('nav[aria-label="Menu bar"] > button:has-text("File")').first()
  await visitor.flow.click(
    'They can read it, but File has no export or print',
    fileMenu,
    { chain: true, after: () => visitor.page.getByRole('menuitem', { name: /new/i }).first().waitFor({ state: 'visible', timeout: 10_000 }) }
  )
  await expect(visitor.page.getByRole('menuitem', { name: /^print/i })).toHaveCount(0)
  await expect(visitor.page.getByRole('menuitem', { name: /export/i })).toHaveCount(0)
  expect((await visitor.page.request.get(`/api/docs/${docId}/pdf`)).status()).toBe(403)
  await visitor.flow.shot('No export, no PDF, no print, for them only')
  await visitor.page.keyboard.press('Escape')

  // The end date passes.
  const pool = new Pool({ connectionString: DB_URL, max: 1 })
  try {
    await pool.query(`UPDATE documents SET share_expires_at = now() - interval '1 minute' WHERE doc_id = $1`, [docId])
  } finally {
    await pool.end()
  }
  await visitor.page.goto(docUrl)
  await visitor.page.getByText(/this link has expired/i).waitFor({ state: 'visible', timeout: 15_000 })
  await visitor.flow.shot('After the end date the link says it expired')

  flow.next({ slug: 'password-protect', why: 'Ask for a password before anyone can open the document.' })
})
