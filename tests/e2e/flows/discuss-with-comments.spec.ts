import { test, expect, skipVariants } from '../fixtures/flow'

// Tier 1, Flow: "Have a discussion in your document".
//
// User-job: leave a thought on a specific passage so collaborators
// can react. Job done when a comment is posted, replied to, and
// resolved — the full thread arc.
//
// This flow is also the canonical end-to-end smoke test for the
// comments pipeline: every assertion verifies a real product
// behaviour (the floating pill responds to selection, the post
// lands a thread + an editor underline, replies thread inline,
// resolve tucks the thread out of the active list).
//
// Captioning rule: user-voice only. No "Y.js anchor", no "the
// CM6 view dispatches", no "the trusted client mutates the array".

test('Have a discussion', async ({ page, flow, editor }, info) => {
  // Single-variant capture: light only. The flow exercises threaded
  // discussion mechanics (selection → pill → composer → underline →
  // reply → resolve) — the dual-mode capture would just re-take the
  // same screenshots with reversed background colours. Skip the dark
  // run to keep CI cheap and avoid a known cross-project hydration
  // race when sequential silentSetup runs share a Nuxt subprocess.
  skipVariants(info, ['dark'], 'comment threading flow demos in light only')

  // Setup is plumbing — the user is already in their doc when the
  // story starts. silentSetup gives us a blank doc seeded with the
  // welcome content; we use a known phrase from that doc as the
  // selection target.
  await editor.silentSetup()

  // ─── Discuss in your doc ────────────────────────────────────────
  await flow.heading('Have a discussion', 3)
  await flow.narrate(
    'YPad documents have threaded comments built in. Highlight a passage, '
    + 'leave a note, and your collaborators see it the moment you post — '
    + 'reply, resolve, or @-mention a workspace member without leaving '
    + 'the doc.'
  )

  // The welcome doc opens with a recognisable "Working together" heading
  // we can target reliably. We first click on it to place the caret on
  // that line, then use keyboard Home + Shift+End to select the whole
  // line — more reliable across browsers than triple-click, which CM6
  // sometimes interprets differently from native contenteditable.
  // Either way, CM6 updates its selection state and the document-level
  // `selectionchange` listener fires, making our floating "Add comment"
  // pill decide it should appear.
  const target = page.locator('.cm-content').getByText('Working together').first()
  await flow.step(
    'Highlight the passage you want to comment on',
    async () => {
      await target.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
    }
  )

  // ASSERTION: the pill is rendered. If it isn't, the selection signal
  // isn't reaching the popup component.
  await expect(editor.page.comments.selectionPopupTrigger).toBeVisible()

  await flow.shot('"Add comment" appears right under your selection', {
    highlights: [
      { label: 'Click here to start a thread', selector: '[data-testid="comment-selection-popup-trigger"]' }
    ]
  })

  // Click-then-side-effect: the click opens the comments sidebar and
  // focuses the draft composer. flow.click hovers FIRST so the cursor
  // is visibly on the pill in the screenshot, THEN clicks. After the
  // click the sidebar mounts.
  await flow.click(
    'Click "Add comment" to start a thread',
    editor.page.comments.selectionPopupTrigger
  )

  // ASSERTION: the sidebar opened, the draft composer is mounted and
  // focused. If the click handler regresses, this catches it before
  // the screenshot ever shows up wrong.
  await expect(editor.page.comments.composerInput).toBeVisible()
  await expect(editor.page.comments.composerInput).toBeFocused()

  // Type the comment. pressSequentially fires real keystrokes that
  // run the v-model bind through every interim length, exactly like
  // a typing user.
  await flow.step(
    'Write your comment',
    () => editor.page.comments.composerInput.pressSequentially(
      'Should we mention the keyboard shortcuts here too?'
    )
  )
  await expect(editor.page.comments.composerInput).toHaveValue(
    'Should we mention the keyboard shortcuts here too?'
  )

  await flow.click(
    'Click Submit to post',
    editor.page.comments.composerSubmit
  )

  // ASSERTIONS — the thread landed AND the editor underline appeared.
  // Without both, posting is broken even if the screenshots look fine.
  const newThread = editor.page.comments.thread.first()
  await expect(newThread).toBeVisible()
  await expect(newThread).toContainText('Should we mention the keyboard shortcuts')

  // The decoration extension paints `cm-comment-anchor` on every active
  // anchor range. If this isn't visible, the Y.js → decoration pipeline
  // didn't fire.
  await expect(page.locator('.cm-comment-anchor').first()).toBeVisible()

  await flow.shot(
    'Your comment lands in the sidebar — the passage gets a yellow underline',
    {
      highlights: [
        { label: 'Your new thread', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )

  // ─── Reply to keep the discussion going ────────────────────────────
  await flow.heading('Reply to keep the discussion going', 3)
  await flow.narrate(
    'Each thread has an always-visible reply box at the bottom — no '
    + '"Reply" button to click first. Your replies appear nested under '
    + 'the original, so the order of conversation stays clear.'
  )

  // Scope the reply input to the thread we just posted. There's only
  // one thread in this flow, but scoping makes the intent explicit and
  // the test robust if a future variant adds a second thread first.
  const replyInput = newThread.locator('[data-testid="comment-composer-input"]')
  const replySubmit = newThread.locator('[data-testid="comment-composer-submit"]')

  await flow.step(
    'Type a reply directly under the comment',
    async () => {
      await replyInput.click()
      await replyInput.pressSequentially('Yes — and link to the cheat sheet.')
    }
  )
  await expect(replyInput).toHaveValue('Yes — and link to the cheat sheet.')

  await flow.click('Submit the reply', replySubmit)

  // ASSERTION: the reply rendered as a child of the same thread (so
  // `thread` still has length 1 — replies are NOT separate threads).
  await expect(editor.page.comments.thread).toHaveCount(1)
  await expect(newThread).toContainText('Yes — and link to the cheat sheet.')

  await flow.shot('Replies thread directly under the original')

  // ─── Resolve when the discussion is done ───────────────────────────
  await flow.heading('Resolve the thread when you\'re done', 3)
  await flow.narrate(
    'Once the question is answered, hit Resolve. The thread tucks into '
    + 'a "Resolved" section so it doesn\'t crowd the active list — but '
    + 'the history stays so you can reopen it later.'
  )

  await flow.click(
    'Click Resolve on the thread',
    editor.page.comments.resolveIn(newThread)
  )

  // ASSERTION: the active list is empty (the thread moved to resolved)
  // — the Resolved section heading appears once we toggle "Show
  // resolved", AND the editor underline disappears (resolved threads
  // don't paint).
  await expect(editor.page.comments.thread).toHaveCount(0)
  await expect(page.locator('.cm-comment-anchor')).toHaveCount(0)

  await flow.click(
    'Reveal the Resolved section to confirm it\'s archived',
    editor.page.comments.showResolvedToggle
  )

  await expect(editor.page.comments.resolvedSectionHeading).toBeVisible()
  await expect(editor.page.comments.thread).toHaveCount(1) // resolved thread re-appears

  await flow.shot(
    'Resolved threads tuck into their own section — out of the way, but recoverable.',
    {
      highlights: [
        { label: 'Resolved section', selector: '[data-testid="comments-resolved-section-heading"]' }
      ]
    }
  )
})
