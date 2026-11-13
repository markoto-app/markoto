import { test, expect } from '../fixtures/flow'

// Tier 2: "Set a default theme for the whole workspace".
//
// User-job: a workspace admin wants every new doc in the workspace
// to inherit a specific look, the team's typography preset, the
// brand colour, the cover layout the company decided on. Without
// this, every member starts from markoto's default and either picks
// the same preset by hand each time or works on differently-styled
// docs. Job done when the admin has picked a preset under workspace
// settings AND a new doc created in that workspace opens with the
// admin's choice as the design of a blank page in the new-doc dialog.
//
// What this flow is NOT: a tour of the theme presets themselves
// (covered by `pick-a-theme`) or the per-section editor (covered by
// `theme-deep-dive`). This flow zooms in on the workspace-level
// inheritance: set once, every new doc starts there.
//
// Runs on desktop AND mobile. The Settings tab is added to the
// workspace UTabs unconditionally; the preset grid + the new-doc
// dialog's theme question both reflow gracefully under `<sm`. Mobile
// shows one preset card per row instead of three; the highlight on
// the selected card + the assertion against the persisted
// defaultTheme are identical to desktop.
test('Set a default theme for your workspace', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login + create a workspace through the API. The story is the
  // theme-default mechanic; creating the workspace via the UI is
  // its own flow (`workspace-tour`).
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Brand library' }
  })
  if (!wsRes.ok()) {
    throw new Error(`[workspace-default-theme] create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  const ws = await wsRes.json() as { workspaceId: string }
  await page.goto(`/w/${ws.workspaceId}`)
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  await flow.heading('Set a default theme for your workspace', 3)
  await flow.narrate(
    'Each workspace can pick the theme every new doc starts with. '
    + 'Admins set it once; every member who starts a blank doc in '
    + 'this workspace gets that design. They can still pick a '
    + 'template with its own design, but the baseline is yours.'
  )

  // Open the Settings tab
  await flow.click(
    'Open the Settings tab',
    page.getByRole('tab', { name: /^settings$/i }),
    {
      annotations: [
        { label: 'Settings tab', selector: '[role="tab"]:has-text("Settings")', kind: 'arrow' }
      ],
      result: 'The settings panel opens with the workspace default theme.',
      after: () => page.locator('[data-testid="workspace-default-theme-clear"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ASSERTION: the "use markoto" clear card is highlighted because
  // a fresh workspace has no default theme set.
  const clearCard = page.locator('[data-testid="workspace-default-theme-clear"]')
  await expect(clearCard).toBeVisible()

  // Pick the Corporate report preset
  await flow.heading('Pick a preset', 3)
  await flow.narrate(
    'The grid lists every built-in preset (and any themes you\'ve '
    + 'saved personally). Click a card to set it as the workspace '
    + 'default: the change persists immediately, no save button.'
  )

  await flow.click(
    'Pick the Corporate report preset',
    page.locator('[data-testid="workspace-default-theme-preset-business-report"]'),
    {
      result: 'The Corporate report card is now selected, every blank doc in this workspace starts with this design.',
      annotations: [
        { label: 'Corporate report preset', selector: '[data-testid="workspace-default-theme-preset-business-report"]', kind: 'arrow' }
      ],
      // The pick saves immediately, wait until the server has it.
      after: () => expect.poll(async () => {
        const res = await page.request.get(`/api/workspaces/${ws.workspaceId}`)
        const body: unknown = res.ok() ? await res.json() : null
        return JSON.stringify(body)
      }, { timeout: 10_000 }).toMatch(/source serif/i)
    }
  )

  // ASSERTION: server persisted the choice (PATCH /api/workspaces/:wsId).
  // GET /api/workspaces/:wsId returns `{ workspace: {...}, documents,
  // members }`: defaultTheme is nested under `workspace`.
  const wsCheck = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    workspace: { defaultTheme?: { headings?: { font?: string } } | null }
  }
  // The Corporate report preset's heading font is Source Serif 4, a
  // marker we can read back. We don't assert the whole theme
  // (would couple this test to the preset's exact JSON shape).
  expect(wsCheck.workspace.defaultTheme).toBeTruthy()
  expect(wsCheck.workspace.defaultTheme?.headings?.font).toMatch(/source serif/i)

  // Create a new doc, see the inheritance
  await flow.heading('Create a blank doc, it starts in your default', 3)
  await flow.narrate(
    'Hit "+ New document" in the workspace. Under Template, Blank is a '
    + 'page in the workspace design, Corporate report, your pick. The '
    + 'other templates bring a design of their own; the theme panel '
    + 'switches any document to another one later.'
  )

  // Switch back to the Documents tab so the workspace-level "+ New
  // document" button is in view.
  // Close the "Default theme updated" toast first, it would sit on
  // the new-document dialog in the next frames.
  await editor.page.dismissToasts()
  await page.getByRole('tab', { name: /^documents$/i }).click()
  await page.locator('[data-testid="workspace-new-document"]').waitFor({ state: 'visible', timeout: 5_000 })

  await flow.click(
    'Click "+ New document"',
    page.locator('[data-testid="workspace-new-document"]'),
    {
      result: 'The new-doc dialog opens.',
      after: () => editor.page.waitForNewDocDialog()
    }
  )

  await flow.click(
    'Open "Template"',
    editor.page.newDocDialog.section('template'),
    {
      result: 'The templates open.',
      after: () => editor.page.openNewDocSection('template')
    }
  )

  const blankCard = editor.page.newDocDialog.templateCard('blank')
  await flow.click(
    'Pick "Blank"',
    blankCard,
    {
      result: 'Blank is selected: an empty page in the workspace design.',
      after: async () => {
        await expect(blankCard).toHaveAttribute('aria-pressed', 'true')
      }
    }
  )

  // ASSERTION: Blank names the workspace default, on its card and in
  // the Template row's summary.
  await expect(blankCard).toContainText('Corporate report')
  await expect(editor.page.newDocDialog.summary('template')).toHaveText('Blank · Corporate report')
  await expect(page.locator('[data-testid^="newdoc-template-card-"][aria-pressed="true"]')).toHaveCount(1)
  await blankCard.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))
  await expect(blankCard).toBeInViewport()

  await flow.shot(
    'Blank starts in the workspace default: Corporate report.',
    {
      hero: true,
      highlights: [
        { label: 'Workspace default', selector: '[data-testid="newdoc-template-card-blank"]' }
      ]
    }
  )

  // ASSERTION: the created document has the workspace design.
  await editor.page.clickCreateAndPassGate(editor.page.newDocDialog.submitCreate)
  await page.waitForURL(/\/d\/[^/]+/)
  const docId = /\/d\/([^/?#]+)/.exec(page.url())?.[1]
  const token = await page.request.get(`/api/docs/${docId}/token`).then(r => r.json()) as { theme?: { headings?: { font?: string } } }
  expect(token.theme?.headings?.font).toMatch(/source serif/i)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Members can still override the workspace default per-doc, here\'s how preset switching works in the editor'
  })
})
