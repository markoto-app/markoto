import { test, expect } from '../fixtures/flow'

// Tier 1, AI Flow: "Summon the AI inside a comment thread".
//
// User-job: the writer has a question about a specific passage —
// "what does this even mean?", "rewrite this clearer", "expand this
// into a full paragraph". Instead of context-switching to the prompt
// bar (which loses the anchor), they tag @ai in a comment on the
// passage itself. The AI joins the thread, can read/edit the
// anchored span, and posts a reply when it's done.
//
// This flow runs against the LIVE Gemini API. NUXT_GOOGLE_GEMINI_API_KEY
// must be set in the host shell.
//
// Coverage: this is also the canonical e2e for the @ai-mention
// trigger — typeahead → token → comment post → /trigger-ai → AI
// reply on the same thread.

test('Summon AI from a comment', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows — set it in the host shell before `bun run flows:test`.'
  )
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Sam Reeves')
  await editor.silentSetup()

  // ─── Set the scene ──────────────────────────────────────────────
  await flow.heading('Mention @ai in a comment', 3)
  await flow.narrate(
    'Comments in YPad are threaded — leave one on a specific passage '
    + 'and your collaborators see it the moment you post. The AI is '
    + 'just another collaborator: type @ai inside any comment and '
    + 'the AI joins the thread, reads the anchored text, and replies.'
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

  // ─── Type @ai → typeahead opens ──────────────────────────────────
  await flow.heading('Pick the AI from the typeahead', 3)
  await flow.narrate(
    'Type @ to mention any workspace member — the AI shows up in the '
    + 'list with a sparkles icon, even on standalone docs without any '
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
        { label: 'AI Assistant — synthetic entry, always available', selector: '[data-testid="mention-typeahead-ai"]' }
      ]
    }
  )
  await expect(editor.page.ai.mentionTypeaheadAi).toBeVisible()

  await flow.click(
    'Click the AI Assistant entry',
    editor.page.ai.mentionTypeaheadAi,
    {
      result: 'The composer now reads "@ai " — finish your question.',
      // Confirm the literal token landed in the input. The synthetic
      // AI entry inserts the bare-word `@ai ` (with trailing space)
      // rather than a structured @[Name](user:N) token.
      after: () => expect(editor.page.comments.composerInput).toHaveValue(/@ai\s/)
    }
  )

  // Finish typing the question. The composer caret is right after
  // "@ai " thanks to the typeahead pick — pressSequentially appends.
  const question = 'what does \'view-only\' actually mean here?'
  await flow.type(
    'Finish your question',
    editor.page.comments.composerInput,
    question,
    { result: 'Your question is ready — submit to summon the AI.' }
  )
  await expect(editor.page.comments.composerInput).toHaveValue(`@ai ${question}`)

  // ─── Submit → AI joins the thread ────────────────────────────────
  await flow.heading('The AI joins your thread', 3)
  await flow.narrate(
    'Once you post, the comment lands like any other — but the '
    + 'thread card lights up with a rainbow ring and an "AI is '
    + 'responding…" badge. The AI is reading the anchored passage '
    + 'and the conversation so far, then replying in the same '
    + 'thread so the discussion stays in one place.'
  )

  await flow.click(
    'Click Submit to post and trigger the AI',
    editor.page.comments.composerSubmit,
    {
      result: 'Your comment lands — the thread glows with a rainbow ring while the AI works.',
      // Wait for the AI-active visual state. The rainbow-ring class
      // (.is-ai-active) is keyed off awareness's commentThreadId, so
      // its presence confirms the trigger endpoint actually fired
      // AND the awareness round-trip completed.
      after: () => editor.page.ai.activeThread.waitFor({ state: 'visible' }),
      highlights: [
        { label: 'AI is responding', selector: '[data-testid="comment-thread"][data-ai-active="true"]' }
      ]
    }
  )

  // ASSERTION: thread exists, comment posted, AI session is in flight
  // server-side (visible via the data-ai-active attribute).
  await expect(editor.page.comments.thread.first()).toContainText(question)
  await expect(editor.page.ai.activeThread).toHaveCount(1)

  // ─── Wait for AI's reply to land ─────────────────────────────────
  await flow.heading('See the AI\'s reply', 3)
  await flow.narrate(
    'The AI uses tools to inspect the document and craft a response. '
    + 'When it\'s done, it replies on this thread — same surface a '
    + 'human collaborator would use. The rainbow ring fades and the '
    + 'reply is just another message you can react to.'
  )

  const thread = editor.page.comments.thread.first()
  // The trigger-flavour system prompt mandates a closing
  // `reply_to_comment` so we expect AT LEAST 2 messages in the
  // thread (the user's @ai comment + the AI's reply) once the loop
  // finishes. Use a polling expect because Gemini's wallclock varies
  // run-to-run.
  await expect(async () => {
    const messageCount = await thread.locator('[data-testid="comment-item"]').count()
    expect(messageCount).toBeGreaterThanOrEqual(2)
  }).toPass({ timeout: 240_000 })

  // Wait for the active ring to fade — the loop has terminated.
  await expect(editor.page.ai.activeThread).toHaveCount(0, { timeout: 30_000 })

  await flow.shot(
    'The AI replied on the thread — the conversation stays in one place.',
    {
      highlights: [
        { label: 'AI Assistant\'s reply', selector: '[data-testid="comment-thread"]' }
      ]
    }
  )
})
