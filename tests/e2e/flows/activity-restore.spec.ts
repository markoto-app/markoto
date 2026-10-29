import { test, expect } from '../fixtures/flow'

// Tier 1: "Roll the doc back to an earlier point."
//
// User-job: a writer made an edit they regret and wants to undo it
// after Cmd+Z's history is gone (closed the tab, or the edit happened
// in a separate session). Job done when they've opened the Activity
// drawer, scrolled to the right row, and clicked Restore — the doc
// snaps back to the past state for every connected collaborator.
//
// markoto's Activity drawer is the per-doc audit trail: every edit,
// comment, theme change, AI tool call gets a row. Tier 1 is the
// diff drawer (read-only — see what changed). Tier 2 is restore
// (snap the live Y.Doc back). This flow demos Tier 2.
//
// Restore is reversible: the new "restore" row stamped after
// reverting carries the LIVE pre-restore boundary, so clicking
// restore on THAT row brings the doc back to the state right
// before the restore. No data is ever lost.
// Runs on desktop AND mobile. Activity feed renders identically on
// both surfaces (right-sidebar tab on desktop, bottom-tab-bar entry
// on mobile); the restore confirm modal is Reka UI and reflows
// gracefully under `<sm`. Mobile shows the activity rows + the
// restored doc in a single column instead of side-by-side.
test('Restore an earlier version', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login + private doc + cover off so the preview shows the body.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Launch announcement' })
  await editor.page.disableCoverPage()

  await flow.heading('Restore an earlier version of your doc', 3)
  await flow.narrate(
    'markoto records every meaningful change to a doc — edits, '
    + 'comments, theme tweaks, AI tool calls — in the Activity drawer '
    + 'on the right. Each row remembers exactly what the doc looked '
    + 'like before and after that change, so markoto can bring that '
    + 'state back on demand. Restoring is one click + a confirm; the rolled-back '
    + 'state syncs live to every collaborator just like any other edit.'
  )

  // ─── Make a "good" edit then a "bad" edit ──────────────────────
  await flow.heading('Make an edit you\'ll regret', 3)
  await flow.narrate(
    'Type something into the doc. Then make a SECOND edit on top — '
    + 'this is the one we\'ll roll back.'
  )

  const cmContent = page.locator('.cm-content')
  await cmContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')
  await cmContent.pressSequentially('Q3 launch postmortem — the version we want to keep.')

  await flow.shot(
    'You typed a thoughtful sentence. This is the state you want to '
    + 'preserve — call this the "good" version.'
  )

  // Hocuspocus's onStoreDocument is debounced 2 s in `sync-server/
  // src/index.ts`. To get TWO distinct activity rows (one per typing
  // burst) we have to let the first batch FLUSH before the second
  // typing starts — otherwise both typings collapse into one row,
  // and `restoreButtons.first()` ends up rolling back to the welcome
  // state instead of the desired "good" state. 3 s = 2 s debounce +
  // 1 s safety. (Tried polling /api/docs/:id/activity for >=1 edit
  // row and proceeding immediately — that exited at flush time but
  // a freshly-typed character hit Hocuspocus while it was still
  // inside the same batch window, so the typings merged. The fixed
  // wait is the right tool here.)
  await page.waitForTimeout(3_000)

  // Now make the "bad" edit on top.
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')
  await cmContent.pressSequentially('xxxxx — accidental destructive edit, please ignore xxxxx')

  await flow.shot(
    'You add a second edit on top — this one is the mistake. The '
    + 'normal Cmd+Z would undo it, but suppose you closed the tab '
    + 'and lost that history.'
  )

  // Wait for the second row to flush. Same 3 s ceiling — anything
  // after this is wasted; the test is now ready to open Activity.
  await page.waitForTimeout(3_000)

  // ─── Open the Activity drawer ──────────────────────────────────
  await flow.heading('Open the Activity drawer', 3)
  await flow.narrate(
    'The Activity tab in the right sidebar shows every change in '
    + 'reverse-chronological order. Each edit row carries an '
    + '"View change" affordance + a Restore button (history icon).'
  )

  // Desktop: right-sidebar Activity tab; mobile: bottom-tab-bar entry.
  const activityTab = editor.isMobile
    ? editor.page.mobileTabs.activity
    : editor.page.sidebar.activity

  await flow.click(
    'Click the Activity tab',
    activityTab,
    {
      result: 'The Activity drawer opens — your two edits sit at the top of the feed.',
      // Wait on a real activity row attribute, not `getByText(/edit/i)`.
      // The bare regex matches the (hidden-on-mobile) menubar Edit
      // button at `data-testid="menubar-edit"`, which exists in DOM
      // under `<sm` but is `hidden sm:block`-clipped — Playwright's
      // visible-state polling stalls forever on it.
      after: () => page.locator('[data-activity-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // ─── Click restore on the "good" row (the second-most-recent
  // edit row — the most recent is the BAD edit; we want to revert
  // TO the good state which is the row BEFORE the bad one). ───────
  await flow.heading('Restore the version you want back', 3)
  await flow.narrate(
    'Find the row that captures the "good" state — the edit BEFORE '
    + 'the mistake. Click the Restore button (history icon) on that '
    + 'row. markoto opens a confirm modal so you can\'t restore by '
    + 'accident — restoring is reversible (the action itself becomes '
    + 'an activity row you can restore from in turn) but it still '
    + 'rewrites the doc for every connected collaborator.'
  )

  // The Restore button on each row carries the i18n label
  // "Restore" (en). Restore semantics: clicking Restore on a row
  // brings the doc back to the state RIGHT BEFORE that row's
  // change (the row's `yjsDocIdBefore` boundary). To revert the
  // "bad" edit we want the state right BEFORE bad = good. So we
  // click Restore on the BAD row, which is the most recent in
  // reverse-chrono order — `restoreButtons.first()`.
  const restoreButtons = page.locator('[data-testid^="activity-row-restore-"]')
  await restoreButtons.first().waitFor({ state: 'visible', timeout: 15_000 })
  await flow.click(
    'Click Restore on the "bad" edit row (top of the feed)',
    restoreButtons.first(),
    {
      // Mobile: restore button sits inside the Activity BottomSheet
      // portal — pointer events intercepted. See `tests/e2e/AGENTS.md`.
      force: editor.isMobile,
      result: 'The confirm modal appears — read the warning, then commit.',
      after: () => page.locator('[data-testid="restore-confirm"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ─── Confirm + verify ──────────────────────────────────────────
  // On mobile the Activity bottom-sheet stays open while the
  // restore confirm modal renders above it; the sheet's
  // `mk-sheet-host` (aria-hidden) intercepts pointer events on
  // the modal's button. Same workaround as cover-page-editor —
  // dispatch the full pointerdown→pointerup→click sequence so
  // Reka's pointer-capture chain fires and the modal commits.
  if (editor.isMobile) {
    await flow.step(
      'Click Restore in the confirm modal',
      async () => {
        await page.locator('[data-testid="restore-confirm"]').evaluate((el: HTMLElement) => {
          const fire = (type: string) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            isPrimary: true
          }))
          fire('pointerdown')
          fire('pointerup')
          el.click()
        })
        await expect(cmContent).not.toContainText(/accidental destructive edit/i, { timeout: 10_000 })
      },
      {
        hero: true,
        result: 'The doc snaps back to the "good" version — the destructive '
          + 'edit is gone, your earlier sentence is intact.'
      }
    )
  } else {
    await flow.click(
      'Click Restore in the confirm modal',
      page.locator('[data-testid="restore-confirm"]'),
      {
        hero: true,
        result: 'The doc snaps back to the "good" version — the destructive '
          + 'edit is gone, your earlier sentence is intact.',
        after: async () => {
          // The restore endpoint runs a Y.js transaction that replaces
          // ytext + commits. Wait for the editor body to NO LONGER
          // contain the bad edit's distinctive text.
          await expect(cmContent).not.toContainText(/accidental destructive edit/i, { timeout: 10_000 })
        }
      }
    )
  }

  // ASSERTION: the doc is in the "good" state — has the kept text,
  // has lost the bad text. Y.js convergence is the load-bearing
  // claim here; assert directly.
  const editorText = await cmContent.textContent()
  expect(editorText).toMatch(/Q3 launch postmortem.*want to keep/i)
  expect(editorText).not.toMatch(/accidental destructive edit/i)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Comments + restore work together — leave a note on a passage you almost lost'
  })
})
