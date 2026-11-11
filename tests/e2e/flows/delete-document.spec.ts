import { test, expect } from '../fixtures/flow'

// Tier 1: "Delete a document — for real, not by accident".
//
// User-job: a writer is done with a draft (or never wanted it in the
// first place) and wants it GONE. Job done when they've opened the
// File menu, picked Delete, typed the doc's title to confirm, and
// landed on the dashboard with the doc no longer in the list.
//
// Why the type-the-title friction: deletion cascades — the row, the
// Y.js binary state, every uploaded image's S3 object, every
// activity row, every comment thread. Restore is NOT possible
// (the activity-log Tier-2 restore covers in-doc state, not the doc
// itself). Forcing the user to type the doc's literal title makes
// "I clicked the wrong thing" virtually impossible without acting
// in bad faith. Standard pattern (GitHub repo deletion, Stripe
// account close).
//
// Runs on desktop AND mobile. Same UX shape, different entry point:
//   - Desktop: File menu in the menubar → "Delete document".
//   - Mobile: hamburger ("more") button in the topbar → "Delete".
// `mobileMenuItems` in `EditorLayout.vue` mirrors the File menu's
// duplicate/move/delete cluster, so the type-to-confirm modal + the
// asserted server roundtrip are identical.
test('Delete a document', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  // A second document the user keeps, so the dashboard the flow ends
  // on shows a real "Recent documents" list — with the deleted draft
  // visibly missing from it.
  const keptTitle = 'Q4 planning notes'
  const kept = await page.request.post('/api/docs', { data: { title: keptTitle } })
  expect(kept.ok()).toBe(true)
  // A recognisable title so the type-to-confirm step has a meaningful
  // payload (typing "Untitled" to confirm reads as test cheating).
  const docTitle = 'Q3 launch retro draft'
  await editor.silentSetup({
    title: docTitle,
    body: '# Q3 launch retro draft\n\nRough notes before the retro. Superseded by the shared retro doc.\n\n## What went well\n\n- Staged rollout caught the avatar bug early\n'
  })

  await flow.heading('Delete a document', 3)
  await flow.narrate(
    'When you\'re done with a draft and don\'t want it lingering, '
    + 'delete it from File → Delete. markoto asks you to type the '
    + 'doc\'s title back as a confirmation — strong friction by '
    + 'design, because deletion is permanent. The text, its history, '
    + 'its comments and every image in it are removed, and anyone '
    + 'who has the doc open is sent back to their dashboard.'
  )

  // Open the menu containing Delete
  // Desktop has a top-level menubar (hidden on mobile via `hidden sm:block`).
  // Mobile collapses File / Edit / View / etc. into a single hamburger
  // ("more") UDropdownMenu in the topbar — the duplicate/move/delete
  // cluster is mirrored under `mobileMenuItems` in EditorLayout.vue.
  const openMenuTrigger = editor.isMobile
    ? page.getByRole('button', { name: /^menu$/i }).first()
    : page.locator('[data-testid="menubar-file"]')

  await flow.click(
    editor.isMobile ? 'Open the topbar menu' : 'Click the File menu',
    openMenuTrigger,
    {
      result: editor.isMobile
        ? 'The topbar menu opens — Delete is one of the doc actions.'
        : 'The File menu opens — Delete sits at the bottom under its own separator.',
      after: () => page.getByRole('menuitem', { name: /^delete/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Click "Delete document"',
    page.getByRole('menuitem', { name: /^delete/i }).first(),
    {
      annotations: [
        { label: 'delete', selector: '[role="menuitem"]:has-text("Delete")', kind: 'arrow' }
      ],
      result: 'A confirm modal opens — type the doc\'s title to enable Delete.',
      after: () => page.locator('[data-testid="delete-confirm-input"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // Type the title to unlock the button
  await flow.heading('Type the title to confirm', 3)
  await flow.narrate(
    'The Delete button stays disabled until the typed text exactly '
    + 'matches the doc\'s title. Same shape as GitHub\'s repo '
    + 'deletion — friction beats a one-click slip.'
  )

  await flow.type(
    'Type the doc\'s title',
    page.locator('[data-testid="delete-confirm-input"]'),
    docTitle,
    {
      result: 'The title matches, so the Delete button unlocks.'
    }
  )

  // Confirm
  await flow.click(
    'Click "Delete"',
    page.locator('[data-testid="delete-confirm"]'),
    {
      hero: true,
      result: 'The doc is gone. You land back on your dashboard, and '
        + 'your recent documents no longer list it.',
      highlights: [
        { label: 'Recent documents', selector: '[data-testid="landing-recent-documents"]' }
      ],
      after: async () => {
        await page.waitForURL('/', { timeout: 10_000 })
        // The list renders after the dashboard's docs fetch; the kept
        // doc being listed proves the fetch landed, so the deleted
        // doc's absence below means something.
        await expect(page.locator('[data-testid="landing-recent-documents"]')).toContainText(keptTitle)
        await page.locator('[data-testid="landing-recent-documents"]').scrollIntoViewIfNeeded()
      }
    }
  )

  // ASSERTION: we're on the dashboard root + the deleted doc's title
  // is NOT in the recent-docs list. Negative-space assertion — proves
  // the cascade actually wiped the row.
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(page.locator('[data-testid="landing-recent-documents"]')).not.toContainText(docTitle)
  // The deleter gets the success toast, never the "deleted by the
  // owner" notice meant for other people who had the doc open.
  await expect(page.getByText(/deleted by the owner/i)).toHaveCount(0)

  flow.next({
    slug: 'restore-an-earlier-version',
    why: 'Worried about losing work? The Activity log can roll a doc back to an earlier state without deleting it'
  })
})
