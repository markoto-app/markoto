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
// Runs on desktop AND mobile. The Theme panel mounts in the right
// sidebar on desktop and in a bottom sheet on mobile; the testids
// (`theme-preset-*`, `theme-save-current`, `theme-saved-*`) are the
// same on both. Mobile is edit-only (`v-if="viewMode !== 'edit'"`
// keeps the preview iframe unmounted under `<sm`), so the
// preview-paginated waits skip on mobile — the asserted state is the
// saved-themes list, which doesn't depend on the preview iframe.
test('Save your custom theme as a preset', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  // Cover stays ON here: turning it off is one of the tweaks this
  // flow saves into the preset.
  await editor.silentSetup({
    title: 'Team report template',
    body: '# Team report template\n\n## Summary\n\nTwo or three sentences on what happened this month and why it matters.\n\n## Numbers\n\n| Metric | This month | Last month |\n|---|---|---|\n| Active writers | 412 | 380 |\n'
  })

  await flow.heading('Save your custom theme as a preset', 3)
  await flow.narrate(
    'You land on a theme that fits your team\'s docs — academic '
    + 'preset, cover off, slightly different page color. Save it '
    + 'once and every doc you create after this gets it as a '
    + 'one-click pick in the theme grid. Saved presets are '
    + 'per-user — they don\'t leak into other people\'s drafts, '
    + 'they\'re yours.'
  )

  // Desktop: right-sidebar Theme tab; mobile: bottom-tab-bar Theme.
  const themeTab = editor.isMobile
    ? editor.page.mobileTabs.theme
    : editor.page.sidebar.theme

  await flow.click(
    editor.isMobile ? 'Tap the Theme tab on the bottom bar' : 'Click the Theme tab in the right sidebar',
    themeTab,
    {
      annotations: editor.isMobile
        ? []
        : [{ label: 'theme tab', selector: '[data-testid="sidebar-tab-theme"]', kind: 'arrow' }],
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
      // Mobile: BottomSheet portal interception. See `tests/e2e/AGENTS.md`.
      force: editor.isMobile,
      result: editor.isMobile
        ? 'The academic preset is selected — preview iframe is hidden in mobile edit-only mode.'
        : 'The preview repaginates — two-column serif body and '
          + 'restrained colour, the academic preset\'s signature look.',
      after: async () => {
        // Mobile is edit-only — no preview iframe to wait on.
        if (!editor.isMobile) {
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  // ─── Tweak: turn the cover off ──────────────────────────────────
  await flow.heading('Tweak — turn the cover page off', 3)
  await flow.narrate(
    'Academic Paper opens with a cover page. For internal documents '
    + 'a title sheet often gets in the way: switch it off and page 1 '
    + 'starts with the text itself. The switch is at the top of the '
    + 'Cover page section.'
  )

  await flow.click(
    'Open the Cover section',
    editor.page.theme.coverSection,
    {
      force: editor.isMobile,
      result: 'The Cover section expands. The on/off switch sits at the top.',
      after: () => editor.page.theme.coverEnabledSwitch.waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Toggle cover OFF',
    editor.page.theme.coverEnabledSwitch,
    {
      force: editor.isMobile,
      result: editor.isMobile
        ? 'The cover toggle flips off — preview iframe hidden in mobile edit-only mode.'
        : 'The preview repaginates — page 1 is now the document body, '
          + 'no title sheet.',
      after: async () => {
        if (!editor.isMobile) {
          await expect(editor.page.previewRoot().locator('#mount .markoto-cover')).toHaveCount(0, { timeout: 10_000 })
          await editor.page.waitForPreviewPaginated()
        }
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
  // Clear the earlier "Template applied" toast so the hero frame shows
  // only the save confirmation.
  await editor.page.dismissToasts()
  page.once('dialog', (dialog) => {
    void dialog.accept(PRESET_NAME)
  })

  await flow.click(
    'Click "Save current" (bookmark icon)',
    page.locator('[data-testid="theme-save-current"]'),
    {
      force: editor.isMobile,
      hero: true,
      result: 'Give it a name and the theme lands under Your themes, above '
        + 'the built-in templates — one click on any doc from now on.',
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
