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
// The save path opens SavedThemeDialog (name + optional description);
// the flow also edits the name through the pencil on the card.
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
    'You land on a theme that fits your team\'s docs — a built-in '
    + 'preset with the cover page switched off. Save it '
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
      after: () => editor.page.theme.preset('business-report').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Apply a preset to start from ───────────────────────────────
  await flow.heading('Pick a starting preset', 3)
  await flow.narrate(
    'Saved presets live ALONGSIDE the built-in ones — you don\'t '
    + 'replace anything. Pick a built-in to start (Corporate report '
    + 'here: serif headings and one petrol accent), then tweak it.'
  )

  await flow.click(
    'Click "Corporate report"',
    editor.page.theme.preset('business-report'),
    {
      // Mobile: BottomSheet portal interception. See `tests/e2e/AGENTS.md`.
      force: editor.isMobile,
      result: editor.isMobile
        ? 'The Corporate report preset is selected — preview iframe is hidden in mobile edit-only mode.'
        : 'The preview repaginates: a cover page with a petrol band, '
          + 'serif headings over a sans body.',
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
    'Corporate report opens with a cover page. For internal documents '
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
    + 'bookmark icon) opens a small dialog: a name, and an optional '
    + 'line saying what the theme is for. Both show up on the card '
    + 'in Your themes, just like the built-in presets.'
  )

  const PRESET_NAME = 'My report, no cover'
  const PRESET_DESCRIPTION = 'Petrol accent, serif headings, starts with the text.'
  // Clear the earlier "Template applied" toast so the hero frame shows
  // only the save confirmation.
  await editor.page.dismissToasts()

  const dialog = page.locator('[data-testid="saved-theme-dialog"]')
  const nameInput = page.locator('[data-testid="saved-theme-name-input"]')
  const descriptionInput = page.locator('[data-testid="saved-theme-description-input"]')

  await flow.click(
    'Click "Save current" (bookmark icon)',
    page.locator('[data-testid="theme-save-current"]'),
    {
      force: editor.isMobile,
      result: 'The Save theme dialog opens with an empty name field.',
      after: () => dialog.waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // The save button stays disabled until there is a name.
  await expect(page.locator('[data-testid="saved-theme-submit"]')).toBeDisabled()

  await flow.type(
    'Name the theme',
    nameInput,
    PRESET_NAME,
    { force: editor.isMobile, result: 'The counter next to the label shows how much room is left (80 characters).' }
  )
  await flow.type(
    'Add a short description',
    descriptionInput,
    PRESET_DESCRIPTION,
    { force: editor.isMobile, result: 'The description is optional, up to 200 characters.' }
  )

  await flow.click(
    'Click "Save theme"',
    page.locator('[data-testid="saved-theme-submit"]'),
    {
      hero: true,
      result: 'The theme lands under Your themes, above the built-in '
        + 'templates, with its description. One click applies it to any doc from now on.',
      after: async () => {
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
        // The themeId is generated server-side, so we look for ANY
        // saved card.
        await page.locator('[data-testid^="theme-saved-"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      },
      highlights: [
        { label: 'Saved preset', selector: '[data-testid^="theme-saved-"]' }
      ]
    }
  )

  // ASSERTION: the card carries the name + the description, and the
  // server stored both.
  const card = page.locator('[data-testid^="theme-saved-"]').first()
  await expect(card).toContainText(PRESET_NAME)
  await expect(card).toContainText(PRESET_DESCRIPTION)
  const stored = await page.request.get('/api/themes')
  const storedThemes = (await stored.json() as { themes: Array<{ themeId: string, name: string, description: string }> }).themes
  const savedRow = storedThemes.find(s => s.name === PRESET_NAME)
  expect(savedRow?.description).toBe(PRESET_DESCRIPTION)
  if (!savedRow) throw new Error('saved theme not returned by /api/themes')

  // ─── Edit name + description ────────────────────────────────────
  await flow.heading('Rename it later', 3)
  await flow.narrate(
    'The pencil on the card opens the same dialog with the current '
    + 'name and description filled in. The bin next to it removes the '
    + 'theme after asking once; documents that use it keep their look.'
  )

  await flow.click(
    'Click the pencil on your theme',
    page.locator(`[data-testid="saved-theme-edit-${savedRow.themeId}"]`),
    {
      force: editor.isMobile,
      result: 'The Edit theme dialog shows the saved name and description.',
      after: () => dialog.waitFor({ state: 'visible', timeout: 5_000 })
    }
  )
  await expect(nameInput).toHaveValue(PRESET_NAME)
  await expect(descriptionInput).toHaveValue(PRESET_DESCRIPTION)

  const RENAMED = 'Team report'
  await nameInput.fill('')
  await flow.type('Type a new name', nameInput, RENAMED, { force: editor.isMobile, result: 'The new name replaces the old one.' })
  await flow.click(
    'Click "Save changes"',
    page.locator('[data-testid="saved-theme-submit"]'),
    {
      result: 'The card shows the new name; the description stays.',
      after: () => expect(card).toContainText(RENAMED, { timeout: 10_000 })
    }
  )
  await expect(card).toContainText(PRESET_DESCRIPTION)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Now switch back and forth — your saved preset sits next to the built-ins'
  })
})
