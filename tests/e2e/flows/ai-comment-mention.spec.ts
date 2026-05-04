import { test, expect } from '../fixtures/flow'

// Tier 1, AI Flow: "Summon the AI inside a comment thread".
//
// User-job: the writer has a question about a specific passage —
// "what does this even mean?", "rewrite this clearer", "expand this
// into a full paragraph". Instead of context-switching to the prompt
// bar (which loses the anchor), they tag @markoto in a comment on the
// passage itself. The AI joins the thread, can read/edit the
// anchored span, and posts a reply when it's done.
//
// This flow runs against the LIVE Gemini API. NUXT_GOOGLE_GEMINI_API_KEY
// must be set in the host shell.
//
// Coverage: this is also the canonical e2e for the @markoto-mention
// trigger — typeahead → token → comment post → /trigger-ai → AI
// reply on the same thread. (`@ai` is still accepted by the server-
// side trigger regex for back-compat, but the typeahead's user-
// facing label and the inserted token are `@markoto` after the
// rename.)

test('Summon AI from a comment', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows — set it in the host shell before `bun run flows:test`.'
  )
  // Mobile takes longer than desktop because the bottom-sheet
  // comments panel + the smaller viewport mean Gemini's view_document
  // returns a slightly different scroll context that nudges its
  // tool-use cadence. Bump from 6 min to 10 min on all variants;
  // the live API call dominates wall-clock time anyway.
  test.setTimeout(600_000)

  await editor.page.loginAsTestUser('Sam Reeves')
  await editor.silentSetup()
  // Disable the cover sheet so the comment-anchored passage IS
  // visible on page 1 of the preview iframe (the markoto theme
  // ships cover.enabled=true; "Anyone with the link can edit" sits
  // on page 2+ behind it otherwise).
  await editor.page.disableCoverPage()

  // ─── Set the scene ──────────────────────────────────────────────
  await flow.heading('Mention @markoto in a comment', 3)
  await flow.narrate(
    'Comments in markoto are threaded — leave one on a specific passage '
    + 'and your collaborators see it the moment you post. markoto is '
    + 'just another collaborator: type @markoto inside any comment and '
    + 'it joins the thread, reads the anchored text, and replies.'
  )

  // Pick a line from the seeded welcome doc. "Anyone with the link
  // can edit by default." — short, recognizable, and gives the AI a
  // concrete passage to react to.
  const target = page.locator('.cm-content').getByText('Anyone with the link can edit').first()
  await flow.step(
    'Highlight the passage you want to ask about',
    async () => {
      await target.click()
      await page.keyboard.press('Home')
      await page.keyboard.press('Shift+End')
    }
  )
  await expect(editor.page.comments.selectionPopupTrigger).toBeVisible()

  await flow.click(
    'Click "Add comment" to start a thread',
    editor.page.comments.selectionPopupTrigger,
    {
      result: 'The comments sidebar opens — composer focused, ready for your note.',
      after: () => editor.page.comments.composerInput.waitFor({ state: 'visible' })
    }
  )
  await expect(editor.page.comments.composerInput).toBeFocused()

  // ─── Type @ → typeahead opens ────────────────────────────────────
  await flow.heading('Pick markoto from the typeahead', 3)
  await flow.narrate(
    'Type @ to mention any workspace member — markoto shows up in the '
    + 'list with a seal, even on standalone docs without any '
    + 'workspace members. Pick it, finish your question, and submit.'
  )

  // pressSequentially per keystroke so the composer's caret-tracking
  // logic fires (it watches `input` events to decide when to open
  // the typeahead). Type "@" first to open the popover.
  await flow.step(
    'Type @ to open the mention typeahead',
    async () => {
      await editor.page.comments.composerInput.pressSequentially('@')
    },
    {
      highlights: [
        { label: 'markoto — synthetic entry, always available', selector: '[data-testid="mention-typeahead-ai"]' }
      ]
    }
  )
  await expect(editor.page.ai.mentionTypeaheadAi).toBeVisible()

  await flow.click(
    'Click the markoto entry',
    editor.page.ai.mentionTypeaheadAi,
    {
      // Direction-anchor the typeahead row on the approach frame —
      // even with the typeahead open, the markoto row sits among
      // workspace members and a first-time reader needs the arrow
      // to know which one summons the AI.
      annotations: [
        { label: 'markoto entry', selector: '[data-testid="mention-typeahead-ai"]', kind: 'arrow' }
      ],
      result: 'The composer now reads "@markoto " — finish your question.',
      // Confirm the literal token landed in the input. The synthetic
      // markoto entry inserts the bare-word `@markoto ` (with trailing
      // space) rather than a structured @[Name](user:N) token. The
      // server-side trigger regex still accepts the legacy `@ai`
      // form for back-compat, but the typeahead-inserted token is
      // `@markoto` after the rename.
      after: () => expect(editor.page.comments.composerInput).toHaveValue(/@markoto\s/)
    }
  )

  // Finish typing the question. The composer caret is right after
  // "@markoto " thanks to the typeahead pick — pressSequentially appends.
  const question = 'what does \'view-only\' actually mean here?'
  await flow.type(
    'Finish your question',
    editor.page.comments.composerInput,
    question,
    { result: 'Your question is ready — submit to summon markoto.' }
  )
  await expect(editor.page.comments.composerInput).toHaveValue(`@markoto ${question}`)

  // GUARD against the awareness-not-yet-populated race that surfaced
  // on mobile re-runs: maybeTriggerAi() in CommentsPanel.vue early-
  // returns when `viewerId.value === null`, and viewerId is read off
  // `awareness.user.id`. If the session-aware bootstrap hasn't fired
  // by the time the test clicks Submit (mobile is slower to hydrate
  // because the bottom-sheet pattern adds a beat), the trigger
  // silently no-ops, the AI session never starts, and the
  // `data-ai-active="true"` wait runs out the test wall clock.
  //
  // `__DEBUG_awareness` is the in-page handle exposed by useDocument
  // when `NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1` (the flow-test stack
  // sets it; prod doesn't). Wait until our local awareness state
  // carries a numeric user.id before submitting.
  await editor.page.page.waitForFunction(
    () => {
      const w = window as unknown as { __DEBUG_awareness?: { getLocalState: () => { user?: { id?: number } } | null } }
      const state = w.__DEBUG_awareness?.getLocalState?.()
      return typeof state?.user?.id === 'number'
    },
    { timeout: 10_000 }
  )

  // ─── Submit → markoto joins the thread ───────────────────────────
  await flow.heading('markoto joins your thread', 3)
  await flow.narrate(
    'Once you post, the comment lands like any other — but the '
    + 'thread card lights up with a rainbow ring and a "markoto is '
    + 'responding…" badge. markoto is reading the anchored passage '
    + 'and the conversation so far, then replying in the same '
    + 'thread so the discussion stays in one place.'
  )

  // Listen for the trigger-ai POST and CAPTURE its response status —
  // if the trigger fires but returns 401/403/5xx, maybeTriggerAi
  // silently swallows it, the AI never starts, and we'd time out
  // on the activeThread ring. Surface the failure here.
  const triggerResponsePromise = page.waitForResponse(
    res => res.url().includes('/trigger-ai') && res.request().method() === 'POST',
    { timeout: 15_000 }
  )

  await flow.click(
    'Click Submit to post and trigger markoto',
    editor.page.comments.composerSubmit,
    {
      result: 'Your comment lands — the thread glows with a rainbow ring while markoto works.',
      // Wait for the AI-active visual state. The rainbow-ring class
      // (.is-ai-active) is keyed off awareness's commentThreadId, so
      // its presence confirms the trigger endpoint actually fired
      // AND the awareness round-trip completed.
      after: async () => {
        // First confirm the trigger HTTP fired AND returned 200.
        // The Vue side swallows 401/403/5xx silently — without this
        // assertion, a non-200 surfaces only as the activeThread
        // ring never appearing (a 10-min test timeout downstream).
        const triggerRes = await triggerResponsePromise.catch(() => null)
        if (!triggerRes) {
          throw new Error('CommentsPanel.maybeTriggerAi never fired POST /trigger-ai — likely viewerId is null when @markoto-comment submits.')
        }
        if (triggerRes.status() !== 200) {
          const body = await triggerRes.text().catch(() => '<no body>')
          throw new Error(`POST /trigger-ai returned ${triggerRes.status()}: ${body.slice(0, 500)}`)
        }
        await editor.page.ai.activeThread.waitFor({ state: 'visible' })
      },
      highlights: [
        { label: 'markoto is responding', selector: '[data-testid="comment-thread"][data-ai-active="true"]' }
      ]
    }
  )

  // ASSERTION: thread exists, comment posted, AI session is in flight
  // server-side (visible via the data-ai-active attribute).
  await expect(editor.page.comments.thread.first()).toContainText(question)
  await expect(editor.page.ai.activeThread).toHaveCount(1)

  // ─── Wait for markoto's reply to land ────────────────────────────
  await flow.heading('See markoto\'s reply', 3)
  await flow.narrate(
    'markoto uses tools to inspect the document and craft a response. '
    + 'When it\'s done, it replies on this thread — same surface a '
    + 'human collaborator would use. The rainbow ring fades and the '
    + 'reply is just another message you can react to.'
  )

  const thread = editor.page.comments.thread.first()
  // The trigger-flavour system prompt mandates a closing
  // `reply_to_comment` so we expect AT LEAST 2 messages in the
  // thread (the user's @markoto comment + the AI's reply) once the
  // loop finishes. Use a polling expect because Gemini's wallclock
  // varies run-to-run.
  await expect(async () => {
    const messageCount = await thread.locator('[data-testid="comment-item"]').count()
    expect(messageCount).toBeGreaterThanOrEqual(2)
  }).toPass({ timeout: 360_000 })

  // Wait for the active ring to fade — the loop has terminated.
  await expect(editor.page.ai.activeThread).toHaveCount(0, { timeout: 30_000 })

  await flow.shot(
    'markoto replied on the thread — the conversation stays in one place.',
    {
      // Hero outcome: markoto's reply landed in the same thread
      // (not a side panel, not a popover) — the "AI is just
      // another collaborator" promise made literal.
      hero: true,
      highlights: [
        { label: 'markoto\'s reply', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )

  // Forward route: now that the reader has used the AI in two
  // surfaces (prompt bar + comments), the natural next move is
  // making the doc look right. Loops the user back into the
  // craft track from the AI track.
  flow.next({
    slug: 'pick-a-theme',
    why: 'Make the doc look the part — pick a theme + add a cover page'
  })
})
