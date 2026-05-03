import { test, expect } from '../fixtures/flow'

// Tier 1: "Clone an existing doc as the starting point of a new one."
//
// User-job: a writer has a doc that's the structural template for a
// new piece of work — same headings, same theme, same audience — and
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
// Desktop only — File menu lives in the menubar (hidden on mobile).
// Mobile users can duplicate via the dashboard's per-doc menu (a
// separate flow worth doing).
test('Duplicate a document', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'File → Duplicate is in the desktop menubar; mobile sibling not yet built.'
  )
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  // Type a recognisable line so we can verify the clone carried it.
  const cmContent = page.locator('.cm-content')
  await cmContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')
  await cmContent.pressSequentially('Q3 launch postmortem template — clone me to start a new postmortem.')

  await flow.heading('Duplicate an existing document', 3)
  await flow.narrate(
    'Templates seed an EMPTY skeleton. Duplicate clones an EXISTING '
    + 'doc, including its content, theme, comments, and uploaded '
    + 'images. Useful when your team has a "house" doc and starts '
    + 'every new piece of work from a copy of it. The clone is fully '
    + 'independent — editing one does not touch the other.'
  )

  // ─── File menu → Duplicate ──────────────────────────────────────
  await flow.click(
    'Click the File menu',
    page.locator('nav[aria-label="Menu bar"] > button').first(),
    {
      result: 'The File menu opens — Duplicate sits below Print.',
      after: () => page.getByRole('menuitem', { name: /^duplicate/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Click "Duplicate…"',
    page.getByRole('menuitem', { name: /^duplicate/i }).first(),
    {
      result: 'A confirm dialog appears — markoto pre-fills the new title with "Copy of …".',
      after: () => page.locator('[data-testid="duplicate-confirm"]').waitFor({ state: 'visible' })
    }
  )

  // ─── Confirm + verify navigation ────────────────────────────────
  await flow.heading('Confirm and land in the clone', 3)
  await flow.narrate(
    'Edit the title if you like, then commit. markoto clones the doc '
    + 'row in Postgres, copies the Y.js binary state in one COPY '
    + '(no replay), copies every uploaded image to a fresh S3 prefix '
    + 'and rewrites the markdown URLs. The whole operation is '
    + 'idempotent — a network retry mid-clone won\'t produce two '
    + 'copies thanks to the `Idempotency-Key` header.'
  )

  await flow.click(
    'Click "Duplicate" to commit',
    page.locator('[data-testid="duplicate-confirm"]'),
    {
      hero: true,
      result: 'The new doc opens — same body, same theme, fresh URL. Edit '
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
  const editorText = await cmContent.textContent()
  expect(editorText).toMatch(/Q3 launch postmortem template/i)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Now tweak the clone\'s theme without touching the original'
  })
})
