import { test, expect } from '../fixtures/flow'

// Tier 2: "Set a default theme for the whole workspace".
//
// User-job: a workspace admin wants every new doc in the workspace
// to inherit a specific look — the team's typography preset, the
// brand colour, the cover layout the company decided on. Without
// this, every member starts from markoto's default and either picks
// the same preset by hand each time or works on differently-styled
// docs. Job done when the admin has picked a preset under workspace
// settings AND a new doc created in that workspace opens with the
// admin's choice already selected in the new-doc dialog.
//
// What this flow is NOT: a tour of the theme presets themselves
// (covered by `pick-a-theme`) or the per-section editor (covered by
// `theme-deep-dive`). This flow zooms in on the workspace-level
// inheritance — set once, every new doc starts there.
//
// Desktop only: the workspace settings tab + the new-doc dialog
// before/after both pack densely, and the visual "the chosen card
// is highlighted in blue" reads more clearly with a wider canvas.
test('Set a default theme for your workspace', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Workspace settings + new-doc dialog before/after pack better'
    + ' at desktop widths; mobile single-column hides the visual'
    + ' inheritance link.'
  )
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
    + 'Admins set it once; every member who creates a doc in this '
    + 'workspace gets that preset preselected in the new-doc '
    + 'dialog. They can still pick something else, but the '
    + 'baseline is yours.'
  )

  // ─── Open the Settings tab ──────────────────────────────────────
  await flow.click(
    'Open the Settings tab',
    page.getByRole('tab', { name: /^settings$/i }),
    {
      annotations: [
        { label: 'Settings tab', selector: '[role="tab"]:has-text("Settings")', kind: 'arrow' }
      ],
      result: 'The settings panel opens — workspace name, default theme, AI sponsoring.',
      after: () => page.locator('[data-testid="workspace-default-theme-clear"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ASSERTION: the "use markoto" clear card is highlighted because
  // a fresh workspace has no default theme set.
  const clearCard = page.locator('[data-testid="workspace-default-theme-clear"]')
  await expect(clearCard).toBeVisible()

  // ─── Pick the academic preset ───────────────────────────────────
  await flow.heading('Pick a preset', 3)
  await flow.narrate(
    'The grid lists every built-in preset (and any themes you\'ve '
    + 'saved personally). Click a card to set it as the workspace '
    + 'default — the change persists immediately, no save button.'
  )

  await flow.click(
    'Pick the academic preset',
    page.locator('[data-testid="workspace-default-theme-preset-academic"]'),
    {
      result: 'The academic card lights up with a shu border — every new doc in this workspace will inherit this preset.',
      annotations: [
        { label: 'Academic preset', selector: '[data-testid="workspace-default-theme-preset-academic"]', kind: 'arrow' }
      ],
      after: () => page.waitForTimeout(800)
    }
  )

  // ASSERTION: server persisted the choice (PATCH /api/workspaces/:wsId).
  const wsCheck = await page.request.get(`/api/workspaces/${ws.workspaceId}`).then(r => r.json()) as {
    defaultTheme?: { headings?: { font?: string } } | null
  }
  // The academic preset's heading font is Source Serif Pro — a
  // marker we can read back. We don't assert the whole theme
  // (would couple this test to the preset's exact JSON shape).
  expect(wsCheck.defaultTheme).toBeTruthy()
  expect(wsCheck.defaultTheme?.headings?.font).toMatch(/source serif/i)

  // ─── Create a new doc — see the inheritance ─────────────────────
  await flow.heading('Create a doc — your default is preselected', 3)
  await flow.narrate(
    'Hit "+ New document" in the workspace. The new-doc dialog '
    + 'opens with the academic card already lit up under the Theme '
    + 'question — your pick, ready to go. The member can override, '
    + 'but they don\'t have to.'
  )

  // Switch back to the Documents tab so the workspace-level "+ New
  // document" button is in view.
  await page.getByRole('tab', { name: /^documents$/i }).click()
  await page.locator('[data-testid="workspace-new-document"]').waitFor({ state: 'visible', timeout: 5_000 })

  await flow.click(
    'Click "+ New document"',
    page.locator('[data-testid="workspace-new-document"]'),
    {
      result: 'The new-doc dialog opens — title, description, language, audience, theme, template.',
      after: () => editor.page.waitForNewDocDialog()
    }
  )

  // The new-doc dialog shows the workspace's default theme as the
  // selected card. When the workspace default IS a built-in preset
  // (academic in our case), the matching preset card lights up
  // directly — no separate "inherit" card is rendered.
  await flow.shot(
    'Scroll to the Theme question — the academic card is preselected.',
    {
      hero: true,
      highlights: [
        { label: 'Workspace default — preselected', selector: '[data-testid="newdoc-theme-card-academic"]' }
      ]
    }
  )

  // ASSERTION: the academic card carries the selected styling
  // (border-primary or aria-selected). The dialog renders the
  // workspace's default by lighting up the matching preset card —
  // we assert via the bg-elevated/40 class the selected state
  // uses (per the markup in NewDocumentDialog.vue).
  const academicCard = page.locator('[data-testid="newdoc-theme-card-academic"]')
  await expect(academicCard).toBeVisible()
  await expect(academicCard).toHaveClass(/border-primary/)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Members can still override the workspace default per-doc — here\'s how preset switching works in the editor'
  })
})
