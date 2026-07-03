import { test, expect } from '../fixtures/flow'

// Tier 2: "Make a real title page".
//
// User-job: a writer wants their PDF to open with a proper title
// sheet — the document name above the fold, a subtitle line, their
// name, the date — instead of the body text starting on page 1.
// Job done when they've cycled to a different cover layout, added
// a subtitle, and seen the live preview re-render after each.
//
// Why a Tier-2 flow: `pick-a-theme` (Tier 1) covers the cover ON/OFF
// master switch but stops there; the layout + subtitle + author
// editing surface is the longest accordion in the theme panel AND
// the one that's most often "I didn't know markoto could do that".
//
// Runs on desktop AND mobile. The Cover accordion + its fields
// (layout select, subtitle switch + input) live inside the same
// theme panel either way. Mobile is edit-only (`v-if="viewMode !==
// 'edit'"` keeps the preview iframe unmounted under `<sm`), so the
// "watch the cover repaint live" beat is invisible there. The
// asserted server state (`theme.cover.{enabled, layout, showSubtitle,
// subtitle}` persisted via PUT /meta) is identical.
test('Edit your cover page', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.page.createBlankDocWithTitle('Q3 product launch playbook')
  if (!editor.isMobile) {
    await editor.page.switchToSplitView()
    await editor.page.waitForPreviewPaginated()
  }

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
  // Desktop: right-sidebar Theme tab; mobile: bottom-tab-bar Theme.
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
      result: 'The theme panel opens to the preset cards + section accordions.',
      // Mobile: cover-section button lives below the sheet's visible
      // viewport (sheet has internal scroll). `state: 'visible'` would
      // require it to be on-screen; `attached` is enough — the next
      // click forces it into view.
      after: () => editor.page.theme.coverSection.waitFor({
        state: editor.isMobile ? 'attached' : 'visible',
        timeout: 5_000
      })
    }
  )

  await flow.click(
    'Open the Cover page section',
    editor.page.theme.coverSection,
    {
      // Mobile: BottomSheet portal interception. See `tests/e2e/AGENTS.md`.
      force: editor.isMobile,
      annotations: [
        { label: 'Cover page accordion', selector: 'button:has-text("Cover page")', kind: 'arrow' }
      ],
      result: 'The cover-page editor expands — every field on one scroll-length panel.',
      after: () => page.locator('[data-testid="theme-cover-layout-select"]').waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  // ─── Switch the layout ──────────────────────────────────────────
  await flow.heading('Pick a layout', 3)
  await flow.narrate(
    'The default is Editorial — logo top, title at ⅓, metadata at '
    + '⅔. Try Banner to drop a brand-tinted band across the top of '
    + 'page 1. The preview repaginates after each pick.'
  )

  // USelect renders as a button-trigger combobox. On mobile the
  // theme panel runs inside a `mk-sheet-host` bottom sheet, and the
  // sheet's `aria-hidden="true"` doesn't stop pointer events from
  // routing to its children — Reka portals the popover but the
  // sheet's labels still intercept. Force-click to bypass the
  // actionability check (matches the pattern in the document-context
  // mobile branch).
  const layoutSelect = page.locator('[data-testid="theme-cover-layout-select"]')
  if (editor.isMobile) {
    await flow.step(
      'Open the layout dropdown',
      async () => {
        // Reka USelect listens on pointerdown/pointerup, not click.
        // DOM-level click() doesn't open the popover. Dispatch the
        // full pointer sequence per `tests/e2e/AGENTS.md` workaround #3.
        await layoutSelect.evaluate((el: HTMLElement) => {
          const opts = { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }
          el.dispatchEvent(new PointerEvent('pointerdown', opts))
          el.dispatchEvent(new PointerEvent('pointerup', opts))
          el.click()
        })
        await page.getByRole('option', { name: /banner/i }).first().waitFor({ state: 'visible', timeout: 3_000 })
      },
      { result: 'The four cover layouts list.' }
    )
    await flow.step(
      'Pick "Banner"',
      async () => {
        // Reka USelect listens on pointerdown/pointerup (Radix-style),
        // NOT plain click events. Force-click + DOM `el.click()` both
        // produced just a MouseEvent — neither fires the selection
        // handler when the popover is rendered inside a `mk-sheet-host`
        // bottom sheet (the sheet's portal stacking + aria-hidden
        // shenanigans confuse Reka's pointer-capture). Dispatch the
        // proper pointerdown→pointerup→click sequence on the option
        // so Reka's listener actually fires the value change.
        await page.getByRole('option', { name: /banner/i }).first().evaluate((el: HTMLElement) => {
          const fire = (type: string) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            isPrimary: true
          }))
          fire('pointerdown')
          fire('pointerup')
          el.click()
        })
        await page.waitForTimeout(900)
      },
      { result: 'The Banner layout takes effect.' }
    )
  } else {
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
  }

  // ─── Add a subtitle ─────────────────────────────────────────────
  await flow.heading('Add a subtitle line', 3)
  await flow.narrate(
    'A short line under the title — version, date, "Internal '
    + 'draft", whatever frames the doc. Subtitle is off by default; '
    + 'flip the toggle, then type.'
  )

  await flow.click(
    'Flip the "Show subtitle" toggle on',
    page.locator('[data-testid="theme-cover-show-subtitle-switch"]'),
    {
      force: editor.isMobile,
      result: 'The subtitle field appears underneath, ready for input.',
      after: () => page.locator('[data-testid="theme-cover-subtitle-input"]').waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  await flow.type(
    'Type a subtitle line',
    page.locator('[data-testid="theme-cover-subtitle-input"]'),
    'Internal draft · v0.3 · Engineering team',
    {
      force: editor.isMobile,
      hero: true,
      result: 'The subtitle lands on the cover. The PDF will open on this page.',
      after: () => page.waitForTimeout(900),
      // Highlight the subtitle input on mobile (no preview iframe to
      // point at); on desktop the iframe IS the payoff visual.
      highlights: [
        editor.isMobile
          ? { label: 'Subtitle persisted — verifies via PUT /meta', selector: '[data-testid="theme-cover-subtitle-input"]' }
          : { label: 'Live preview — page 1 is your cover', selector: 'iframe' }
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
  } } }
  expect(meta.theme.cover.enabled).toBe(true)
  expect(meta.theme.cover.layout).toBe('banner')
  expect(meta.theme.cover.showSubtitle).toBe(true)
  expect(meta.theme.cover.subtitle).toBe('Internal draft · v0.3 · Engineering team')

  flow.next({
    slug: 'save-your-custom-theme',
    why: 'Once your cover looks right, save the whole theme as a preset so the next doc starts here'
  })
})
