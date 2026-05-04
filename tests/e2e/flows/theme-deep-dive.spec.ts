import { test, expect } from '../fixtures/flow'

// Tier 2: "Tune your typography, colors, and details".
//
// User-job: a writer landed on a preset that's CLOSE but not quite —
// the body font reads a bit small, the brand color clashes with the
// doc's subject, the first paragraph wants a drop cap. Job done when
// they've reached past the preset cards into the per-section
// accordions, changed three categorically-different dials
// (typography, body flourish, colour), and watched the live preview
// repaint after each.
//
// Why a Tier-2 flow: `pick-a-theme` (Tier 1) covers preset-switching
// + cover toggle as the entry path. The per-section editing surface
// (15 accordions, dozens of fields, three font pickers, a colour
// picker, sliders, switches) is where markoto's typography
// philosophy actually lives.
//
// Desktop only: every change is visually validated by the preview
// iframe re-paginating. The iframe is hidden below `sm`.
test('Tune your typography and colors', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Theme editing pairs the form with the live preview iframe;'
    + ' the preview is hidden on mobile so half the demo is invisible.'
  )
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.page.createBlankDocWithTitle('Field guide to typography')

  // Disable the cover so the preview's page 1 is the body — the
  // body dials are what this flow is showing off, and a cover sheet
  // hides them on first paint.
  await editor.page.disableCoverPage()

  // Type two paragraphs into the editor so drop-cap / body-font
  // changes are visible. CodeMirror is the focused surface after
  // the dialog closes; type into the editor area.
  const editorArea = page.locator('.cm-content').first()
  await editorArea.click()
  await editorArea.pressSequentially(
    'Long-form writing rewards a careful theme — typography that '
    + 'breathes, a colour palette that fades behind the words, '
    + 'and one or two flourishes that signal craft without '
    + 'shouting for attention.\n\n'
    + 'A theme editor is for the moments when a preset is close '
    + 'but not right. Reach in, change three things, watch the '
    + 'page repaint.'
  )
  await editor.page.switchToSplitView()
  await editor.page.waitForPreviewPaginated()

  await flow.heading('Tune your typography and colors', 3)
  await flow.narrate(
    'Six built-in presets get you to a polished baseline in one '
    + 'click. The accordion below the preset cards is where you '
    + 'tune past the baseline: 15 sections (page, body, headings, '
    + 'colour, tables, code, ToC, mermaid, alerts, header, footer…) '
    + 'with the live preview repaginating after every dial. We\'ll '
    + 'change a body font, turn on a drop cap, and swap the brand '
    + 'colour.'
  )

  // ─── Open the theme panel + the Body accordion ──────────────────
  await flow.click(
    'Open the theme panel',
    editor.page.sidebar.theme,
    {
      annotations: [
        { label: 'theme tab', selector: '[data-testid="sidebar-tab-theme"]', kind: 'arrow' }
      ],
      result: 'The theme panel opens — preset cards on top, the per-section accordion below.'
    }
  )

  // The accordion section labels come from the theme i18n bundle.
  // "Body text" matches `theme.section.body` ("Body text") exactly —
  // a bare /body/ regex would also match the menubar's "Body" item
  // and other toolbar surfaces.
  const bodySection = page.getByRole('button', { name: /^body text$/i }).first()
  await flow.click(
    'Open the Body section',
    bodySection,
    {
      result: 'The Body editor expands — font, size, line height, colour, and the drop-cap switch.',
      after: () => page.locator('[data-testid="theme-body-font-select"]').waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  // ─── Turn on the drop cap ───────────────────────────────────────
  await flow.heading('Turn on a drop cap', 3)
  await flow.narrate(
    'A drop cap on the first paragraph is the typographic signal '
    + 'for "this is a real piece of writing, not a memo". markoto '
    + 'renders it via CSS `:first-letter` + `initial-letter` so '
    + 'the descender hangs against the baseline of the second line '
    + 'cleanly across browsers.'
  )

  // Use flow.hover for the approach screenshot, then dispatch a
  // real click via .click({ force: true }) ourselves. flow.click
  // routes through Playwright's actionability checks which (on
  // Reka UI's animated SwitchRoot) sometimes resolve "stable" while
  // the underlying button still has `pointer-events: none` from a
  // mid-transition state. Forcing the click skips the readiness
  // probe and lets the next assertion (data-state=checked) verify
  // the user-visible result instead.
  const dropCapSwitch = page.locator('[data-testid="theme-body-drop-cap-switch"]')
  await flow.click(
    'Flip the drop-cap switch',
    dropCapSwitch,
    {
      result: 'The first letter of paragraph 1 grows to span two lines — drop cap engaged.',
      after: async () => {
        // Reka UI's SwitchRoot toggles state on click but the
        // attribute write lags one tick behind a synthetic click.
        // Wait for the state flip; if it didn't take, retry once.
        try {
          await expect(dropCapSwitch).toHaveAttribute('data-state', 'checked', { timeout: 1_500 })
        } catch {
          await dropCapSwitch.click({ force: true })
          await expect(dropCapSwitch).toHaveAttribute('data-state', 'checked', { timeout: 3_000 })
        }
        await page.waitForTimeout(900)
      }
    }
  )

  // ─── Glance at the Colour section ───────────────────────────────
  await flow.heading('Brand colour + secondary', 3)
  await flow.narrate(
    'The Colour section behind another accordion holds the brand '
    + 'and secondary colours — the two paints that drive links, '
    + 'marks, header bands, and decorative chrome across every '
    + 'preset. Click the swatch to open a picker; paste any hex. '
    + 'We won\'t cover the picker UI here (UColorPicker is its own '
    + 'tour) — the takeaway is: every visual decision in markoto '
    + 'has a knob in this panel.'
  )

  // "Colors" matches `theme.section.color` ("Colors") exactly.
  const colorSection = page.getByRole('button', { name: /^colors$/i }).first()
  await flow.click(
    'Open the Colour section',
    colorSection,
    {
      hero: true,
      result: 'The colour editor expands — brand + secondary, each behind a swatch.',
      after: () => page.locator('[data-testid="theme-color-brand-trigger"]').waitFor({ state: 'visible', timeout: 3_000 }),
      highlights: [
        { label: 'Brand colour swatch', selector: '[data-testid="theme-color-brand-trigger"]' }
      ]
    }
  )

  // ASSERTION: the theme persisted the drop-cap change. The PUT
  // /meta is debounced 800 ms after the last theme change, so poll
  // for up to 5 s instead of single-shotting (the switch toggle +
  // colour-section open + brand-trigger click all happen within a
  // few hundred ms of each other and the debounce window slides).
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  await expect.poll(
    async () => {
      const m = await page.request.get(`/api/docs/${docId}/meta`).then(r => r.json()) as {
        theme: { body: { dropCap: boolean } }
      }
      return m.theme.body.dropCap
    },
    { timeout: 5_000 }
  ).toBe(true)

  flow.next({
    slug: 'save-your-custom-theme',
    why: 'Once you\'ve dialled it in, save the whole theme as a preset to reuse it'
  })
})
