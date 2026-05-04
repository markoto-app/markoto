import { test, expect } from '../fixtures/flow'

// Tier 2: "Tune your typography, colors, and details".
//
// User-job: a writer landed on a preset that's CLOSE but not quite —
// the body font reads a bit small, the brand color clashes with the
// doc's subject, the first paragraph wants a drop cap. They want to
// reach into the theme and touch the dials directly without learning
// CSS or fighting per-doc settings. Job done when they've reached
// past the preset cards into the per-section accordions, changed
// three categorically-different dials (typography, color, body
// flourish), and watched the live preview repaint after each.
//
// Why a Tier-2 flow: `pick-a-theme` (Tier 1) covers preset-switching
// + cover toggle as the entry path. The per-section editing surface
// (15 accordions, dozens of fields, three font pickers, a color
// picker, sliders, switches) is where markoto's typography
// philosophy actually lives — and it stays invisible if the reader
// stops at picking a preset.
//
// Desktop only: every change is visually validated by the preview
// iframe re-paginating. The iframe is hidden below `sm` for the
// same reason the editor's split view collapses on mobile. A
// mobile-shaped sibling needs an inline-preview theme drawer that
// doesn't exist yet.
test('Tune your typography and colors', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Theme editing pairs the form with the live preview iframe;'
    + ' the preview is hidden on mobile so half the demo is invisible.'
  )
  test.setTimeout(180_000)

  // Login + create a doc with a real title and a couple of paragraphs.
  // The drop-cap toggle requires actual paragraph text to paint
  // anything visible; an empty doc would set the dial without any
  // payoff in the preview. Use a known seed body via the editor.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.page.createNewDoc()
  await editor.page.waitForNewDocDialog()
  await editor.page.newDocDialog.titleInput.fill('Field guide to typography')
  await editor.page.newDocDialog.submitBlank.click()
  await editor.page.waitForReady()

  // Disable the cover so the preview's page 1 is the body — the
  // body dials are what this flow is showing off, and a cover sheet
  // hides them on first paint.
  await editor.page.disableCoverPage()

  // Type two paragraphs into the editor so drop-cap / body-font /
  // text-align changes are visible. CodeMirror is the focused
  // surface after the dialog closes; type into the editor area.
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
    + 'change a body font, swap the brand colour, and turn on a '
    + 'drop cap.'
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

  // The Body accordion header is text-based; it sits under the
  // preset cards along with the other 14 sections. Match by
  // accessible name.
  const bodySection = page.getByRole('button', { name: /^body$/i }).first()
  await flow.click(
    'Open the Body section',
    bodySection,
    {
      annotations: [
        { label: 'Body accordion', selector: 'button:has-text("Body")', kind: 'arrow' }
      ],
      result: 'The Body editor expands — font, size, line height, colour, and the drop-cap switch.'
    }
  )

  // ─── Change the body font ───────────────────────────────────────
  await flow.heading('Change the body font', 3)
  await flow.narrate(
    'Twenty Google Fonts curated for body legibility. The dropdown '
    + 'previews each entry IN that font so you can pick by feel, '
    + 'not by name. Inter is the default; switch to Source Serif '
    + 'Pro to give the prose a literary feel.'
  )

  const bodyFontField = page.getByRole('group').filter({ hasText: /^body font$/i })
  const bodyFontTrigger = bodyFontField.locator('button').first()
  await flow.click(
    'Open the body-font picker',
    bodyFontTrigger,
    {
      result: 'Twenty fonts list — each rendered IN itself so you preview by glance.',
      after: () => page.waitForTimeout(400)
    }
  )

  // The USelectMenu lists every font as an option; pick a serif so
  // the visual change vs Inter is unmistakable.
  const sourceSerifOption = page.getByRole('option', { name: /source serif/i }).first()
  await flow.click(
    'Pick "Source Serif 4"',
    sourceSerifOption,
    {
      result: 'The body re-renders in Source Serif — same line breaks, different feel.',
      after: () => page.waitForTimeout(900)
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

  const dropCapField = page.getByRole('group').filter({ hasText: /drop cap/i })
  const dropCapSwitch = dropCapField.getByRole('switch').first()
  await flow.click(
    'Flip the drop-cap switch',
    dropCapSwitch,
    {
      result: 'The first letter of paragraph 1 grows to span two lines — drop cap engaged.',
      after: () => page.waitForTimeout(900)
    }
  )

  // ─── Change the brand color ─────────────────────────────────────
  await flow.heading('Change the brand colour', 3)
  await flow.narrate(
    'The brand colour drives links, marks, header bands, and any '
    + 'preset that paints decorative chrome. Open the Colour '
    + 'section, click the swatch, paste a hex.'
  )

  // Close Body so the Colour section is on screen, then open it.
  const colorSection = page.getByRole('button', { name: /^colour$|^color$/i }).first()
  await flow.click(
    'Open the Colour section',
    colorSection,
    {
      result: 'The colour editor expands — brand + secondary, each behind a swatch.',
      after: () => page.waitForTimeout(400)
    }
  )

  const brandField = page.getByRole('group').filter({ hasText: /^brand colour$|^brand color$/i })
  const brandTrigger = brandField.locator('button').first()
  await flow.click(
    'Open the brand-colour picker',
    brandTrigger,
    {
      result: 'A colour picker pops over the swatch; pick or paste any hex.',
      after: () => page.waitForTimeout(400)
    }
  )

  // The UColorPicker exposes the hex via an editable input. Find
  // the textbox in the popover and type a navy blue. Targeting the
  // *last* textbox in the page picks up the popover's input over
  // any earlier ones (subtitle field on the cover accordion etc.).
  const hexInput = page.locator('input[type="text"]').last()
  await hexInput.fill('#1e3a8a')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(900)

  await flow.shot(
    'Brand colour swapped to navy. The body type is Source Serif, '
    + 'the first paragraph carries a drop cap, the brand colour '
    + 'reads on every link and marker. Three dials, one cohesive '
    + 'theme — and every change persisted to the doc.',
    {
      hero: true,
      highlights: [
        { label: 'Live preview — three changes compounding', selector: 'iframe' }
      ]
    }
  )

  // ASSERTION: the theme persisted with our three changes.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const meta = await page.request.get(`/api/docs/${docId}/meta`).then(r => r.json()) as {
    theme: {
      body: { font: string, dropCap: boolean }
      color: { brand: string }
    }
  }
  expect(meta.theme.body.font).toMatch(/Source Serif/i)
  expect(meta.theme.body.dropCap).toBe(true)
  expect(meta.theme.color.brand.toLowerCase()).toBe('#1e3a8a')

  flow.next({
    slug: 'save-your-custom-theme',
    why: 'Once you\'ve dialled it in, save the whole theme as a preset to reuse it'
  })
})
