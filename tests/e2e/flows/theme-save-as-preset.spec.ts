import { test, expect } from '../fixtures/flow'

// Tier 2: "Save your custom theme as a preset".
//
// User-job: a writer landed on a theme that works for THEIR docs —
// some preset + their tweaks — and wants it back next time. Job done
// when they've saved the current theme as a personal preset and seen
// it land in the saved-themes list ready to re-apply.
//
// Different shape from `pick-a-theme` (Tier 1), which covers the
// "switch presets + toggle cover" entry-level flow. This one zooms
// in on the SAVE path: applying a preset, customising the cover,
// then bookmarking the result. Saved presets live per-user and
// surface in the picker for every doc the user owns.
//
// The save path uses `window.prompt()` for the name input — a native
// browser dialog, not a custom modal. We auto-accept via Playwright's
// `dialog` event so the flow doesn't hang on the prompt; the
// screenshots show the BEFORE state (no saved preset) + the AFTER
// state (preset card visible in the saved list).
//
// Desktop only: the Theme panel mounts in the right sidebar at
// desktop widths. Mobile surfaces the same panel via a bottom sheet
// but the deep-dive shots get cramped at 375px wide.
test('Save your custom theme as a preset', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Theme panel deep-dive reads better at desktop where the sidebar'
    + ' panel + live preview iframe sit side-by-side; mobile bottom'
    + ' sheet covers the preview while editing.'
  )
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  // Cover-page-on shows the visual difference more dramatically when
  // we toggle it — but silentSetup leaves the markoto preset's
  // default which IS cover-on, so we don't need disableCoverPage().

  await flow.heading('Save your custom theme as a preset', 3)
  await flow.narrate(
    'You land on a theme that fits your team\'s docs — academic '
    + 'preset, cover off, slightly different page color. Save it '
    + 'once and every doc you create after this gets it as a '
    + 'one-click pick in the theme grid. Saved presets are '
    + 'per-user — they don\'t leak into other people\'s drafts, '
    + 'they\'re yours.'
  )

  // ─── Open the Theme panel ───────────────────────────────────────
  await flow.click(
    'Click the Theme tab in the right sidebar',
    editor.page.sidebar.theme,
    {
      annotations: [
        { label: 'theme tab', selector: '[data-testid="sidebar-tab-theme"]', kind: 'arrow' }
      ],
      result: 'The Theme panel slides in — presets grid + section list '
        + '(Page, Body, Headings, Layout, Colors, Cover, Code, '
        + 'Mermaid, TOC).',
      after: () => editor.page.theme.preset('academic').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Apply a preset to start from ───────────────────────────────
  await flow.heading('Pick a starting preset', 3)
  await flow.narrate(
    'Saved presets live ALONGSIDE the built-in ones — you don\'t '
    + 'replace anything. Pick a built-in to start (academic here, '
    + 'serif body + restrained color), then we\'ll tweak it.'
  )

  await flow.click(
    'Click "Academic"',
    editor.page.theme.preset('academic'),
    {
      result: 'The preview repaginates — Fraunces body, refined '
        + 'spacing, the academic preset\'s signature look.',
      after: () => editor.page.waitForPreviewPaginated()
    }
  )

  // ─── Tweak: turn the cover off ──────────────────────────────────
  await flow.heading('Tweak — turn the cover page off', 3)
  await flow.narrate(
    'Every preset has a cover page on by default. For internal '
    + 'docs the cover often gets in the way; turn it off and the '
    + 'preview drops to "page 1 = first heading" instead of '
    + '"page 1 = title sheet". The cover toggle is the topmost '
    + 'switch in the Cover section.'
  )

  await flow.click(
    'Open the Cover section',
    editor.page.theme.coverSection,
    {
      result: 'The Cover section expands. The on/off switch sits at the top.',
      after: () => editor.page.theme.coverEnabledSwitch.waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Toggle cover OFF',
    editor.page.theme.coverEnabledSwitch,
    {
      result: 'The preview repaginates — page 1 is now the document body, '
        + 'no title sheet.',
      after: async () => {
        await page.waitForTimeout(800)
        await editor.page.waitForPreviewPaginated()
      }
    }
  )

  // ─── Save it ─────────────────────────────────────────────────────
  await flow.heading('Bookmark it as a saved preset', 3)
  await flow.narrate(
    'The "Save current" button at the top of the presets list (the '
    + 'bookmark icon) writes the current theme + a name you choose '
    + 'into your saved-themes list. The button asks for a name via '
    + 'a quick prompt; type anything memorable.'
  )

  // Pre-arm the prompt handler BEFORE the click that opens it.
  // page.on('dialog') fires synchronously inside the click handler;
  // attaching the listener after would miss the event.
  const PRESET_NAME = 'My academic, no cover'
  page.once('dialog', (dialog) => {
    void dialog.accept(PRESET_NAME)
  })

  await flow.click(
    'Click "Save current" (bookmark icon)',
    page.locator('[data-testid="theme-save-current"]'),
    {
      hero: true,
      result: 'A name prompt appears + auto-resolves with your name; the '
        + 'theme lands in the saved-themes list above the built-in '
        + 'presets, ready to re-apply on any doc.',
      after: async () => {
        // The save handler POSTs to /api/themes; on success the
        // saved-themes list refetches. Wait for the new card to
        // surface — its testid is `theme-saved-${themeId}` and the
        // themeId is generated server-side, so we look for ANY
        // saved card.
        await page.locator('[data-testid^="theme-saved-"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      },
      highlights: [
        { label: 'Saved preset', selector: '[data-testid^="theme-saved-"]' }
      ]
    }
  )

  // ASSERTION: at least one saved-theme card exists + carries the
  // name we typed. The exact rendering of the name is up to the
  // panel; we assert the saved-card list is non-empty AND the page
  // contains the preset name we typed (somewhere — could be the
  // card label or aria).
  await expect(page.locator('[data-testid^="theme-saved-"]').first()).toBeVisible()
  await expect(page.getByText(PRESET_NAME).first()).toBeVisible()

  flow.next({
    slug: 'pick-a-theme',
    why: 'Now switch back and forth — your saved preset sits next to the built-ins'
  })
})
