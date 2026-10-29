import { test, expect } from '../fixtures/flow'

// Tier 1: "Pick a theme that fits your document".
//
// User-job: a writer wants their document to LOOK right — typography,
// page color, headings, the works — without learning CSS or fighting
// per-doc settings. Job done when they've switched to a different preset,
// watched the live preview update, switched back, and seen the cover page
// turn page 1 into a title sheet.
//
// The doc starts with the cover OFF so the first preview page shows the
// report: each preset's typography is visible without scrolling. Presets
// replace the whole theme, cover included — Academic Paper turns the
// cover on, so its two columns are shown on page 2 (scrolled to).
//
// Runs on desktop AND mobile. Mobile routes through the bottom-tab-bar
// Theme entry and stops after the preset switch (no preview iframe on
// mobile; the cover controls are covered by cover-page-editor.spec.ts).
test('Pick a theme', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Signed in, so the doc is owned and theme changes are saved to it
  // (asserted through /meta below), not only synced live.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Annual report', body: REPORT, cover: false })

  /** The brand colour of the theme the preview is currently rendering. */
  const previewBrand = () => editor.page.previewRoot().evaluate(() => {
    const style = Array.from(document.querySelectorAll('style'))
      .find(s => (s.textContent ?? '').includes('--doc-brand'))
    return style?.textContent?.match(/--doc-brand:\s*(#[0-9a-fA-F]+)/)?.[1]?.toLowerCase() ?? null
  })
  const previewHasCover = () => editor.page.previewRoot().evaluate(() => document.querySelector('#mount .markoto-cover') !== null)
  const themeMeta = async () => {
    const res = await page.request.get(`/api/docs/${editor.page.currentDocId()}/meta`)
    return (await res.json() as { theme: { color: { brand: string }, cover: { enabled: boolean } } }).theme
  }

  await flow.heading('Pick a theme that fits your document', 3)
  await flow.narrate(
    'Every markoto document carries its own theme: fonts, colours, page '
    + 'margins, tables, the cover page. The same theme drives the preview '
    + 'and the PDF, so what you see on the right is what you send.'
  )

  // ─── Open the theme panel ──────────────────────────────────────────
  await flow.heading('Open the theme panel', 3)
  await flow.narrate(
    'New documents use the markoto theme: Fraunces headings, Inter body '
    + 'text, warm paper and vermillion accents. To try other looks, open '
    + 'the theme panel.'
  )

  if (editor.isMobile) {
    await flow.click(
      'Tap the Theme tab on the bottom bar',
      page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Theme"]'),
      {
        annotations: [
          { label: 'theme tab', selector: '[data-testid="mobile-tab-bar"] button[aria-label="Theme"]', kind: 'arrow' }
        ],
        result: 'The theme panel slides up: seven presets at the top, all settings below.',
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
        // sidebar tabs and a first-time reader needs help finding it.
        annotations: [
          { label: 'theme tab', selector: 'button[aria-label*="theme" i]', kind: 'arrow' }
        ],
        result: 'The theme panel opens: seven built-in presets at the top, all settings below.',
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
    'Each preset is a complete theme. Click a card to apply it; the '
    + 'preview updates right away, and your text stays exactly as it is.'
  )

  await flow.click(
    'Click "Academic Paper" for a journal-style two-column layout',
    editor.page.theme.preset('academic'),
    {
      // Mobile: theme presets render inside the BottomSheet portal.
      // See `tests/e2e/AGENTS.md` "Bottom-sheet portal interception".
      force: editor.isMobile,
      result: editor.isMobile
        ? 'Academic Paper is applied: serif type, justified text, two columns in the PDF.'
        : 'The text switches to a serif, justified in two columns. Academic Paper adds '
          + 'a cover page, so the report now starts on page 2.',
      after: async () => {
        await expect.poll(async () => (await themeMeta()).color.brand.toLowerCase()).toBe('#1e3a8a')
        if (!editor.isMobile) {
          await expect.poll(previewBrand).toBe('#1e3a8a')
          // Academic turns the cover on: show page 2, where the columns are.
          await editor.page.scrollPreviewTo('.pagedjs_page[data-page-number="2"]')
        }
      }
    }
  )

  // ─── Switch back to markoto ────────────────────────────────────────
  await flow.heading('Switch back to markoto', 3)
  await flow.narrate(
    'Nothing is final: click another preset any time. Back to markoto '
    + 'for the rest of this tour.'
  )

  if (editor.isMobile) {
    // DOM-level click — the preset card lives inside the BottomSheet
    // portal. Workaround #2 from `tests/e2e/AGENTS.md`.
    await flow.hover('Tap "markoto" to return to the default', editor.page.theme.preset('markoto'), { force: true })
    await editor.page.theme.preset('markoto').evaluate((el: HTMLElement) => el.click())
    await expect.poll(async () => (await themeMeta()).color.brand.toLowerCase()).toBe('#b5371f')
    await flow.shot('Back to the markoto theme.')
  } else {
    await flow.click(
      'Click "markoto" to return to the default',
      editor.page.theme.preset('markoto'),
      {
        result: 'Back to warm paper and Fraunces headings, with an asterism (⁂) between sections.',
        after: async () => {
          await expect.poll(previewBrand).toBe('#b5371f')
          await editor.page.scrollPreviewTo('hr')
        },
        highlights: [
          { label: 'Asterism scene break', selector: 'iframe' }
        ]
      }
    )
  }

  // ─── Cover page ────────────────────────────────────────────────────
  // Mobile stops here: the cover controls are covered on both variants
  // by `cover-page-editor.spec.ts`; the preview (the payoff) is
  // desktop-only.
  if (editor.isMobile) {
    flow.next({
      slug: 'edit-your-cover-page',
      why: 'Make the cover page your own: layout, subtitle, authors'
    })
    return
  }

  await flow.heading('The cover page', 3)
  await flow.narrate(
    'The markoto preset comes with a cover page: a title sheet with the '
    + 'logo, the document title and the date, and no header or page '
    + 'number. The Cover page section switches it off and on.'
  )

  await flow.click(
    'Click "Cover page" to expand the section',
    editor.page.theme.coverSection,
    {
      result: 'The cover page settings: the on/off switch, layout, and which fields to show.',
      after: () => editor.page.theme.coverEnabledSwitch.waitFor({ state: 'visible' })
    }
  )

  // ASSERTION: applying the markoto preset switched the cover on.
  expect((await themeMeta()).cover.enabled).toBe(true)
  await expect.poll(previewHasCover).toBe(true)

  await flow.click(
    'Switch the cover page off',
    editor.page.theme.coverEnabledSwitch,
    {
      result: 'Without a cover, page 1 starts with the report itself.',
      after: async () => {
        await expect.poll(previewHasCover).toBe(false)
        await editor.page.scrollPreviewTo('.pagedjs_page[data-page-number="1"]')
      }
    }
  )

  await flow.click(
    'Switch it back on',
    editor.page.theme.coverEnabledSwitch,
    {
      hero: true,
      result: 'Page 1 is a title sheet again: logo, title, date, and no page number.',
      after: async () => {
        await expect.poll(previewHasCover).toBe(true)
        await editor.page.scrollPreviewTo('.markoto-cover')
      },
      highlights: [
        { label: 'Cover page', selector: 'iframe' }
      ]
    }
  )

  // ASSERTION: the cover is on in the saved theme too.
  await expect.poll(async () => (await themeMeta()).cover.enabled).toBe(true)

  flow.next({
    slug: 'write-with-ai',
    why: 'Now ask the AI to draft a section for you'
  })
})

const REPORT = [
  '# Annual report 2026',
  '',
  'This was the year we stopped treating writing as a solo activity. Teams moved their planning documents, launch notes and customer reports into shared drafts, and the number of documents with more than one author tripled.',
  '',
  '## Highlights',
  '',
  'Revenue grew 42% year over year, driven by workspace plans for teams of ten to fifty people. Churn fell to 2.1% a month, the lowest since launch, and two thirds of new accounts came from invitations sent by existing customers.',
  '',
  'We opened an office in Lisbon and grew the team from 18 to 31 people. Every new hire wrote their onboarding notes in markoto, and most of those notes became the handbook pages new colleagues read today.',
  '',
  '---',
  '',
  '## What we learned',
  '',
  'Customers do not want more features; they want fewer steps between a rough draft and a document they are proud to send. The most requested change all year was a better PDF, not a new button.',
  '',
  'Collaboration only works when everyone trusts the history. Restore, comments and the activity log were used far more than we expected, mostly by people who never edited a word themselves.',
  '',
  '## Looking ahead',
  '',
  'Next year we will focus on three things: faster exports, better templates for recurring documents, and AI help that cites its sources. Each of them shortens the path from draft to finished document.'
].join('\n')
