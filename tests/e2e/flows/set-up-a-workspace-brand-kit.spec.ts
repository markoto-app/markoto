import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/flow'

// "Set up a workspace brand kit".
//
// User-job: a workspace admin wants every document of the team to look
// like the company's: its font, its logo, one locked design. Job done
// when the font and logo are in the kit, the workspace uses the report's
// design, the design is locked, and another document of the workspace
// shows the lock in its theme panel and renders in the brand font.
//
// The flow stack runs the self-hosted free tier, which includes the brand
// kit (on markoto.app: Team and Business). The "company font" is the
// bundled TeX Gyre Heros file uploaded under another name.

const fixture = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const REPORT_THEME = JSON.parse(readFileSync(fixture('../fixtures/content/q3-report/theme.json'), 'utf8'))

test('Set up a workspace brand kit', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'the brand kit is set up at a desk')
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', { data: { name: 'Quaybridge' } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const { workspaceId } = await wsRes.json() as { workspaceId: string }

  // The report whose design becomes the workspace design, with the
  // company font as its body font.
  const reportRes = await page.request.post('/api/docs', { data: { workspaceId, title: 'Q3 2026 Quarterly Report', content: '# Q3 2026 Quarterly Report\n\nRevenue grew 31 % year over year.\n' } })
  const { docId: reportId } = await reportRes.json() as { docId: string }
  const theme = { ...REPORT_THEME, body: { ...REPORT_THEME.body, font: 'Quaybridge Sans' } }
  expect((await page.request.put(`/api/docs/${reportId}/meta`, { data: { theme } })).ok()).toBe(true)
  // Another document a colleague will write.
  const memoRes = await page.request.post('/api/docs', { data: { workspaceId, title: 'Carrier network update', content: '# Carrier network update\n\nBookings through the carrier network passed 40 000 in October.\n' } })
  const { docId: memoId } = await memoRes.json() as { docId: string }

  await page.goto(`/w/${workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Add your fonts and logo', 3)
  await flow.narrate(
    'The brand kit holds what makes documents look like your organisation\'s. '
    + 'Upload each font file, one per weight and style, and confirm your '
    + 'licence allows embedding it in PDFs. Logos become available as the '
    + 'cover logo and header image of every document in the workspace.'
  )
  await flow.click(
    'Open the Brand kit tab',
    page.getByRole('tab', { name: /brand kit/i }),
    {
      chain: true,
      annotations: [{ label: 'Brand kit', selector: '[role="tab"]:has-text("Brand kit")', kind: 'arrow' }],
      after: () => page.getByTestId('workspace-brand-kit-panel').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  await flow.step('Choose the font file, name it and confirm the licence', async () => {
    await page.getByTestId('brand-font-file').setInputFiles({
      name: 'QuaybridgeSans-Regular.woff2',
      mimeType: 'font/woff2',
      buffer: readFileSync(fixture('../../../fonts/tex-gyre-heros/heros-regular.woff2'))
    })
    await page.getByTestId('brand-font-family').fill('Quaybridge Sans')
    await page.getByTestId('brand-font-licence').click()
  }, { highlights: [{ label: 'Font upload', selector: '[data-testid="brand-font-upload"]' }] })
  await flow.click(
    'Upload it',
    page.getByTestId('brand-font-upload-submit'),
    { chain: true, after: () => page.getByTestId('brand-font-family-Quaybridge Sans').waitFor({ state: 'visible', timeout: 15_000 }) }
  )
  await page.getByTestId('brand-image-file').setInputFiles(fixture('../../../public/markoto-logos/app-icon-light.png'))
  await page.locator('[data-testid^="brand-image-"]:not([data-testid="brand-image-file"])').first().waitFor({ state: 'visible', timeout: 15_000 })
  await editor.page.dismissToasts()
  await page.getByTestId('brand-font-family-Quaybridge Sans').scrollIntoViewIfNeeded()
  await flow.shot('The font and the logo are in the kit', {
    highlights: [
      { label: 'Quaybridge Sans', selector: '[data-testid="brand-font-family-Quaybridge Sans"]' },
      { label: 'Logo', selector: '[data-testid^="brand-image-"]:not([data-testid="brand-image-file"])' }
    ]
  })

  await flow.heading('One design for every document', 3)
  await page.getByTestId('brand-design').scrollIntoViewIfNeeded()
  await flow.step('Take the design from the quarterly report', async () => {
    await page.getByTestId('brand-design-doc').click()
    await page.getByRole('option', { name: /Q3 2026 Quarterly Report/ }).click()
    await page.getByTestId('brand-design-use').click()
    await page.getByTestId('brand-design-current').waitFor({ state: 'visible', timeout: 10_000 })
  }, { highlights: [{ label: 'Workspace design', selector: '[data-testid="brand-design"]' }] })
  await expect(page.getByTestId('brand-design-current')).toContainText('Quaybridge Sans')
  // USwitch puts the test id on its root or on the switch button.
  const lockSwitch = page.locator('[data-testid="brand-lock"][role="switch"], [data-testid="brand-lock"] [role="switch"]').first()
  await flow.click(
    'Lock it for all documents',
    lockSwitch,
    { chain: true, after: () => expect(lockSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 }) }
  )

  // A colleague's document
  await flow.heading('Every document follows it', 3)
  await page.goto(`/d/${memoId}`)
  await editor.page.waitForReady()
  const token = await (await page.request.get(`/api/docs/${memoId}/token`)).json() as { brandKit: { lockedTheme: { body: { font: string } } | null } }
  expect(token.brandKit.lockedTheme?.body.font).toBe('Quaybridge Sans')
  await flow.click(
    'Open the theme panel of another document',
    editor.page.sidebar.theme,
    { chain: true, after: () => page.getByTestId('theme-brand-locked').waitFor({ state: 'visible', timeout: 10_000 }) }
  )
  await flow.shot('It uses the workspace design, only the cover text is its own', {
    hero: true,
    highlights: [{ label: 'Locked by the workspace', selector: '[data-testid="theme-brand-locked"]' }]
  })

  flow.next({ slug: 'see-who-changed-what-in-a-workspace', why: 'Font, logo, lock and template changes are recorded in the audit log.' })
})
