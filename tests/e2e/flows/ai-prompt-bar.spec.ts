import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 1, AI Flow: "Ask the AI to draft something for you".
//
// User-job: the writer has a draft and wants the AI to extend or
// restructure it without leaving the doc. Job done when the AI's
// edits land in the document body and the bar returns to idle.
//
// This flow runs against the LIVE LiteLLM proxy → Mistral, there's
// no fixture or mock. The output is therefore non-deterministic
// between runs (the model picks fresh wording each time), but the
// assertions check behaviour, not exact text. MISTRAL_API_KEY +
// BFL_API_KEY + STAAN_API_KEY must be forwarded into the stack
// via scripts/flows-ephemeral.ts; `requireLiveAi()` enforces
// that up-front rather than failing mid-stream.

test('Write with AI', async ({ flow, editor }) => {
  requireLiveAi()
  // 6 minutes: the agentic loop can take 5-30s per Mistral turn, and
  // multi-tool runs chain several. A simple "extend this" prompt
  // typically resolves in ~15-30s but worst-case (web_search +
  // multiple turns) can hit 2-3 min. 6 min is the budget; failures
  // here usually mean the API key is wrong or the network is dead.
  test.setTimeout(360_000)

  // The prompt bar gates send on `loggedIn`. Anonymous viewers see
  // the bar but it stays disabled. Log in via the TEST_MODE shim
  // BEFORE silentSetup so the doc is owned and the bar is live from
  // the moment the editor mounts.
  await editor.page.loginAsTestUser('Alice Liu')
  // A short, real draft with the cover off, so the section the AI adds
  // at the end lands on the preview's first page.
  const draft = '# Team handbook\n\n## Writing in markoto\n\nWe draft every proposal in markoto so the whole team can edit at once.\n\n## Reviews\n\nLeave a comment on the passage you mean, not on the whole document.\n'
  await editor.silentSetup({ title: 'Team handbook', body: draft, cover: false })

  // Open the AI prompt bar
  await flow.heading('Ask the AI to write for you', 3)
  await flow.narrate(
    'The AI prompt bar floats at the bottom of every markoto document. '
    + 'Type what you want, hit send, and the AI joins the doc as '
    + 'another collaborator: you watch it type. It can draft new '
    + 'sections, rewrite passages, restructure outlines, even fetch '
    + 'sources from the web before it writes.'
  )

  await flow.click(
    'Click into the AI prompt bar to focus it',
    editor.page.ai.promptBarInput,
    {
      // The prompt bar lives at the bottom of the editor, small
      // surface against a busy doc body. Direction-anchor it so a
      // first-time reader doesn't scan the toolbar / sidebar
      // looking for an "AI" tab.
      annotations: [
        { label: 'prompt bar', selector: '[data-testid="ai-prompt-bar"]', kind: 'arrow' }
      ],
      result: 'The bar lifts and glows, ready for your prompt.',
      after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
    }
  )
  await expect(editor.page.ai.promptBarInput).toBeFocused()

  // The prompt is short + crisp, keeping it under 80 chars makes it
  // fit in the captured screenshot without truncating, AND it's a
  // realistic ask the AI can resolve in 1-2 turns.
  const prompt = 'Add a short section about keyboard shortcuts at the end.'
  await flow.type(
    'Type your prompt: like talking to a teammate',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is ready. Hit send to kick off the AI.' }
  )
  await expect(editor.page.ai.promptBarInput).toHaveValue(prompt)

  // Submit + watch the AI work
  await flow.heading('The AI joins your document', 3)
  await flow.narrate(
    'The bar swaps to its active state and pulses while '
    + 'the AI runs. It uses tools to read your document, find the right '
    + 'place to insert, and apply edits. Other collaborators see the '
    + 'changes land live, just like a human collaborator.'
  )

  await flow.click(
    'Click send to submit your prompt',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working, the bar pulses while it edits.',
      // Wait for the active state to flip on. Without this the
      // outcome shot races the prompt-handler response and lands on
      // a still-idle bar.
      after: () => editor.page.waitForAiActive()
    }
  )

  // ASSERTION: a session is in flight server-side AND the UI reflects
  // it. Both checks together confirm the agentic loop actually
  // started: a UI-only check would pass if /api/ai/prompt 500'd but
  // the client optimistically toggled active.
  await expect(editor.page.ai.promptBar).toHaveAttribute('data-active', 'true')

  // Wait for AI to finish + see the result
  await flow.heading('The AI is done', 3)
  await flow.narrate(
    'When the AI is done, the bar fades back to its idle '
    + 'state. The AI\'s edits are now part of your document. '
    + 'Cmd / Ctrl + Z only takes back your own typing, not the AI\'s '
    + 'changes: if you don\'t like what it wrote, use Restore on its '
    + 'entry in the Activity tab, or send another prompt that builds on its work.'
  )

  // Idle = the session ended; waitForAiIdle also fails when it ended
  // in an error (turn limit, provider failure) instead of `done`.
  await editor.page.waitForAiIdle()

  // ASSERTION: the AI added a section about keyboard shortcuts, a
  // heading plus body text, and it shows in the editor and preview.
  const added = await editor.page.addedText(draft)
  expect(added, 'the AI added nothing').toMatch(/^#{1,4} .*shortcut/im)
  expect(added.split('\n').length).toBeGreaterThanOrEqual(2)
  await editor.page.scrollEditorTo(/shortcut/i)
  // Mobile is edit-only by default: show the rendered section, not its
  // markdown source (keyboard-key markup reads as noise there).
  if (editor.isMobile) {
    await flow.click('Tap the eye icon to see the page', editor.page.mobilePreviewButton, {
      chain: true,
      after: () => editor.page.showMobilePreview()
    })
  }
  await editor.page.scrollPreviewTo(':is(h1, h2, h3, h4):has-text("shortcut")')

  await flow.shot(
    editor.isMobile
      ? 'The AI added a "Keyboard shortcuts" section at the end of the doc.'
      : 'The AI added a "Keyboard shortcuts" section at the end of the doc, in the editor and the preview.',
    {
      // Hero outcome: doc content extended by the AI. This IS the
      // payoff of "ask the AI to write for you", a reader who
      // hasn't seen markoto before should clock the difference at
      // the hero strip without reading a step.
      hero: true,
      highlights: [
        // Highlights the editor body, the "outcome" of an AI run is
        // always doc content changing, so the editor pane is the
        // natural anchor. We don't pin to a specific selector inside
        // the editor because the AI's exact output varies between
        // runs.
        editor.isMobile
          ? { label: 'The new section', selector: 'iframe' }
          : { label: 'The new section', selector: '.cm-line:has-text("shortcut")' }
      ]
    }
  )

  // Forward route: same surface (the AI joining as a collaborator)
  // but anchored on a SPECIFIC passage rather than the whole doc.
  // Natural escalation in capability + scope.
  flow.next({
    slug: 'summon-ai-from-a-comment',
    why: 'Ask the AI about a specific passage, tag @markoto in a comment'
  })
})
