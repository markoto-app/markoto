import { test, expect } from '../fixtures/flow'

// Tier 1: "Clone an existing doc as the starting point of a new one."
//
// User-job: a writer has a doc that's the structural template for a
// new piece of work, same headings, same theme, same audience, and
// wants to start from a copy instead of recreating it. Job done when
// they've clicked File → Duplicate, watched markoto clone the row +
// Y.js state + S3 assets, and landed in the new doc with the body
// already in place.
//
// Distinct from `templates`: templates seed empty docs from a
// canonical skeleton; duplicate clones a REAL doc you've already
// worked on (with edits, theme tweaks, comments, images). Useful
// when your team has a "house style" doc and starts every weekly
// post from a copy of it.
//
// Runs on desktop AND mobile. Same UX shape, different entry point:
//   - Desktop: File menu in the menubar → "Duplicate…".
//   - Mobile: hamburger ("more") button in the topbar → "Duplicate…".
// `mobileMenuItems` in `EditorLayout.vue` mirrors the File menu's
// duplicate/move/delete cluster, so the asserted UX (confirm modal +
// /api/docs/:id/duplicate + navigate to /d/{newId}) is identical.
//
// On mobile the spec skips the post-clone split-view + paged.js
// pagination assertion (mobile is edit-only, the preview iframe isn't
// mounted under the `sm` breakpoint). The Y.Doc handle that exposes
// the clone's text is the same on both variants.
test('Duplicate a document', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  // The team's "house" checklist that every new hire's copy starts from.
  await editor.silentSetup({
    title: 'Team onboarding checklist',
    body: [
      '# Team onboarding checklist',
      '',
      'Copy this checklist for every new hire and tick items off together in the first week.',
      '',
      '## Day one',
      '',
      '- [ ] Laptop set up and signed in',
      '- [ ] Intro call with your buddy',
      '- [ ] Read the team handbook',
      '',
      '## First week',
      '',
      '- [ ] Ship one small change',
      '- [ ] Join the Thursday demo'
    ].join('\n'),
    cover: false
  })

  await flow.heading('Duplicate an existing document', 3)
  await flow.narrate(
    'A template gives you an empty structure; Duplicate copies a '
    + 'document you already have: its text, theme, images and document '
    + 'settings. Comments stay with the original. Handy when your team '
    + 'starts every new piece of work from a copy of a "house" document. '
    + 'The copy is independent: editing one never changes the other.'
  )

  // Open the menu containing Duplicate
  // Desktop has a top-level menubar (hidden on mobile via `hidden sm:block`).
  // Mobile collapses File / Edit / View / etc. into a single hamburger
  // ("more") UDropdownMenu in the topbar, the duplicate/move/delete
  // cluster is mirrored under `mobileMenuItems` in EditorLayout.vue.
  const openMenuTrigger = editor.isMobile
    ? page.getByRole('button', { name: /^menu$/i }).first()
    : page.locator('nav[aria-label="Menu bar"] > button').first()

  await flow.click(
    editor.isMobile ? 'Open the topbar menu' : 'Click the File menu',
    openMenuTrigger,
    {
      result: editor.isMobile
        ? 'The topbar menu opens, Duplicate is one of the doc actions.'
        : 'The File menu opens, Duplicate sits below Print.',
      after: () => page.getByRole('menuitem', { name: /^duplicate/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Click "Duplicate…"',
    page.getByRole('menuitem', { name: /^duplicate/i }).first(),
    {
      result: 'A confirm dialog appears, markoto pre-fills the new title with "Copy of …".',
      after: () => page.locator('[data-testid="duplicate-confirm"]').waitFor({ state: 'visible' })
    }
  )

  // Confirm + verify navigation
  await flow.heading('Confirm and land in the clone', 3)
  await flow.narrate(
    'Edit the title if you like, then confirm. markoto copies the '
    + 'text, the theme and every image (the copy points at its own '
    + 'images, so deleting the original never breaks it). A flaky '
    + 'connection can\'t leave you with two copies: a retried request '
    + 'returns the copy that was already made.'
  )

  await flow.click(
    'Click "Duplicate" to commit',
    page.locator('[data-testid="duplicate-confirm"]'),
    {
      hero: true,
      result: 'The new doc opens, same body, same theme, fresh URL. Edit '
        + 'either copy independently from now on.',
      after: async () => {
        // /api/docs/:id/duplicate returns the new doc id; the
        // client navigates to /d/{newId}. Wait for the URL change.
        await page.waitForURL(/\/d\/[^/]+/, { timeout: 10_000 })
        await editor.page.waitForReady()
        if (!editor.isMobile) {
          await editor.page.switchToSplitView()
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  // ASSERTION: the cloned doc has the original line (Y.js state copied).
  // Read off the in-page Y.Doc handle (`window.__DEBUG_ytext`,
  // exposed by `useDocument.ts` when `NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1`,
  // which the flow-test stack sets) instead of `cm-content`'s
  // textContent: CM6 doesn't render lines outside the viewport into
  // the DOM, so the appended Q3 line at the very END of the Demo
  // doc may not be in the rendered span on mobile (smaller viewport,
  // edit-only). The Y.Doc is the authoritative content view.
  await expect.poll(
    () => page.evaluate(() => {
      const w = window as unknown as { __DEBUG_ytext?: { toString: () => string } }
      return w.__DEBUG_ytext?.toString?.() ?? ''
    }),
    { timeout: 10_000 }
  ).toMatch(/Copy this checklist for every new hire/i)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Now tweak the clone\'s theme without touching the original'
  })
})
