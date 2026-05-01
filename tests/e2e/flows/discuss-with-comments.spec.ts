import { test, expect } from '../fixtures/flow'

// Tier 1, Flow: "Have a discussion in your document".
//
// User-job: leave a thought on a specific passage so collaborators
// can react. Job done when a comment is posted, replied to, and
// resolved — the full thread arc.
//
// Doubles as the canonical e2e smoke test for the comments pipeline:
// every step has a real assertion behind it (the post lands a thread
// + an editor underline; replies thread inline; resolve tucks the
// thread out of the active list).
//
// Captioning rules under v2: imperative caption + declarative result
// on every click; highlights only on outcomes that the user wouldn't
// otherwise notice (the new thread, the resolved section).

test('Have a discussion', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup()

  // ─── Discuss in your doc ────────────────────────────────────────
  await flow.heading('Have a discussion', 3)
  await flow.narrate(
    'markoto documents have threaded comments built in. Highlight a passage, '
    + 'leave a note, and your collaborators see it the moment you post — '
    + 'reply, resolve, or @-mention a workspace member without leaving '
    + 'the doc.'
  )

  // Click the line first to place the caret, then Home + Shift+End to
  // select it — more cross-browser-reliable than triple-click.
  const target = page.locator('.cm-content').getByText('Working together').first()
  await flow.step(
    'Highlight the passage you want to comment on',
    async () => {
      await target.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
    }
  )

  await expect(editor.page.comments.selectionPopupTrigger).toBeVisible()

  // Click the "Add comment" pill. Outcome is the sidebar opening with
  // the composer focused. No highlight on the trigger — the cursor
  // already points at it.
  await flow.click(
    'Click "Add comment" to start a thread',
    editor.page.comments.selectionPopupTrigger,
    {
      result: 'The comments sidebar opens — the composer is focused, ready for your note.',
      after: () => editor.page.comments.composerInput.waitFor({ state: 'visible' })
    }
  )

  await expect(editor.page.comments.composerInput).toBeFocused()

  await flow.type(
    'Write your comment',
    editor.page.comments.composerInput,
    'Should we mention the keyboard shortcuts here too?',
    { result: 'Your draft is ready to post.' }
  )
  await expect(editor.page.comments.composerInput).toHaveValue(
    'Should we mention the keyboard shortcuts here too?'
  )

  // Submit — the thread lands in the sidebar AND the passage gets a
  // yellow underline in the editor. Highlights the new thread because
  // it's a fresh element the user wouldn't notice otherwise.
  await flow.click(
    'Click Submit to post',
    editor.page.comments.composerSubmit,
    {
      result: 'Your comment lands in the sidebar — the passage gets a yellow underline.',
      highlights: [
        { label: 'Your new thread', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )

  // Assertions for thread + decoration. On mobile the comments sidebar
  // overlays the editor full-screen so the .cm-comment-anchor span is
  // hidden behind it — toBeAttached confirms the Y.js → decoration
  // pipeline fired without depending on whether the editor is the
  // currently-foregrounded pane.
  const newThread = editor.page.comments.thread.first()
  await expect(newThread).toBeVisible()
  await expect(newThread).toContainText('Should we mention the keyboard shortcuts')
  await expect(page.locator('.cm-comment-anchor').first()).toBeAttached()

  // ─── Reply to keep the discussion going ────────────────────────────
  await flow.heading('Reply to keep the discussion going', 3)
  await flow.narrate(
    'Each thread has an always-visible reply box at the bottom — no '
    + '"Reply" button to click first. Your replies appear nested under '
    + 'the original, so the order of conversation stays clear.'
  )

  const replyInput = newThread.locator('[data-testid="comment-composer-input"]')
  const replySubmit = newThread.locator('[data-testid="comment-composer-submit"]')

  await flow.type(
    'Type a reply directly under the comment',
    replyInput,
    'Yes — and link to the cheat sheet.',
    { result: 'Your reply is ready to send.' }
  )
  await expect(replyInput).toHaveValue('Yes — and link to the cheat sheet.')

  await flow.click(
    'Submit the reply',
    replySubmit,
    { result: 'Replies thread directly under the original — the order of conversation stays clear.' }
  )

  // Assertions: the reply rendered as a child of the same thread.
  await expect(editor.page.comments.thread).toHaveCount(1)
  await expect(newThread).toContainText('Yes — and link to the cheat sheet.')

  // ─── Resolve when the discussion is done ───────────────────────────
  await flow.heading('Resolve the thread when you\'re done', 3)
  await flow.narrate(
    'Once the question is answered, hit Resolve. The thread tucks into '
    + 'a "Resolved" section so it doesn\'t crowd the active list — but '
    + 'the history stays so you can reopen it later.'
  )

  await flow.click(
    'Click Resolve on the thread',
    editor.page.comments.resolveIn(newThread),
    { result: 'The thread leaves the active list — the editor underline disappears.' }
  )

  await expect(editor.page.comments.thread).toHaveCount(0)
  await expect(page.locator('.cm-comment-anchor')).toHaveCount(0)

  await flow.click(
    'Reveal the Resolved section to confirm it\'s archived',
    editor.page.comments.showResolvedToggle,
    {
      result: 'Resolved threads tuck into their own section — out of the way, but recoverable.',
      highlights: [
        { label: 'Resolved section', selector: '[data-testid="comments-resolved-section-heading"]' }
      ]
    }
  )

  await expect(editor.page.comments.resolvedSectionHeading).toBeVisible()
  await expect(editor.page.comments.thread).toHaveCount(1)
})
