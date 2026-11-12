import { test, expect } from '../fixtures/flow'
import { waitForSyncDebounce } from '../fixtures/waits'

// Tier 1: "Roll the doc back to an earlier point."
//
// User-job: a writer made an edit they regret and wants to undo it
// after Cmd+Z's history is gone (closed the tab, or the edit happened
// in a separate session). Job done when they've opened the Activity
// tab, picked the right entry, and clicked Restore, the doc snaps
// back to the past state for every connected collaborator.
//
// markoto's Activity tab is the per-doc audit trail: every edit,
// comment, theme change, AI tool call gets a row. Tier 1 is the
// diff drawer (read-only: see what changed). Tier 2 is restore
// (snap the live Y.Doc back). This flow demos Tier 2.
//
// Restore semantics: Restore on a row brings the document back to how
// it was RIGHT BEFORE that row's change (`yjsDocIdBefore`). To undo the
// mistake, the reader restores the mistake's own row, the newest.
//
// Runs on desktop AND mobile. Activity feed renders identically on
// both surfaces (right-sidebar tab on desktop, bottom-tab-bar entry
// on mobile); the restore confirm modal is Reka UI and reflows
// gracefully under `<sm`.

const LAUNCH_DRAFT = [
  '# markoto 2.0 is here',
  '',
  'Today we are releasing markoto 2.0, our biggest update this year. Writing together is faster, themes are easier to tune, and the AI now cites the files it used.',
  '',
  '## What is new',
  '',
  '- Live cursors and comments for every collaborator',
  '- Eight built-in themes, plus your own saved presets',
  '- Grounded answers from your workspace knowledge base',
  '',
  '## Availability'
].join('\n')
const GOOD_EDIT = 'markoto 2.0 rolls out to every workspace on 14 November.'
const MISTAKE = 'Notes for Monday: confirm venue, send agenda.'

test('Restore an earlier version', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Login + private doc + cover off so the preview shows the body.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Launch announcement', body: LAUNCH_DRAFT, cover: false })
  // Let the seeded draft flush as its own batch so the two edits below
  // become separate activity rows (Hocuspocus batch window, see below).
  await waitForSyncDebounce(page)

  await flow.heading('Restore an earlier version of your doc', 3)
  await flow.narrate(
    'markoto records every change to a document (edits, comments, theme '
    + 'changes, AI edits) in the Activity tab. Each entry remembers how the '
    + 'document looked before that change, so you can bring that version '
    + 'back. Restoring takes one click and a confirmation, and everyone '
    + 'with the document open sees it at once.'
  )

  // A real edit, then a mistake
  await flow.heading('An edit, then a mistake', 3)
  await flow.narrate(
    'Maya adds the release date to her announcement. A few seconds later '
    + 'she types her meeting notes into the wrong window: the whole '
    + 'announcement is selected and replaced.'
  )

  const cmContent = page.locator('.cm-content')
  await cmContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')
  await cmContent.pressSequentially(GOOD_EDIT)
  await expect(cmContent).toContainText(GOOD_EDIT)

  await flow.shot('Maya adds the release date at the end of the announcement.')

  // Hocuspocus's onStoreDocument is debounced 2 s in `sync-server/
  // src/index.ts`. To get TWO distinct activity rows (one per typing
  // burst) we have to let the first batch FLUSH before the second
  // typing starts: otherwise both typings collapse into one row and
  // restoring the mistake would also drop the release date. 3 s = 2 s
  // debounce + 1 s safety (polling exits at flush time, while the next
  // keystroke can still land in the same batch).
  await waitForSyncDebounce(page)

  // The mistake: select everything and type over it.
  await cmContent.press(`${accel}+A`)
  await cmContent.pressSequentially(MISTAKE)
  await expect(cmContent).not.toContainText(GOOD_EDIT)

  await flow.shot(
    'Oops: the announcement is gone, replaced by a line of meeting notes. '
    + 'Undo would fix it right away, but not after the tab is closed.'
  )

  // Let the mistake flush as its own row before opening Activity.
  await waitForSyncDebounce(page)

  // Open Activity
  await flow.heading('Open the Activity tab', 3)

  // Desktop: right-sidebar Activity tab; mobile: bottom-tab-bar entry.
  const activityTab = editor.isMobile
    ? editor.page.mobileTabs.activity
    : editor.page.sidebar.activity

  await flow.click(
    'Click the Activity tab',
    activityTab,
    {
      result: 'The newest change is at the top: the edit that replaced the announcement.',
      // Wait on a real activity row attribute, not `getByText(/edit/i)`.
      // The bare regex matches the (hidden-on-mobile) menubar Edit
      // button at `data-testid="menubar-edit"`, which exists in DOM
      // under `<sm` but is `hidden sm:block`-clipped, Playwright's
      // visible-state polling stalls forever on it.
      after: () => page.locator('[data-activity-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // Restore
  await flow.heading('Undo the mistake', 3)
  await flow.narrate(
    'Restore on an entry brings the document back to how it was just '
    + 'before that change. To undo the mistake, use Restore on the '
    + 'mistake itself: the newest entry, at the top.'
  )

  const restoreButtons = page.locator('[data-testid^="activity-row-restore-"]')
  await restoreButtons.first().waitFor({ state: 'visible', timeout: 15_000 })
  await flow.click(
    'Click Restore on the newest entry, the mistake',
    restoreButtons.first(),
    {
      // Mobile: restore button sits inside the Activity BottomSheet
      // portal: pointer events intercepted. See `tests/e2e/AGENTS.md`.
      force: editor.isMobile,
      result: 'markoto asks you to confirm before it changes the document for everyone.',
      after: () => page.locator('[data-testid="restore-confirm"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  const confirm = page.locator('[data-testid="restore-confirm"]')
  const restored = async () => {
    await expect(cmContent).not.toContainText(MISTAKE, { timeout: 10_000 })
    await expect(cmContent).toContainText(GOOD_EDIT)
    // The hero shows the result, not a closing dialog with a spinner.
    await expect(confirm).toBeHidden({ timeout: 10_000 })
    await editor.page.dismissToasts()
  }
  const restoredCaption = 'The announcement is back, release date included. Only the mistake is gone.'

  if (editor.isMobile) {
    // On mobile the Activity bottom-sheet stays open while the
    // restore confirm modal renders above it; the sheet's
    // `mk-sheet-host` (aria-hidden) intercepts pointer events on
    // the modal's button. Same workaround as cover-page-editor,
    // dispatch the full pointerdown→pointerup→click sequence so
    // Reka's pointer-capture chain fires and the modal commits.
    // eslint-disable-next-line playwright/no-force-option -- mobile-only branch: the bottom-sheet portal intercepts the pointer (tests/e2e/AGENTS.md)
    await flow.hover('Click Restore in the confirmation', confirm, { force: true })
    await confirm.evaluate((el: HTMLElement) => {
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
    await restored()
    // Close the Activity sheet so the hero shows the document itself.
    await page.keyboard.press('Escape')
    await page.locator('.mk-sheet-host').waitFor({ state: 'detached' })
    await flow.shot(restoredCaption, { hero: true })
  } else {
    await flow.click(
      'Click Restore in the confirmation',
      confirm,
      { hero: true, result: restoredCaption, after: restored }
    )
  }

  // ASSERTION: the document is the announcement plus the release date,
  // and the mistake is gone. Y.js state, not just the rendered lines.
  const text = await editor.page.docText()
  expect(text).toContain('## Availability')
  expect(text).toContain(GOOD_EDIT)
  expect(text).not.toContain(MISTAKE)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Leave your co-authors a note on the passage you just brought back'
  })
})
