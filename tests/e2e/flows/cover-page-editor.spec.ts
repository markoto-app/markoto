import { test, expect } from '../fixtures/flow'

// Tier 2: "Make a real title page".
//
// User-job: a writer wants their PDF to open with a proper title
// sheet — the document name above the fold, a subtitle line, their
// name, the date — instead of the body text starting on page 1.
// markoto's cover page is on by default with the markoto preset, but
// the four layout choices + the per-field toggles + the size knobs
// stay invisible until the reader opens the cover-page accordion in
// the theme panel. Job done when they've cycled through a few
// layouts, added a subtitle, an author, and seen the live preview
// re-render after every change.
//
// Why a Tier-2 flow: `pick-a-theme` (Tier 1) covers the cover
// ON/OFF master switch but stops there; the deep customization
// surface (layout, alignment, title size, subtitle text, author
// list, date toggle) is the longest accordion in the theme panel
// AND the one that's most often "I didn't know markoto could do
// that" feedback.
//
// Desktop only: half the visual story is the live-preview iframe
// re-rendering after every theme change; the iframe is hidden on
// mobile (`<sm:` viewport) by the same logic that hides it from
// the editor's split-view default. A mobile-shaped sibling would
// need a Theme drawer with an inline preview — out of scope.
test('Edit your cover page', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Cover-page editing pairs the form fields with the live preview'
    + ' iframe re-rendering on every change. The preview is hidden'
    + ' below the `sm` breakpoint, so half the demo is invisible on'
    + ' mobile. A dedicated mobile flow would need an inline-preview'
    + ' theme drawer that doesn\'t exist yet.'
  )
  test.setTimeout(120_000)

  // Login + create a doc with a title — the cover page renders the
  // title in big type, so an unnamed doc shows "Untitled" on every
  // layout and the visual contrast between layouts is muted.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.page.createNewDoc()
  // The new-doc dialog opens for logged-in users; bypass it with the
  // blank-doc shortcut so we land in the editor with the markoto
  // preset (cover.enabled = true by default).
  await editor.page.waitForNewDocDialog()
  await editor.page.newDocDialog.titleInput.fill('Q3 product launch playbook')
  await editor.page.newDocDialog.submitBlank.click()
  await editor.page.waitForReady()
  await editor.page.switchToSplitView()
  await editor.page.waitForPreviewPaginated()

  await flow.heading('Edit your cover page', 3)
  await flow.narrate(
    'Every doc starts with markoto\'s default cover page on — title '
    + 'centred, no subtitle, today\'s date below. To make the cover '
    + 'feel like YOURS, open the theme panel\'s Cover accordion. '
    + 'Four layouts (Classic / Editorial / Banner / Minimal), every '
    + 'field individually toggleable, the title size on a slider so '
    + 'short titles look as deliberate as long ones.'
  )

  // ─── Open the theme panel + the cover accordion ─────────────────
  await flow.click(
    'Open the theme panel',
    editor.page.sidebar.theme,
    {
      annotations: [
        { label: 'theme tab', selector: '[data-testid="sidebar-tab-theme"]', kind: 'arrow' }
      ],
      result: 'The theme panel opens to the preset cards + section accordions.',
      after: () => editor.page.theme.coverSection.waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  await flow.click(
    'Open the Cover page section',
    editor.page.theme.coverSection,
    {
      annotations: [
        { label: 'Cover page accordion', selector: 'button:has-text("Cover page")', kind: 'arrow' }
      ],
      result: 'The cover-page editor expands — every field on one scroll-length panel.',
      after: () => editor.page.theme.coverEnabledSwitch.waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  // ─── Switch to Editorial layout ─────────────────────────────────
  await flow.heading('Pick a layout', 3)
  await flow.narrate(
    'The default is Editorial — logo at the top, title at the ⅓ '
    + 'mark, metadata at ⅔. Try Classic to centre everything; '
    + 'Banner puts a brand-tinted band across the top; Minimal '
    + 'strips logo and metadata entirely. The preview repaginates '
    + 'after each pick.'
  )

  // The layout USelect doesn't carry a direct testid; scope by its
  // visible label inside the cover accordion. The select trigger is
  // the immediate sibling button under the form field.
  const layoutSelect = page.getByRole('group').filter({ hasText: /layout/i })
    .locator('button[role="combobox"]').first()
  await flow.click(
    'Open the layout dropdown',
    layoutSelect,
    {
      result: 'The four cover layouts list — pick one to preview it.',
      after: () => page.getByRole('option', { name: /banner/i }).first().waitFor({ state: 'visible', timeout: 3_000 })
    }
  )
  await flow.click(
    'Choose "Banner — logo + title in a brand-tinted top band"',
    page.getByRole('option', { name: /banner/i }).first(),
    {
      result: 'The cover repaints — Banner layout drops a brand-tinted band across the top of page 1.',
      after: () => page.waitForTimeout(900)
    }
  )

  // ─── Add a subtitle ─────────────────────────────────────────────
  await flow.heading('Add a subtitle line', 3)
  await flow.narrate(
    'A short line under the title — version, date, "Internal draft", '
    + 'whatever frames the doc. Subtitle is off by default; flip the '
    + 'toggle, then type. The slider controls subtitle size '
    + 'independently of the title so you can pin a quiet caption '
    + 'under a loud headline.'
  )

  const subtitleToggle = page.getByRole('group').filter({ hasText: /^show subtitle$/i })
    .getByRole('switch').first()
  await flow.click(
    'Flip the "Show subtitle" toggle on',
    subtitleToggle,
    {
      result: 'The subtitle field appears underneath, ready for input.',
      after: () => page.waitForTimeout(400)
    }
  )

  const subtitleInput = page.getByRole('group').filter({ hasText: /^subtitle$/i })
    .getByRole('textbox').first()
  await flow.type(
    'Type a subtitle line',
    subtitleInput,
    'Internal draft · v0.3 · Engineering team',
    {
      result: 'The subtitle lands on the cover, sized by the slider above.',
      after: () => page.waitForTimeout(900)
    }
  )

  // ─── Add an author ──────────────────────────────────────────────
  await flow.heading('Add an author', 3)
  await flow.narrate(
    'Authors render below the title block; add as many as you '
    + 'like (up to ten). Names are free-text — there\'s no roster '
    + 'or @-mention link, just the line that prints on the cover.'
  )

  const showAuthorsToggle = page.getByRole('group').filter({ hasText: /show authors/i })
    .getByRole('switch').first()
  await showAuthorsToggle.click()
  await page.waitForTimeout(300)

  const addAuthorBtn = page.getByRole('button', { name: /^add author$/i }).first()
  await addAuthorBtn.click()
  const firstAuthorInput = page.getByPlaceholder(/author name/i).first()
  await flow.type(
    'Type the author name',
    firstAuthorInput,
    'Maya Chen',
    {
      hero: true,
      result: 'The cover now reads: title at the top of the band, subtitle, author. The PDF will open on this page.',
      after: () => page.waitForTimeout(900),
      highlights: [
        { label: 'Live preview — page 1 is your cover', selector: 'iframe' }
      ]
    }
  )

  // ASSERTION: the theme persisted to the doc (PUT /meta lands in
  // the documents.theme JSONB). Read the meta back and check the
  // cover sub-fields landed.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const metaRes = await page.request.get(`/api/docs/${docId}/meta`)
  expect(metaRes.ok()).toBe(true)
  const meta = await metaRes.json() as { theme: { cover: {
    enabled: boolean
    layout: string
    showSubtitle: boolean
    subtitle: string
    showAuthors: boolean
    authors: string[]
  } } }
  expect(meta.theme.cover.enabled).toBe(true)
  expect(meta.theme.cover.layout).toBe('banner')
  expect(meta.theme.cover.showSubtitle).toBe(true)
  expect(meta.theme.cover.subtitle).toBe('Internal draft · v0.3 · Engineering team')
  expect(meta.theme.cover.showAuthors).toBe(true)
  expect(meta.theme.cover.authors).toContain('Maya Chen')

  flow.next({
    slug: 'save-your-custom-theme',
    why: 'Once your cover looks right, save the whole theme as a preset so the next doc starts here'
  })
})
