import { test, expect } from '../fixtures/flow'

// Tier 2: "Replay any comment in its original context".
//
// User-job: a writer scrolls back through the Activity tab, sees
// "Sam commented" three weeks ago, and wants to know what the
// thread looked like at THAT moment — what the parent comment
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
// for posting + replying). This flow is the AUDIT side — given
// any past comment activity row, show what it looked like THEN.
//
// Desktop only — the activity drawer + thread context pack
// densely; mobile single-column hides the comparison.
test('Replay a comment in its original context', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Activity tab + comment-context drawer benefit from desktop'
    + ' width; mobile single-column hides the row→drawer relationship.'
  )
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  // Post a comment so there's a `comment.added` row in Activity.
  // Use the same path discuss-with-comments does: select text,
  // open the selection-popup, type, submit. Keep it short — the
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
  await editor.page.comments.composerSubmit.click()
  // Give Hocuspocus + sync-server time to flush the comments
  // snapshot (advisory-lock + DB write).
  await page.waitForTimeout(3_000)

  await flow.heading('Replay a comment in its original context', 3)
  await flow.narrate(
    'Every time someone posts, replies, resolves, or deletes a '
    + 'comment, markoto stamps a snapshot of that thread\'s state '
    + 'into the audit log. Click the row in Activity and the '
    + 'drawer expands showing the thread the way it looked at '
    + 'that exact moment — parent, replies, resolution state, '
    + 'all preserved for as long as the doc lives.'
  )

  // ─── Open the Activity tab ──────────────────────────────────────
  await flow.click(
    'Open the Activity tab',
    editor.page.sidebar.activity,
    {
      annotations: [
        { label: 'Activity tab', selector: '[data-testid="sidebar-tab-activity"]', kind: 'arrow' }
      ],
      result: 'The Activity feed opens — one row per edit, comment, restore.',
      after: () => page.locator('[data-activity-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // ─── Click the comment row → context drawer ─────────────────────
  await flow.heading('Click the comment row to replay it', 3)
  await flow.narrate(
    'Comment rows in the feed carry a chevron — click to expand. '
    + 'The drawer fetches the thread snapshot from the audit log '
    + 'and renders it inline. No modal, no navigation; the editor '
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
      hero: true,
      result: 'The comment-context drawer expands — parent body, replies (none yet), resolution state. Anyone reviewing the audit can see this thread the way it looked then.',
      after: async () => {
        await expect(commentRow).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 })
        await page.waitForTimeout(1_500)
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
