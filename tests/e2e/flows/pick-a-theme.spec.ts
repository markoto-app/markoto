import { test, expect } from '../fixtures/flow'

// Tier 1: "Pick a theme that fits your document".
//
// User-job: a writer wants their document to LOOK right — typography,
// page color, headings, the works — without learning CSS or fighting
// per-doc settings. Job done when they've previewed the markoto theme,
// switched to a different preset, watched the live preview update,
// then turned on a cover page and seen page 1 become a title sheet.
//
// What this flow is NOT: a tour of every knob in the theme panel.
// We pick FOUR moments that show what's possible — one preset switch,
// one live-preview refresh, one cover toggle, one before/after.
//
// Captioning rules under the v2 (approach + outcome) model:
//   • Imperative captions on flow.click(...) → "Click X", "Pick Y"
//   • Declarative `result` on the outcome → "X happens", "Y appears"
//   • Highlights live on outcomes only
test('Pick a theme', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup()

  // On mobile, silentSetup leaves the doc in edit-only mode. The
  // theme picker now mounts as a bottom sheet that doesn't cover
  // the editor area, so we don't need to switch to preview — but
  // for parity of "watch the preview update" outcomes, we toggle
  // preview mode via the new bottom view-mode bar so the iframe
  // exists and the assertions can read its CSS.
  if (editor.isMobile) {
    // Tap the eye icon on the mobile view-mode bar (2nd button).
    await page.locator('[data-testid="mobile-viewmode-bar"] button').nth(1).click()
    await editor.page.waitForPreviewPaginated()
  }

  // ─── Open the theme panel ──────────────────────────────────────────
  await flow.heading('Open the theme panel', 3)
  await flow.narrate(
    'Markoto opens every new document with the markoto theme — Fraunces '
    + 'editorial headings on Inter body, warm cream paper, vermillion '
    + 'accents. To explore other looks, open the theme panel from the '
    + 'right sidebar.'
  )

  await flow.click(
    'Click the Theme tab in the right sidebar',
    editor.page.sidebar.theme,
    {
      result: 'The theme panel opens — six built-in presets at the top, full controls below.',
      after: () => editor.page.theme.preset('markoto').waitFor({ state: 'visible' }),
      highlights: [
        { label: 'Built-in presets', selector: '[data-testid="theme-preset-markoto"]' }
      ]
    }
  )

  // ─── Try a different preset ────────────────────────────────────────
  await flow.heading('Try a different preset', 3)
  await flow.narrate(
    'Each preset is a complete theme — fonts, colors, page margins, '
    + 'table styling, even cover-page layout. Click a card to apply '
    + 'it wholesale. The live preview updates instantly so you can '
    + 'compare without committing.'
  )

  await flow.click(
    'Click "Academic Paper" to switch to a journal-style two-column layout',
    editor.page.theme.preset('academic'),
    {
      result: 'Body text becomes a serif (Source Serif 4), columns split, '
        + 'and the preview repaginates with academic-paper proportions.',
      after: async () => {
        // Wait for the preview to repaginate. The simplest "wait" is a
        // short pause + a check that the iframe stylesheet contains
        // the new body font — but the iframe selector model is fragile
        // across browsers, so we just wait a paginate cycle.
        await page.waitForTimeout(1500)
        await editor.page.waitForPreviewPaginated()
      }
    }
  )

  // ASSERTION: the academic preset's brand color (#1e3a8a navy) is now
  // the doc's brand. Reach into the preview iframe + check the CSS var.
  const academicBrand = await page.evaluate(() => {
    const iframe = document.querySelector('iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    const style = Array.from(doc?.querySelectorAll('style') ?? [])
      .find(s => (s.textContent ?? '').includes('--doc-brand'))
    return style?.textContent?.match(/--doc-brand:\s*(#[0-9a-fA-F]+)/)?.[1] ?? null
  })
  expect(academicBrand?.toLowerCase()).toBe('#1e3a8a')

  // ─── Switch back to markoto ────────────────────────────────────────
  await flow.heading('Switch back to markoto', 3)
  await flow.narrate(
    'No commitment. Click any preset to switch — your text stays put, '
    + 'only the styling changes. We\'re going back to markoto for the '
    + 'rest of this tour.'
  )

  await flow.click(
    'Click "markoto" to return to the brand default',
    editor.page.theme.preset('markoto'),
    {
      result: 'Cream paper, Fraunces headings, the asterism scene break — back.',
      after: async () => {
        await page.waitForTimeout(1500)
        await editor.page.waitForPreviewPaginated()
      },
      highlights: [
        { label: 'Asterism scene break', selector: 'iframe' }
      ]
    }
  )

  // ASSERTION: markoto's brand color (#B5371F shu) is back.
  const markotoBrand = await page.evaluate(() => {
    const iframe = document.querySelector('iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    const style = Array.from(doc?.querySelectorAll('style') ?? [])
      .find(s => (s.textContent ?? '').includes('--doc-brand'))
    return style?.textContent?.match(/--doc-brand:\s*(#[0-9a-fA-F]+)/)?.[1] ?? null
  })
  expect(markotoBrand?.toUpperCase()).toBe('#B5371F')

  // ─── Add a cover page ──────────────────────────────────────────────
  await flow.heading('Add a cover page', 3)
  await flow.narrate(
    'A cover page turns page 1 into a dedicated title sheet — your '
    + 'document title centered, the date below, and no running header '
    + 'or page number. Toggle it from the Cover page section.'
  )

  // Open the cover-page accordion first.
  await flow.click(
    'Click "Cover page" to expand the section',
    editor.page.theme.coverSection,
    {
      result: 'Cover-page controls appear — toggle, layout picker, ' +
        'subtitle/author/date switches.',
      after: () => editor.page.theme.coverEnabledSwitch.waitFor({ state: 'visible' })
    }
  )

  // ASSERTION: the cover toggle is already on (markoto preset has cover.enabled=true).
  const coverInitiallyEnabled = await editor.page.theme.coverEnabledSwitch.getAttribute('data-state')
  expect(['checked', 'on', 'true'].some(v => coverInitiallyEnabled === v)).toBe(true)

  // For the demo, toggle off then on so the user sees the live cover-page
  // appear. Otherwise nothing visible happens (cover was already on).
  await flow.click(
    'Toggle the cover off to see the document without it',
    editor.page.theme.coverEnabledSwitch,
    {
      result: 'Page 1 becomes the body content — title moves into the running header.',
      after: async () => {
        await page.waitForTimeout(1500)
        await editor.page.waitForPreviewPaginated()
      }
    }
  )

  await flow.click(
    'Toggle the cover back on',
    editor.page.theme.coverEnabledSwitch,
    {
      result: 'Page 1 is now a dedicated title sheet — Fraunces title centered, ' +
        'date underneath, no header / footer running text.',
      after: async () => {
        await page.waitForTimeout(1500)
        await editor.page.waitForPreviewPaginated()
      },
      highlights: [
        { label: 'Cover page', selector: 'iframe' }
      ]
    }
  )

  // ASSERTION: the cover element exists in the preview iframe.
  const coverInDom = await page.evaluate(() => {
    const iframe = document.querySelector('iframe') as HTMLIFrameElement | null
    return !!iframe?.contentDocument?.querySelector('.markoto-cover')
  })
  expect(coverInDom).toBe(true)
})
