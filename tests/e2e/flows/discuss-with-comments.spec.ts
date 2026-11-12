import { test, expect } from '../fixtures/flow'

// Tier 1, Flow: "Have a discussion in your document".
//
// User-job: leave a thought on a specific passage so collaborators
// can react. Job done when a comment is posted, replied to, and
// resolved: the full thread arc.
//
// Doubles as the canonical e2e smoke test for the comments pipeline:
// every step has a real assertion behind it (the post lands a thread
// + an editor underline; replies thread inline; resolve tucks the
// thread out of the active list).
//
// Captioning rules under v2: imperative caption + declarative result
// on every click; highlights only on outcomes that the user wouldn't
// otherwise notice (the new thread, the resolved section).
//
// Two people: Maya (the owner) comments and resolves, Sam (a spawned,
// separately signed-in browser) replies, a discussion, not one
// anonymous user talking to themselves.

test('Have a discussion', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({
    title: 'Launch plan',
    body: [
      '# Launch plan',
      '',
      'markoto 2.0 goes out in two steps, so support can keep up with the questions.',
      '',
      '## Timeline',
      '',
      'Public beta opens on Saturday, 1 November.',
      '',
      'General availability follows two weeks later, once the beta feedback is in.'
    ].join('\n'),
    cover: false
  })
  // Sam (spawned below) joins through the link: anyone with it can edit.
  await editor.page.setAccessMode('open-edit')

  // Discuss in your doc
  await flow.heading('Have a discussion', 3)
  await flow.narrate(
    'markoto documents have threaded comments built in. Highlight a passage, '
    + 'leave a note, and your collaborators see it the moment you post, '
    + 'reply, resolve, or @-mention a workspace member without leaving '
    + 'the doc.'
  )

  // Click the line first to place the caret, then Home + Shift+End to
  // select it: more cross-browser-reliable than triple-click.
  const target = page.locator('.cm-content').getByText('Public beta opens on Saturday').first()
  await flow.step(
    'Highlight the passage you want to comment on',
    async () => {
      await target.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
    }
  )

  await expect(editor.page.comments.selectionPopupTrigger).toBeVisible()

  // Click the "Add comment" pill. The pill appears as a floating
  // popup ABOVE the selection, not adjacent to the obvious "Comments"
  // sidebar tab: so first-time readers often don't notice it. An
  // arrow annotation on the approach frame fixes that.
  await flow.click(
    'Click "Add comment" to start a thread',
    editor.page.comments.selectionPopupTrigger,
    {
      annotations: [
        { label: 'add-comment pill', selector: '[data-testid="comment-selection-popup-trigger"]', kind: 'arrow' }
      ],
      result: 'The comments sidebar opens, the composer is focused, ready for your note.',
      after: () => editor.page.comments.composerInput.waitFor({ state: 'visible' })
    }
  )

  await expect(editor.page.comments.composerInput).toBeFocused()

  await flow.type(
    'Write your comment',
    editor.page.comments.composerInput,
    'Should we open on Monday instead, when support is fully staffed?',
    {
      // Mobile: comments composer is inside the BottomSheet portal
      // where Reka's overlay intercepts pointer events. See
      // `tests/e2e/AGENTS.md` "Bottom-sheet portal interception".
      force: editor.isMobile,
      result: 'Your draft is ready to post.'
    }
  )
  await expect(editor.page.comments.composerInput).toHaveValue(
    'Should we open on Monday instead, when support is fully staffed?'
  )

  // Submit: the thread lands in the sidebar AND the passage gets a
  // yellow underline in the editor. Highlights the new thread because
  // it's a fresh element the user wouldn't notice otherwise.
  await flow.click(
    'Click Submit to post',
    editor.page.comments.composerSubmit,
    {
      force: editor.isMobile,
      result: 'Your comment lands in the sidebar, the passage gets a yellow underline.',
      highlights: [
        { label: 'Your new thread', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )

  // Assertions for thread + decoration. On mobile the comments sidebar
  // overlays the editor full-screen so the .cm-comment-anchor span is
  // hidden behind it: toBeAttached confirms the Y.js → decoration
  // pipeline fired without depending on whether the editor is the
  // currently-foregrounded pane.
  const newThread = editor.page.comments.thread.first()
  await expect(newThread).toBeVisible()
  await expect(newThread).toContainText('Should we open on Monday instead')
  await expect(page.locator('.cm-comment-anchor').first()).toBeAttached()

  // Sam replies
  await flow.heading('Your collaborator replies', 3)
  await flow.narrate(
    'Sam opens the same document. The thread is waiting in the Comments '
    + 'panel, with a reply box right under it. Replies sit nested under '
    + 'the comment, so the conversation stays in order.'
  )

  const sam = await flow.spawn('sam')
  await sam.editor.loginAsTestUser('Sam Reeves')
  await sam.page.goto(page.url())
  await sam.editor.waitForReady()
  if (editor.isMobile) {
    await sam.editor.mobileTabs.comments.click()
  } else {
    await sam.editor.sidebar.comments.click()
  }
  const samThread = sam.editor.comments.thread.first()
  await expect(samThread).toContainText('Should we open on Monday instead')

  const REPLY = 'Monday works. I will move the support rota.'
  const samReplyInput = samThread.locator('[data-testid="comment-composer-input"]')
  await sam.flow.type(
    'Sam types a reply under the comment',
    samReplyInput,
    REPLY,
    {
      force: editor.isMobile,
      result: 'Sam\'s reply is ready to send.'
    }
  )
  await expect(samReplyInput).toHaveValue(REPLY)
  const samReplySubmit = samThread.locator('[data-testid="comment-composer-submit"]')
  if (editor.isMobile) {
    // Comments BottomSheet portal: DOM-level click (tests/e2e/AGENTS.md).
    await samReplySubmit.evaluate((el: HTMLElement) => el.click())
  } else {
    await samReplySubmit.click()
  }
  await expect(samThread).toContainText(REPLY)

  // Maya's screen: the reply arrives in her thread without a reload.
  await expect(newThread).toContainText(REPLY, { timeout: 10_000 })
  await expect(editor.page.comments.thread).toHaveCount(1)
  await flow.shot(
    'On your screen, Sam\'s reply appears under your comment as soon as he sends it.',
    {
      highlights: [
        { label: 'Sam\'s reply', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )

  // Resolve when the discussion is done
  await flow.heading('Resolve the thread when you\'re done', 3)
  await flow.narrate(
    'Question answered: resolve the thread. It moves into a "Resolved" '
    + 'section so it doesn\'t crowd the active list, and the whole '
    + 'conversation stays there in case you need it again.'
  )

  await flow.click(
    'Click Resolve on the thread',
    editor.page.comments.resolveIn(newThread),
    {
      force: editor.isMobile,
      result: 'The thread leaves the active list, the editor underline disappears.'
    }
  )

  await expect(editor.page.comments.thread).toHaveCount(0)
  await expect(page.locator('.cm-comment-anchor')).toHaveCount(0)

  await flow.click(
    'Reveal the Resolved section to confirm it\'s archived',
    editor.page.comments.showResolvedToggle,
    {
      force: editor.isMobile,
      // Hero outcome: the discussion is closed but the history is
      // preserved. The "out of the way, but recoverable" frame is
      // what makes resolve-as-archive (vs delete) the trustworthy
      // primitive readers need to see.
      hero: true,
      result: 'Resolved threads tuck into their own section, out of the way, but recoverable.',
      highlights: [
        { label: 'Resolved section', selector: '[data-testid="comments-resolved-section-heading"]' }
      ]
    }
  )

  await expect(editor.page.comments.resolvedSectionHeading).toBeVisible()
  await expect(editor.page.comments.thread).toHaveCount(1)

  // Forward route: comments + AI is the next composability the
  // reader hasn't seen: same threaded surface, the AI joins as a
  // collaborator on a passage.
  flow.next({
    slug: 'summon-ai-from-a-comment',
    why: 'Tag @markoto in a comment to summon the AI on a specific passage'
  })
})
