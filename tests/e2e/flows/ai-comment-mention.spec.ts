import { test, expect, requireLiveAi } from '../fixtures/flow'

// One retry at spec level (CI already runs with retries=2; this matches
// local behaviour for just this live-AI spec). The failures seen in
// release runs of 2026-11-02/03 (chat on mistral-small-2603) were all the same
// model behaviour, not a test race: after `view_document` the model
// sometimes answered the question by `replace_text`-ing the anchored
// passage with the answer, which orphans the comment anchor
// (`data-anchored="false"`) even though a reply lands. That is the
// product misbehaving (commentTriggerPrompt.ts says questions get an
// answer, not an edit), so the anchored/unchanged-passage assertions
// stay strict. Not seen since the flows moved to zai-glm-5-3-flash.
test.describe.configure({ retries: 1 })

// Tier 1, AI Flow: "Summon the AI inside a comment thread".
//
// User-job: the writer has a question about a specific passage —
// "what does this even mean?", "rewrite this clearer", "expand this
// into a full paragraph". Instead of context-switching to the prompt
// bar (which loses the anchor), they tag @markoto in a comment on the
// passage itself. The AI joins the thread, can read/edit the
// anchored span, and posts a reply when it's done.
//
// This flow runs against live Mistral via LiteLLM. The proxy needs
// MISTRAL_API_KEY in its container env (forwarded by flows-ephemeral.ts).
//
// Coverage: this is also the canonical e2e for the @markoto-mention
// trigger — typeahead → token → comment post → /trigger-ai → AI
// reply on the same thread. (`@ai` is still accepted by the server-
// side trigger regex for back-compat, but the typeahead's user-
// facing label and the inserted token are `@markoto` after the
// rename.)

test('Summon AI from a comment', async ({ page, flow, editor }) => {
  requireLiveAi()
  // Mobile takes longer than desktop because the bottom-sheet
  // comments panel + the smaller viewport mean the AI's view_document
  // returns a slightly different scroll context that nudges its
  // tool-use cadence. Bump from 6 min to 10 min on all variants;
  // the live API call dominates wall-clock time anyway.
  test.setTimeout(600_000)

  await editor.page.loginAsTestUser('Sam Reeves')
  // A short sharing guide with the passage the question is about,
  // cover off so it sits on the preview's first page.
  // One short line, so Home / Shift+End selects all of it.
  const passage = 'Anyone with the link can edit by default.'
  await editor.silentSetup({
    title: 'Sharing guide',
    body: `# Sharing guide\n\n## Access\n\n${passage}\n\nSwitch the doc to view-only before you send it to a client.\n\n## Comments\n\nReviewers leave comments on the passage they mean.\n`,
    cover: false
  })

  // ─── Set the scene ──────────────────────────────────────────────
  await flow.heading('Mention @markoto in a comment', 3)
  await flow.narrate(
    'Comments in markoto are threaded — leave one on a specific passage '
    + 'and your collaborators see it the moment you post. markoto is '
    + 'just another collaborator: type @markoto inside any comment and '
    + 'it joins the thread, reads the anchored text, and replies.'
  )

  // The passage the question is about.
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
      // Mobile: selection popup floats over the editor; click target
      // is OK without force, but the resulting comments panel opens
      // in a BottomSheet so subsequent interactions need it.
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
      // Mobile: typeahead popover renders inside the Comments
      // BottomSheet portal — Reka's overlay intercepts pointer
      // events. See `tests/e2e/AGENTS.md` "Bottom-sheet portal
      // interception".
      force: editor.isMobile,
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
  // A plain question: the reply belongs in the thread and the passage
  // must stay as it is. No steering in the prompt — the comment-trigger
  // system prompt (commentTriggerPrompt.ts) tells the AI that questions
  // get an answer, not an edit.
  const question = 'what can a client do with a view-only link?'
  await flow.type(
    'Finish your question',
    editor.page.comments.composerInput,
    question,
    {
      force: editor.isMobile,
      result: 'Your question is ready — submit to summon markoto.'
    }
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
    + 'thread card glows with a "markoto is '
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
      force: editor.isMobile,
      result: 'Your comment lands — the thread glows while markoto works.',
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
    + 'human collaborator would use. The glow fades and the '
    + 'reply is just another message you can react to.'
  )

  const thread = editor.page.comments.thread.first()
  // The trigger-flavour system prompt mandates a closing
  // `reply_to_comment` so we expect AT LEAST 2 messages in the
  // thread (the user's @markoto comment + the AI's reply) once the
  // loop finishes. Use a polling expect because the LLM's wallclock
  // varies run-to-run.
  await expect(async () => {
    const messageCount = await thread.locator('[data-testid="comment-item"]').count()
    expect(messageCount).toBeGreaterThanOrEqual(2)
  }).toPass({ timeout: 360_000 })

  // Wait for the active ring to fade — the loop has terminated.
  await expect(editor.page.ai.activeThread).toHaveCount(0, { timeout: 30_000 })
  // A reply can land and the session still end in an error (e.g. the
  // turn limit) — the user would see a "Could not reach markoto" toast.
  await editor.page.expectAiSessionSucceeded()

  // ASSERTION: the thread is still anchored to the passage (the AI
  // answered instead of rewriting it), the passage is unchanged, and
  // markoto's reply is visible in the thread.
  await expect(thread).toHaveAttribute('data-anchored', 'true')
  expect(await editor.page.docText()).toContain(passage)
  const reply = thread.locator('[data-testid="comment-item"]').nth(1)
  await expect(reply).toBeVisible()
  await expect(reply).toContainText('markoto')
  await expect(reply).toContainText(/view|read|comment|edit/i)
  // Comments render plain text — a reply full of Markdown markup
  // (**bold**) would show the asterisks.
  await expect(reply).not.toContainText('**')
  // The reply is the answer, not a note about what markoto is about to do.
  await expect(reply).not.toContainText(/\b(I'll|I will|Let me)\b/)
  await reply.scrollIntoViewIfNeeded()

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
