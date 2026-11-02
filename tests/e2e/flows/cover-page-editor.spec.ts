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
const PLAYBOOK = [
  '# Q3 product launch playbook',
  '',
  'Everything the launch team needs in one place: who owns what, the dates that cannot move, and how we decide when something slips.',
  '',
  '## Owners',
  '',
  '- **Launch lead:** Maya Chen',
  '- **Release engineering:** Sam Ortiz',
  '- **Customer comms:** Priya Natarajan'
].join('\n')

test('Edit your cover page', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  type CoverMeta = { theme: { cover: { layout: string, subtitle: string } } }
  const readCover = async () => {
    const res = await page.request.get(`/api/docs/${editor.page.currentDocId()}/meta`)
    return (await res.json() as CoverMeta).theme.cover
  }
  const coverLayout = async () => (await readCover()).layout
  const coverSubtitle = async () => (await readCover()).subtitle

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Q3 product launch playbook', body: PLAYBOOK })
  if (!editor.isMobile) await editor.page.waitForPreviewPaginated()
  const cover = page.frameLocator('iframe').first().locator('#mount .markoto-cover')

  await flow.heading('Edit your cover page', 3)
  await flow.narrate(
    'Every new document opens with a cover page in the Editorial layout: '
    + 'logo at the top, the title a third of the way down, today\'s date '
    + 'below. The Cover page section of the theme panel changes all of it: '
    + 'four layouts (Classic, Editorial, Banner, Minimal), a switch for '
    + 'every field, and a slider for the title size.'
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
    'Editorial is the default. Banner puts the logo and the title in a '
    + 'tinted band across the top of the page. The preview updates as '
    + 'soon as you pick a layout.'
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
    // Real clicks — the option popover now stacks above the bottom sheet
    // (main.css z-index fix), so no synthetic-PointerEvent workaround needed.
    await flow.step(
      'Open the layout dropdown',
      async () => {
        await layoutSelect.click()
        await page.getByRole('option', { name: /banner/i }).first().waitFor({ state: 'visible', timeout: 3_000 })
      },
      { result: 'The four cover layouts list.' }
    )
    await flow.step(
      'Pick "Banner"',
      async () => {
        await page.getByRole('option', { name: /banner/i }).first().click()
        await expect.poll(coverLayout).toBe('banner')
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
        result: 'The cover changes: logo and title now sit in a tinted band across the top.',
        after: async () => {
          await expect.poll(coverLayout).toBe('banner')
          // The preview shows the band (the cover's ::before) once it re-rendered.
          await expect.poll(() => cover.evaluate(el => getComputedStyle(el, '::before').content)).not.toBe('none')
          await expect(cover.locator('.markoto-cover-logo')).toBeVisible()
        }
      }
    )
  }

  // ─── Add a subtitle ─────────────────────────────────────────────
  await flow.heading('Add a subtitle line', 3)
  await flow.narrate(
    'A short line under the title, such as a version, a team or '
    + '"Internal draft". The subtitle is off by default: switch it on, '
    + 'then type.'
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
      result: 'The subtitle appears on the cover. The PDF will open on this page.',
      after: async () => {
        // Saved to the document, and (desktop) visible on the cover.
        await expect.poll(coverSubtitle).toBe('Internal draft · v0.3 · Engineering team')
        if (!editor.isMobile) await expect(cover.locator('.markoto-cover-subtitle')).toHaveText('Internal draft · v0.3 · Engineering team')
      },
      // Highlight the subtitle input on mobile (no preview iframe to
      // point at); on desktop the iframe IS the payoff visual.
      highlights: [
        editor.isMobile
          ? { label: 'Subtitle', selector: '[data-testid="theme-cover-subtitle-input"]' }
          : { label: 'Your cover page', selector: 'iframe' }
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
    slug: 'save-your-custom-theme-as-a-preset',
    why: 'Once your cover looks right, save the whole theme as a preset so the next doc starts here'
  })
})
