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
// Desktop only: the desktop menubar has the File menu inline; mobile
// surfaces deletion via the user's profile menu, which is a
// different shape and a separate flow.
test('Delete a document', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'File menu is desktop-only; mobile delete lives in the user'
    + ' profile menu and is a separate flow candidate.'
  )
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  // Set a recognisable title so the type-to-confirm step has a
  // meaningful payload (silentSetup leaves the doc as "Untitled" by
  // default — typing "Untitled" to confirm reads as test cheating).
  const docTitle = 'Q3 launch retro draft'
  await editor.page.titleButton.click()
  await editor.page.titleInput.fill(docTitle)
  await editor.page.titleInput.press('Enter')
  await page.waitForTimeout(500)

  await flow.heading('Delete a document', 3)
  await flow.narrate(
    'When you\'re done with a draft and don\'t want it lingering, '
    + 'delete it from File → Delete. markoto asks you to type the '
    + 'doc\'s title back as a confirmation — strong friction by '
    + 'design, because deletion is irreversible. The row goes '
    + 'away, the Y.js state is purged, every uploaded image is '
    + 'cleaned out of S3, and every collaborator on the doc gets '
    + 'redirected to their dashboard.'
  )

  // ─── Open File → Delete ─────────────────────────────────────────
  await flow.click(
    'Click the File menu',
    page.locator('[data-testid="menubar-file"]'),
    {
      result: 'The File menu opens — Delete sits at the bottom under its own separator.',
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

  // ─── Type the title to unlock the button ────────────────────────
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
      result: 'The Delete button enables — server roundtrip is one click away.'
    }
  )

  // ─── Confirm ────────────────────────────────────────────────────
  await flow.click(
    'Click "Delete"',
    page.locator('[data-testid="delete-confirm"]'),
    {
      hero: true,
      result: 'The doc is gone. You land back on the dashboard; the '
        + 'deleted doc is no longer in the Recent Documents list.',
      after: async () => {
        await page.waitForURL('/', { timeout: 10_000 })
        await page.waitForTimeout(500)
      }
    }
  )

  // ASSERTION: we're on the dashboard root + the deleted doc's title
  // is NOT visible in the recent-docs list. Negative-space assertion
  // — proves the cascade actually wiped the row.
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(page.getByText(docTitle).first()).toHaveCount(0)

  flow.next({
    slug: 'restore-an-earlier-version',
    why: 'Worried about losing work? The Activity log can roll a doc back to an earlier state without deleting it'
  })
})
