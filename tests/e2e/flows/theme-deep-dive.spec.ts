import { test, expect } from '../fixtures/flow'

// Tier 2: "Tune your typography, colors, and details".
//
// User-job: a writer landed on a preset that's CLOSE but not quite —
// they want a serif for long reading, and to know where the colours and
// the drop cap live. Job done when they've reached past the preset cards
// into the per-section settings, changed the body font, and seen the
// preview re-render in it (hero = the restyled preview, not the panel).
//
// Why a Tier-2 flow: `pick-a-theme` (Tier 1) covers preset-switching
// + cover toggle as the entry path. The per-section editing surface
// is where markoto's typography actually lives.
//
// Runs on desktop AND mobile. Mobile is edit-only (no preview), so its
// payoff is the saved setting; the assertion (server-persisted
// `theme.body.font`) is the same on both.

const BODY = '# Field guide to typography\n\n'
  + 'Long-form writing rewards a careful theme: type that breathes, a '
  + 'colour palette that fades behind the words, and one or two '
  + 'flourishes that signal craft without shouting for attention. Most '
  + 'readers never notice any of it, which is exactly the point.\n\n'
  + 'A theme editor is for the moments when a preset is close but not '
  + 'right. Reach in, change one or two things, and watch the page '
  + 're-render.\n\n'
  + '## Choosing a body font\n\n'
  + 'Serifs guide the eye along long lines of print; sans-serifs stay '
  + 'crisp at small sizes on screen. Pick for the medium your readers '
  + 'will use most.\n'

test('Tune your typography and colors', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Real paragraphs under a heading, cover off: the body font and the
  // drop cap are what this flow shows, and a cover would hide them.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Field guide to typography', body: BODY, cover: false })

  const savedBodyFont = async () => {
    const res = await page.request.get(`/api/docs/${editor.page.currentDocId()}/meta`)
    return (await res.json() as { theme: { body: { font: string } } }).theme.body.font
  }

  await flow.heading('Tune your typography and colors', 3)
  await flow.narrate(
    'Seven built-in presets get you to a polished starting point in one '
    + 'click. Below the preset cards, the theme panel has a section for '
    + 'every detail: page, body text, headings, colours, tables, code, '
    + 'table of contents, diagrams, header and footer. Every change shows '
    + 'up in the preview right away. Here: a serif body font for long reading.'
  )

  // ─── Open the theme panel + the Body section ────────────────────
  const themeTab = editor.isMobile
    ? editor.page.mobileTabs.theme
    : editor.page.sidebar.theme

  await flow.click(
    editor.isMobile ? 'Tap the Theme tab on the bottom bar' : 'Open the theme panel',
    themeTab,
    {
      annotations: editor.isMobile
        ? []
        : [{ label: 'theme tab', selector: '[data-testid="sidebar-tab-theme"]', kind: 'arrow' }],
      result: 'The theme panel opens: preset cards at the top, a section per detail below.'
    }
  )

  // "Body text" matches `theme.section.body` exactly — a bare /body/
  // regex would also match the menubar's "Body" item.
  const bodySection = page.getByRole('button', { name: /^body text$/i }).first()
  await flow.click(
    'Open the Body text section',
    bodySection,
    {
      // Mobile: accordion lives inside BottomSheet portal; pointer
      // routing is intercepted. See `tests/e2e/AGENTS.md`.
      force: editor.isMobile,
      result: 'Font, size, line height, colour, alignment, and the drop-cap switch.',
      after: () => page.locator('[data-testid="theme-body-font-select"]').waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  // The markoto theme ships with the drop cap on (asserted, not toggled:
  // it is what the reader sees on the first paragraph in the preview).
  await expect(page.locator('[data-testid="theme-body-drop-cap-switch"]')).toHaveAttribute('data-state', 'checked')

  // ─── Change the body font ───────────────────────────────────────
  await flow.heading('Switch the body text to a serif', 3)
  await flow.narrate(
    'The font list is grouped into sans-serif and serif families, each '
    + 'shown in its own typeface. Headings keep their own font, so only '
    + 'the running text changes.'
  )

  const fontSelect = page.locator('[data-testid="theme-body-font-select"]')
  const serifOption = page.getByRole('option', { name: /^Source Serif 4$/ }).first()
  await flow.click(
    'Open the font list',
    fontSelect,
    {
      force: editor.isMobile,
      result: 'Every font markoto offers, previewed in its own typeface.',
      after: () => serifOption.waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  await flow.click(
    'Pick "Source Serif 4"',
    serifOption,
    {
      force: editor.isMobile,
      hero: !editor.isMobile,
      result: editor.isMobile
        ? 'The body font is now Source Serif 4, in the preview and in the PDF.'
        : 'The preview re-renders: the paragraphs are now set in Source Serif 4, '
          + 'with the drop cap opening the first one.',
      after: async () => {
        await expect.poll(savedBodyFont).toBe('Source Serif 4')
        if (!editor.isMobile) {
          // The preview's first paragraph is rendered in the new font.
          const firstParagraph = editor.page.previewRoot().locator('#mount .pagedjs_page p').first()
          await expect.poll(() => firstParagraph.evaluate(el => getComputedStyle(el).fontFamily)).toContain('Source Serif 4')
          await expect(editor.page.previewRoot().locator('#mount .markoto-dropcap')).toHaveCount(1)
          await editor.page.scrollPreviewTo('h1')
        }
      },
      highlights: editor.isMobile ? [] : [{ label: 'Restyled preview', selector: 'iframe' }]
    }
  )

  // ─── Where the colours live ─────────────────────────────────────
  await flow.heading('Colours', 3)
  await flow.narrate(
    'The Colors section holds the brand and secondary colours: they paint '
    + 'links, highlights, header bands and other accents. Click a swatch '
    + 'to open a colour picker, or paste any hex value.'
  )

  // "Colors" matches `theme.section.color` exactly.
  const colorSection = page.getByRole('button', { name: /^colors$/i }).first()
  await flow.click(
    'Open the Colors section',
    colorSection,
    {
      force: editor.isMobile,
      hero: editor.isMobile,
      result: 'Brand and secondary colour, each behind a swatch.',
      after: () => page.locator('[data-testid="theme-color-brand-trigger"]').waitFor({ state: 'visible', timeout: 3_000 }),
      highlights: [
        { label: 'Brand colour', selector: '[data-testid="theme-color-brand-trigger"]' }
      ]
    }
  )

  // ASSERTION: the font choice is saved with the document.
  expect(await savedBodyFont()).toBe('Source Serif 4')

  flow.next({
    slug: 'save-your-custom-theme-as-a-preset',
    why: 'Save the tuned theme as a preset to reuse it on your next document'
  })
})
