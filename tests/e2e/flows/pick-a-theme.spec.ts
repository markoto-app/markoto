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
// Runs on desktop AND mobile. The body already has `editor.isMobile`
// branches that route through the bottom-tab-bar Theme entry, skip
// the iframe-only brand-color assertions (mobile is edit-only — no
// preview iframe), and skip `waitForPreviewPaginated` calls. The
// payoff visual on mobile is the theme-panel UI rather than the
// repaginated preview, but the asserted server state (preset
// selection, cover toggle) is identical.
//
// (Until Phase 6.30 there was a `pick-a-theme-mobile.spec.ts`
//  sibling carrying mobile-specific narration. Deleted as part of the
//  "single canonical spec per feature" cleanup — Flow.vue auto-routes
//  variants by viewport via `useMediaQuery('(max-width: 639px)')`.)
test('Pick a theme', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup()

  // Title + intro before any captured shots.
  await flow.heading('Pick a theme that fits your document', 3)
  await flow.narrate(
    'Every markoto document carries its own theme — fonts, colors, '
    + 'page margins, table styling, even cover-page layout. The same '
    + 'theme drives the live preview AND the PDF export, so what you '
    + 'see in the right pane is what you ship.'
  )

  // ─── Open the theme panel ──────────────────────────────────────────
  await flow.heading('Open the theme panel', 3)
  await flow.narrate(
    'Markoto opens every new document with the markoto theme — Fraunces '
    + 'editorial headings on Inter body, warm cream paper, vermillion '
    + 'accents. To explore other looks, open the theme panel from the '
    + 'right sidebar.'
  )

  if (editor.isMobile) {
    // Mobile UI redesign (2026 mobile sprint): the panel-picker
    // dropdown was replaced by a fixed bottom MobileTabBar that
    // surfaces every drawer as an always-visible tab. The Theme
    // tab is one of seven (Editor / Mic / Document / Comments /
    // Activity / Theme / Knowledge), small in the bottom strip —
    // arrow annotation directs the reader to the right one.
    await flow.click(
      'Tap the Theme tab on the bottom bar',
      page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Theme"]'),
      {
        annotations: [
          { label: 'theme tab', selector: '[data-testid="mobile-tab-bar"] button[aria-label="Theme"]', kind: 'arrow' }
        ],
        result: 'The theme drawer slides up from the bottom — six presets at the top, controls below.',
        after: () => editor.page.theme.preset('markoto').waitFor({ state: 'visible' }),
        highlights: [
          { label: 'Built-in presets', selector: '[data-testid="theme-preset-markoto"]' }
        ]
      }
    )
  } else {
    await flow.click(
      'Click the Theme tab in the right sidebar',
      editor.page.sidebar.theme,
      {
        // Direction-anchor the Theme tab — it's one of four icon-only
        // sidebar tabs (Activity / Theme / Knowledge / Comments) and
        // a first-time reader scanning right-to-left needs help
        // landing on the right one.
        annotations: [
          { label: 'theme tab', selector: 'button[aria-label*="theme" i]', kind: 'arrow' }
        ],
        result: 'The theme panel opens — six built-in presets at the top, full controls below.',
        after: () => editor.page.theme.preset('markoto').waitFor({ state: 'visible' }),
        highlights: [
          { label: 'Built-in presets', selector: '[data-testid="theme-preset-markoto"]' }
        ]
      }
    )
  }

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
      // Mobile: theme presets render inside the BottomSheet portal;
      // Reka's overlay intercepts pointer events at Playwright's
      // coordinate layer despite the target being visible + stable.
      // See `tests/e2e/AGENTS.md` "Bottom-sheet portal interception".
      force: editor.isMobile,
      result: 'Body text becomes a serif (Source Serif 4), columns split, '
        + 'and the preview repaginates with academic-paper proportions.',
      after: async () => {
        // Wait for the preview to repaginate. The simplest "wait" is a
        // short pause + a check that the iframe stylesheet contains
        // the new body font — but the iframe selector model is fragile
        // across browsers, so we just wait a paginate cycle.
        await page.waitForTimeout(1500)
        // On mobile the cover sheet stays hidden through repeated
        // paged.js zoom recalcs. Skip the visibility wait — by this
        // point the CSS has been swapped and the assertion below
        // reads the served stylesheet, not the rendered DOM.
        if (!editor.isMobile) {
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  // ASSERTION: the academic preset's brand color (#1e3a8a navy) is now
  // the doc's brand. Reach into the preview iframe + check the CSS var.
  // Skipped on mobile — paged.js's mobile pipeline doesn't always
  // mount the theme stylesheet by the time we can read it; the CSS
  // contract is verified by the unit tests in themeToCss.test.ts.
  if (!editor.isMobile) {
    // The preview runs in an opaque-origin iframe (no contentDocument
    // access from the page) — evaluate inside the frame instead.
    const academicBrand = await editor.page.previewRoot().evaluate(() => {
      const style = Array.from(document.querySelectorAll('style'))
        .find(s => (s.textContent ?? '').includes('--doc-brand'))
      return style?.textContent?.match(/--doc-brand:\s*(#[0-9a-fA-F]+)/)?.[1] ?? null
    })
    expect(academicBrand?.toLowerCase()).toBe('#1e3a8a')
  }

  // ─── Switch back to markoto ────────────────────────────────────────
  await flow.heading('Switch back to markoto', 3)
  await flow.narrate(
    'No commitment. Click any preset to switch — your text stays put, '
    + 'only the styling changes. We\'re going back to markoto for the '
    + 'rest of this tour.'
  )

  // On mobile the markoto preset card click sometimes hangs after
  // the hover-screenshot (the academic preset's selection-ring
  // re-render briefly captures pointer events on the card grid).
  // Force-click bypasses the actionability re-check.
  if (editor.isMobile) {
    await flow.step(
      'Tap "markoto" to return to the brand default',
      async () => {
        // DOM-level click — bypasses Playwright's coordinate routing
        // (the preset card lives inside the BottomSheet portal where
        // Reka's overlay intercepts AND can leave the target outside
        // the viewport calculation). `click({ force: true })` skips
        // actionability but still requires viewport coords; evaluate
        // doesn't. Workaround #2 from `tests/e2e/AGENTS.md`.
        await editor.page.theme.preset('markoto').evaluate((el: HTMLElement) => el.click())
        await page.waitForTimeout(1500)
      },
      { result: 'Back to the brand default — cream paper, Fraunces headings.' }
    )
  } else {
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
  }

  // ASSERTION: markoto's brand color (#B5371F shu) is back. Skipped
  // on mobile (same reason as the academic check above).
  if (!editor.isMobile) {
    const markotoBrand = await editor.page.previewRoot().evaluate(() => {
      const style = Array.from(document.querySelectorAll('style'))
        .find(s => (s.textContent ?? '').includes('--doc-brand'))
      return style?.textContent?.match(/--doc-brand:\s*(#[0-9a-fA-F]+)/)?.[1] ?? null
    })
    expect(markotoBrand?.toUpperCase()).toBe('#B5371F')
  }

  // ─── Add a cover page ──────────────────────────────────────────────
  // Mobile stops the narrative here: the cover-toggle accordion +
  // toggle + visible cover render all live in `cover-page-editor.spec.ts`
  // which already runs on both variants. Pick-a-theme's load-bearing
  // mobile assertion is the preset-switch (preset selection persists
  // server-side via PUT /meta) — covered above. Avoiding the accordion
  // dance here also dodges a Reka Accordion + bottom-sheet pointer-
  // routing rabbit hole that doesn't earn its keep when there's a
  // dedicated spec for the cover-page UX.
  if (editor.isMobile) {
    flow.next({
      slug: 'edit-your-cover-page',
      why: 'Now make the cover sheet feel like yours — layout, subtitle, author byline'
    })
    return
  }

  await flow.heading('Add a cover page', 3)
  await flow.narrate(
    'A cover page turns page 1 into a dedicated title sheet — your '
    + 'document title centered, the date below, and no running header '
    + 'or page number. Toggle it from the Cover page section.'
  )

  await flow.click(
    'Click "Cover page" to expand the section',
    editor.page.theme.coverSection,
    {
      result: 'Cover-page controls appear — toggle, layout picker, '
        + 'subtitle/author/date switches.',
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
        if (!editor.isMobile) {
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  await flow.click(
    'Toggle the cover back on',
    editor.page.theme.coverEnabledSwitch,
    {
      // Hero outcome: a dedicated title sheet is the moment a
      // markdown doc reads as a publishable artefact. This is the
      // "look what I made" frame for the theme system.
      hero: true,
      result: 'Page 1 is now a dedicated title sheet — Fraunces title centered, '
        + 'date underneath, no header / footer running text.',
      after: async () => {
        await page.waitForTimeout(1500)
        if (!editor.isMobile) {
          await editor.page.waitForPreviewPaginated()
        }
      },
      highlights: [
        { label: 'Cover page', selector: 'iframe' }
      ]
    }
  )

  // ASSERTION: the cover element exists in the preview iframe.
  // Mobile path skipped — paged.js mobile pipeline timing makes the
  // DOM check flaky; coverHtml.test.ts asserts the same contract.
  if (!editor.isMobile) {
    const coverInDom = await editor.page.previewRoot().evaluate(() => !!document.querySelector('.markoto-cover'))
    expect(coverInDom).toBe(true)
  }

  // Forward route: theme is the "make it pretty" track; AI is the
  // "make it write itself" track. After picking a theme, asking
  // the AI to fill a section is the most natural next step toward
  // a finished doc. (Routes here rather than to polished-pdf
  // because polished-pdf isn't built yet — Tier-1 TODO.)
  flow.next({
    slug: 'ai-prompt-bar',
    why: 'Now ask the AI to fill in a section so the doc writes itself'
  })
})
