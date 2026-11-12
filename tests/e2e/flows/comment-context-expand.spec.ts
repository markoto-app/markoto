import { test, expect } from '../fixtures/flow'
import { waitForSyncDebounce, settleAnimations } from '../fixtures/waits'

// Tier 2: "Replay any comment in its original context".
//
// User-job: a writer scrolls back through the Activity tab, sees
// "Sam commented" three weeks ago, and wants to know what the
// thread looked like at THAT moment, what the parent comment
// said, who replied, was it resolved already. Click the comment
// row in the Activity feed; the comment-context drawer expands
// in place showing the thread state as of that activity.
//
// Pipeline: ActivityFeed lazy-loads `ActivityRowCommentContext`
// on click → fetches `/api/docs/:docId/activity/:activityId/comment-context`
// → the server reads from the `comments_snapshot` table (sync-server
// posts a snapshot on every comment.* mutation, advisory-locked
// per-doc) → returns the thread state at that activity row → the
// drawer renders parent + replies in chronological order.
//
// Distinct from `discuss-with-comments` (the Tier-1 happy path
// for posting + replying). This flow is the AUDIT side, given
// any past comment activity row, show what it looked like THEN.
//
// Runs on desktop AND mobile. The Activity tab is on the right
// sidebar on desktop and on the bottom-tab-bar on mobile; either path
// loads the same `ActivityFeed` component, and the comment-context
// drawer expands inline either way. Mobile renders the activity rows
// + drawer in a single column instead of a side-panel; the asserted
// row→drawer expansion is identical.
test('Replay a comment in its original context', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  // The commented passage is the sharing rule on line 5.
  await editor.silentSetup({
    title: 'Design review notes',
    body: '# Design review notes\n\n## Sharing\n\nAnyone with the link can edit by default.\n\nOwners can switch a document to view-only or add a password.',
    cover: false
  })

  // Post a comment so there's a `comment.added` row in Activity.
  // Use the same path discuss-with-comments does: select text,
  // open the selection-popup, type, submit. Keep it short, the
  // story is the AUDIT view, not the comment composition.
  const target = page.locator('.cm-content').getByText('Anyone with the link can edit').first()
  await flow.step(
    'Highlight a passage to comment on',
    async () => {
      await target.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
    }
  )
  await editor.page.comments.selectionPopupTrigger.waitFor({ state: 'visible' })
  await editor.page.comments.selectionPopupTrigger.click()
  await editor.page.comments.composerInput.waitFor({ state: 'visible' })
  await editor.page.comments.composerInput.fill('Should we restrict editing here for the public version?')
  // Mobile: composer-submit is inside the Comments BottomSheet portal.
  // `click()` times out on Reka's overlay interception; DOM-level
  // click bypasses coordinate routing. See `tests/e2e/AGENTS.md`.
  if (editor.isMobile) {
    await editor.page.comments.composerSubmit.evaluate((el: HTMLElement) => el.click())
  } else {
    await editor.page.comments.composerSubmit.click()
  }
  // Give Hocuspocus + sync-server time to flush the comments
  // snapshot (advisory-lock + DB write).
  await waitForSyncDebounce(page)

  await flow.heading('Replay a comment in its original context', 3)
  await flow.narrate(
    'Every time someone posts, replies, resolves, or deletes a '
    + 'comment, markoto keeps a snapshot of that thread in the '
    + 'Activity log. Click the row in Activity and the '
    + 'drawer expands showing the thread the way it looked at '
    + 'that exact moment, parent, replies, resolution state, '
    + 'all preserved for as long as the doc lives.'
  )

  // Open the Activity tab
  // On mobile, the comment composer ran inside the Comments bottom
  // sheet (`mk-sheet-host`), which overlays the editor AND the
  // bottom-tab-bar: so the Activity tab is unreachable until the
  // sheet closes. Dismiss it first before the entry-point tap. The
  // sheet's close button is an `aria-label="Close"` glyph in the
  // sheet header (see BottomSheet.vue).
  if (editor.isMobile) {
    // The sheet's OWN close button is also pointer-intercepted by
    // the sheet's overlay (Reka portal stacking quirk). DOM-level
    // click bypasses coordinate routing.
    await page.locator('.mk-sheet-host button[aria-label="Close"]').first().evaluate((el: HTMLElement) => el.click())
    await page.locator('.mk-sheet-host').waitFor({ state: 'detached', timeout: 5_000 })
  }

  // Desktop: right-sidebar tab; mobile: bottom-tab-bar entry.
  const activityTab = editor.isMobile
    ? editor.page.mobileTabs.activity
    : editor.page.sidebar.activity

  await flow.click(
    'Open the Activity tab',
    activityTab,
    {
      annotations: editor.isMobile
        ? []
        : [{ label: 'Activity tab', selector: '[data-testid="sidebar-tab-activity"]', kind: 'arrow' }],
      result: 'The Activity feed opens, one row per edit, comment, restore.',
      after: () => page.locator('[data-activity-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // Click the comment row → context drawer
  await flow.heading('Click the comment row to replay it', 3)
  await flow.narrate(
    'Comment rows in the feed carry a chevron, click to expand. '
    + 'The thread appears inline, exactly as it was at that moment. '
    + 'No modal, no navigation; the editor '
    + 'stays in place.'
  )

  // The comment-add we just posted should be the most-recent
  // activity row. Find a row whose text mentions the body we
  // posted.
  const commentRow = page.locator('[data-activity-id]')
    .filter({ hasText: /comment|Should we restrict/i }).first()
  await flow.click(
    'Click the comment-added row',
    commentRow,
    {
      // Mobile: activity row lives inside the Activity BottomSheet.
      force: editor.isMobile,
      hero: true,
      result: 'The comment-context drawer expands, parent body, replies (none yet), resolution state. Anyone reviewing the audit can see this thread the way it looked then.',
      after: async () => {
        await expect(commentRow).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 })
        await settleAnimations(page, 1_500)
      }
    }
  )

  // ASSERTION: the row expanded.
  await expect(commentRow).toHaveAttribute('data-expanded', 'true')

  flow.next({
    slug: 'have-a-discussion',
    why: 'For posting + replying live (vs replaying past threads), the comments-thread flow is the canonical entry'
  })
})
