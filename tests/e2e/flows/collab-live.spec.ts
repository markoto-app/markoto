import { test, expect } from '../fixtures/flow'

// Tier 1: "Two writers, one document, in real time."
//
// User-job: a writer wants to know what "real-time collaboration" in
// markoto actually feels like. The brand pitch is "anyone you invite
// sees your edits arrive in real time", but no other flow proves it.
// Job done when the reader has watched two named users type in the
// same doc, see each other's avatars in the topbar, and watch a
// comment thread land between them.
//
// Two-context flow via `flow.spawn('sam')`. The owner is Maya
// (primary fixture); the collaborator Sam Reeves is a separate
// `BrowserContext` with its own session cookie + identity. Both
// actors push frames into the same manifest in call order, so the
// slideshow reads as one linear story even though there are two
// browsers. The narration explicitly says whose perspective each
// frame is from.
//
// Works on desktop and mobile: presence avatars + remote cursors
// + comments render the same on both form factors.
test('Two writers, one document', async ({ page, flow, editor }) => {
  test.setTimeout(180_000)

  // Maya is the primary actor. Login + silentSetup creates her
  // session, an owned doc, and parks her in the editor.
  await editor.page.loginAsTestUser('Maya Chen')
  // A short agenda, so Maya's line and Sam's paragraph both stay in view
  // on both screens. Cover off: the realtime payoff is the body.
  await editor.silentSetup({
    title: 'Q3 kickoff agenda',
    body: '# Q3 kickoff agenda\n\n1. Welcome and goals for the quarter\n2. Launch retro\n3. Hiring plan\n\n## Notes',
    cover: false
  })
  // Logged-in users get a `private` doc by default. Sam (spawned
  // below as a separate identity) can't access a private doc he
  // wasn't invited to. Open it up to "anyone with the link can
  // edit": same access mode the brand pitches in the welcome doc.
  await editor.page.setAccessMode('open-edit')

  await flow.heading('Two writers, one document', 3)
  await flow.narrate(
    'markoto syncs every keystroke live, open the '
    + 'same link on a second device or send it to a collaborator and '
    + 'their edits arrive on your screen the moment they hit a key. '
    + 'The avatars at the top show who else is in the doc; the '
    + 'coloured ring on a passage shows where their cursor is.'
  )

  // Maya alone
  await flow.heading('You\'re the only one in the doc, for now', 3)
  await flow.narrate(
    'You see one avatar in the topbar, yours. Type freely; the '
    + 'cursor is yours; the doc is yours.'
  )

  // Maya types a one-line draft so there's something on the page
  // for Sam to react to. Click into the editor first to focus.
  const cmContent = page.locator('.cm-content')
  await cmContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')
  await cmContent.pressSequentially('Q3 launch: what shipped, what slipped, what we learned.')

  await flow.shot(
    'You start a draft. Top-right: just your avatar. Nobody else here yet.'
  )

  // Capture the share URL so Sam can join via the same link.
  const docUrl = page.url()

  // Sam joins
  await flow.heading('Sam joins via the share link', 3)
  await flow.narrate(
    'You send Sam the URL. Sam logs in on their own browser, opens '
    + 'the link, and lands in the same doc, separate identity, '
    + 'separate session, same content.'
  )

  // Spawn Sam: fresh BrowserContext (clean cookies), separate
  // identity. Login as Sam on that context BEFORE navigating to
  // the doc so the presence ring carries Sam's name + colour
  // instead of an anonymous "Guest".
  const sam = await flow.spawn('sam')
  await sam.editor.loginAsTestUser('Sam Reeves')
  await sam.page.goto(docUrl)
  await sam.editor.waitForReady()

  // Sam's first capture: Sam's POV of the doc. Two avatars in the
  // topbar (Maya was already here; Sam just arrived).
  await sam.flow.shot(
    'Sam lands in the doc. Both avatars show in the topbar, Sam at '
    + 'the front (themselves), Maya right next to them.'
  )

  // Sam types: Maya sees it land
  await flow.heading('Sam types: you see it land in real time', 3)
  await flow.narrate(
    'Sam adds a paragraph. On your screen the characters appear at '
    + 'Sam\'s cursor a fraction of a second after Sam types them. There '
    + 'is no "save" button, every keystroke is already saved, and '
    + 'everyone in the doc sees the same text.'
  )

  // Sam types a paragraph at the end of the doc. The action is on
  // Sam's editor (so the SAM flow captures Sam's POV); we then
  // immediately capture from Maya's flow to show the same edit
  // landing on her screen.
  const samCmContent = sam.page.locator('.cm-content')
  await samCmContent.click()
  await samCmContent.press(`${accel}+End`)
  await samCmContent.press('Enter')
  await samCmContent.press('Enter')
  // Type slowly enough that the Y.js batching produces a visible
  // remote-cursor render on Maya's side mid-stream. pressSequentially
  // already simulates per-character keypresses; default delay is
  // fine but a small explicit one keeps the streaming visible.
  await samCmContent.pressSequentially(
    'Avatar regression caught early via the staged rollout.',
    { delay: 25 }
  )

  await sam.flow.shot('Sam finishes typing. Their paragraph is at the end of the doc.')

  // Maya's POV: the SAME paragraph lands in her editor. She didn't
  // type it; Sam did; Y.js delivered it. The PresenceBar shows
  // Sam's avatar to confirm "this came from Sam".
  await expect(cmContent).toContainText('Avatar regression caught early via the staged rollout.')
  await editor.page.scrollEditorTo('Avatar regression caught early')
  await flow.shot(
    'On YOUR screen: Sam\'s paragraph appeared at the end of the doc, '
    + 'with no action from you. The avatar in the topbar tells you who.',
    {
      hero: true,
      highlights: [
        { label: 'Sam\'s edit landed live', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: both editors carry the same text. Y.js convergence
  // is the load-bearing claim of the brand; assert it directly.
  const mayaText = await cmContent.textContent()
  const samText = await samCmContent.textContent()
  expect(mayaText).toMatch(/Avatar regression caught early/i)
  expect(samText).toMatch(/Avatar regression caught early/i)
  expect(mayaText).toMatch(/what shipped, what slipped/i)

  // A comment thread between them
  await flow.heading('Sam leaves a comment for you', 3)
  await flow.narrate(
    'Sam highlights the line you wrote and leaves a thought. The '
    + 'comment thread appears in your sidebar within a second; the '
    + 'anchored passage gets a yellow underline. You can reply '
    + 'inline: same thread, no email loop, no Slack tab-switch.'
  )

  // Sam highlights a line + leaves a comment. Use the Comments
  // page-object on the SAM editor.
  const samTarget = samCmContent.getByText('Q3 launch').first()
  await samTarget.click()
  await sam.page.keyboard.press('Home')
  await sam.page.keyboard.press('Shift+End')
  await sam.editor.comments.selectionPopupTrigger.click()
  await sam.editor.comments.composerInput.waitFor({ state: 'visible' })
  await sam.editor.comments.composerInput.pressSequentially(
    'Should we lead with what slipped, since that\'s the audience\'s biggest worry?'
  )
  // Mobile: composer-submit lives inside the Comments BottomSheet
  // portal where Reka's overlay intercepts pointer events. DOM-level
  // click bypasses coordinate routing. See `tests/e2e/AGENTS.md`.
  if (editor.isMobile) {
    await sam.editor.comments.composerSubmit.evaluate((el: HTMLElement) => el.click())
  } else {
    await sam.editor.comments.composerSubmit.click()
  }
  await sam.editor.comments.thread.first().waitFor({ state: 'visible' })

  await sam.flow.shot('Sam posts the comment. The thread sits in their sidebar.')

  // Open Maya's Comments panel so the thread is visible. The
  // thread element only mounts when the Comments panel is shown
  // (it's keyed off `rightSidebar === 'comments'`); on the
  // viewer/owner side, we need to explicitly open the panel
  // before asserting on its content.
  if (!editor.isMobile) {
    await editor.page.sidebar.comments.click()
  } else {
    await editor.page.mobileTabs.comments.click()
  }
  await editor.page.comments.thread.first().waitFor({ state: 'visible', timeout: 10_000 })
  // Bring the anchored line into view on Maya's screen too.
  await editor.page.scrollEditorTo('what shipped, what slipped')

  await flow.shot(
    'On YOUR screen: Sam\'s comment lands in your sidebar, anchored '
    + 'to the line you wrote. Reply inline; the conversation lives '
    + 'with the doc.',
    {
      highlights: [
        { label: 'Sam\'s comment', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )

  // ASSERTION: both Maya AND Sam see the thread (Y.js convergence
  // on the comment Y.Array, not just the text).
  await expect(editor.page.comments.thread).toHaveCount(1)
  await expect(sam.editor.comments.thread).toHaveCount(1)
  const mayaCommentText = await editor.page.comments.thread.first().textContent()
  expect(mayaCommentText).toMatch(/lead with what slipped/i)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Want the full comments tour? Reply, resolve, archive, same surface, deeper'
  })
})
