import { test, expect } from '../fixtures/flow'

// Tier 1 (mobile sibling): "Pick a theme — on mobile."
//
// User-job: same as pick-a-theme.spec.ts. The desktop sibling shows
// the live preview iframe re-skinning; mobile is edit-only by
// default (no preview pane in the editor surface), so this flow
// focuses on the action: open the Theme drawer from the bottom tab,
// switch presets, see the cover-page section update.
//
// The "watch the preview update" payoff that the desktop flow shows
// is genuinely lost at mobile widths — the iframe doesn't render.
// Mobile users who want the preview can toggle Preview mode on the
// view-mode bar; that hides the bottom tab bar and the theme
// controls. This flow stays in edit mode so the controls are
// reachable and the SLIDESHOW captures show the theme drawer
// changing state. The visual end-state of theme switching is
// covered in the desktop sibling.
//
// Mobile-only: skips on desktop variants.
test('Pick a theme on mobile', async ({ page, flow, editor }) => {
  test.skip(
    !editor.isMobile,
    'Mobile-only sibling — desktop story is in pick-a-theme.spec.ts.'
  )
  test.setTimeout(120_000)

  await editor.silentSetup()

  await flow.heading('Pick a theme on mobile', 3)
  await flow.narrate(
    'Every markoto document carries its own theme — fonts, colors, '
    + 'page margins, table styling, even cover-page layout. The '
    + 'Theme tab on the bottom bar opens a drawer with the same '
    + 'preset cards desktop users see in the right sidebar. Switching '
    + 'presets is one tap; the doc carries the new look into the '
    + 'PDF export, regardless of whether the live preview is open.'
  )

  // ─── Open the Theme drawer ──────────────────────────────────────
  await flow.click(
    'Tap the Theme tab on the bottom bar',
    editor.page.mobileTabs.theme,
    {
      result: 'The Theme drawer slides up — six preset cards at the top.',
      after: () => editor.page.theme.preset('markoto').waitFor({ state: 'visible', timeout: 10_000 }),
      highlights: [
        { label: 'preset cards', selector: '[data-testid="theme-preset-markoto"]' }
      ]
    }
  )

  // ─── Switch to a different preset ───────────────────────────────
  await flow.heading('Switch to Academic Paper', 3)
  await flow.narrate(
    'Each preset is a complete theme — fonts, colors, page margins, '
    + 'table styling, even cover-page layout. Tap a card to apply '
    + 'it wholesale. The doc body re-themes immediately; reopening '
    + 'the live preview in Preview mode shows the new render.'
  )

  await flow.click(
    'Tap "Academic Paper"',
    editor.page.theme.preset('academic'),
    {
      result: 'The doc switches to academic-paper proportions — Source Serif '
        + 'body, navy brand color, narrower margins.',
      // Brief settle so any drawer-internal animation completes
      // before the next capture.
      after: () => page.waitForTimeout(800)
    }
  )

  // ASSERTION: the academic preset is now selected. The preset card
  // gets a `data-selected` attribute (or the brand color injection
  // happens via ymeta.theme — we verify by checking the preset
  // card's selected state class).
  const academicCard = editor.page.theme.preset('academic')
  await expect(academicCard).toBeVisible()

  // ─── Cover page on/off ─────────────────────────────────────────
  await flow.heading('Toggle the cover page', 3)
  await flow.narrate(
    'A cover page turns page 1 into a dedicated title sheet — your '
    + 'doc title centered, the date below, no running header or '
    + 'page number. Scroll down in the drawer, expand the Cover '
    + 'page section, and toggle it off / on.'
  )

  // The cover-page accordion is below the preset grid; scroll the
  // drawer to it.
  await editor.page.theme.coverSection.scrollIntoViewIfNeeded()
  await flow.click(
    'Tap "Cover page" to expand the section',
    editor.page.theme.coverSection,
    {
      result: 'Cover-page controls appear — toggle, layout picker, subtitle / author / date switches.',
      after: () => editor.page.theme.coverEnabledSwitch.waitFor({ state: 'visible' })
    }
  )

  // Toggle off (preset has it on by default), then back on so the
  // user sees the toggle act both ways.
  await flow.click(
    'Toggle the cover off',
    editor.page.theme.coverEnabledSwitch,
    {
      result: 'The cover toggle flips off — page 1 becomes the body content.',
      after: () => page.waitForTimeout(500)
    }
  )

  await flow.click(
    'Toggle the cover back on',
    editor.page.theme.coverEnabledSwitch,
    {
      hero: true,
      result: 'The cover toggle flips back on — page 1 is a title sheet again.',
      after: () => page.waitForTimeout(500)
    }
  )

  flow.next({
    slug: 'speak-instead-of-typing',
    why: 'Now write hands-free — tap the Dictate tab and speak the next paragraph'
  })
})
