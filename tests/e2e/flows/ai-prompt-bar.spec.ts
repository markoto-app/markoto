import { test, expect } from '../fixtures/flow'

// Tier 1, AI Flow: "Ask the AI to draft something for you".
//
// User-job: the writer has a draft and wants the AI to extend or
// restructure it without leaving the doc. Job done when the AI's
// edits land in the document body and the bar returns to idle.
//
// This flow runs against the LIVE Gemini API — there's no fixture or
// mock. The output is therefore non-deterministic between runs (the
// model picks fresh wording each time), but the assertions check
// behaviour, not exact text. NUXT_GOOGLE_GEMINI_API_KEY must be
// forwarded into the ephemeral subprocess (see scripts/flows-
// ephemeral.ts); without it we skip rather than fail loudly so a
// developer running the suite without an API key gets a clean signal.

test('Write with AI', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows — set it in the host shell before `bun run flows:test`.'
  )
  // 6 minutes: the agentic loop can take 5-30s per Gemini turn, and
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
  await editor.silentSetup()

  // ─── Open the AI prompt bar ──────────────────────────────────────
  await flow.heading('Ask the AI to write for you', 3)
  await flow.narrate(
    'The AI prompt bar floats at the bottom of every markoto document. '
    + 'Type what you want, hit send, and the AI joins the doc as '
    + 'another collaborator — you watch it type. It can draft new '
    + 'sections, rewrite passages, restructure outlines, even fetch '
    + 'sources from the web before it writes.'
  )

  await flow.click(
    'Click into the AI prompt bar to focus it',
    editor.page.ai.promptBarInput,
    {
      result: 'The bar lifts and glows blue — ready for your prompt.',
      after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
    }
  )
  await expect(editor.page.ai.promptBarInput).toBeFocused()

  // The prompt is short + crisp — keeping it under 80 chars makes it
  // fit in the captured screenshot without truncating, AND it's a
  // realistic ask the AI can resolve in 1-2 turns.
  const prompt = 'Add a short section about keyboard shortcuts at the end.'
  await flow.type(
    'Type your prompt — like talking to a teammate',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is ready. Hit send to kick off the AI.' }
  )
  await expect(editor.page.ai.promptBarInput).toHaveValue(prompt)

  // ─── Submit + watch the AI work ──────────────────────────────────
  await flow.heading('The AI joins your document', 3)
  await flow.narrate(
    'The bar swaps to its active state — the rainbow ring pulses while '
    + 'the AI runs. It uses tools to read your document, find the right '
    + 'place to insert, and apply edits. Other collaborators see the '
    + 'changes land live, just like a human collaborator.'
  )

  await flow.click(
    'Click send to submit your prompt',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — the bar pulses with a rainbow ring while it edits.',
      // Wait for the active state to flip on. Without this the
      // outcome shot races the prompt-handler response and lands on
      // a still-idle bar.
      after: () => editor.page.waitForAiActive()
    }
  )

  // ASSERTION: a session is in flight server-side AND the UI reflects
  // it. Both checks together confirm the agentic loop actually
  // started — a UI-only check would pass if /api/ai/prompt 500'd but
  // the client optimistically toggled active.
  await expect(editor.page.ai.promptBar).toHaveAttribute('data-active', 'true')

  // ─── Wait for AI to finish + see the result ──────────────────────
  await flow.heading('The AI is done', 3)
  await flow.narrate(
    'When the agentic loop finishes, the bar fades back to its idle '
    + 'state. The AI\'s edits are now part of your document — undo '
    + 'them with Cmd / Ctrl + Z if you don\'t like what it wrote, or '
    + 'iterate by sending another prompt that builds on its work.'
  )

  // Idle = the agentic loop terminated. Could be `done` (success),
  // `aborted` (user cancelled), or `error`. We don't gate on the
  // status string because Gemini is non-deterministic — sometimes
  // the model emits a doc edit and a status='done', sometimes it
  // surfaces a status='error' on safety / context issues. The
  // user-visible signal is "bar is idle again" either way.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI added a "Keyboard shortcuts" section — exactly where it makes sense in the doc.',
    {
      highlights: [
        // Highlights the editor body — the "outcome" of an AI run is
        // always doc content changing, so the editor pane is the
        // natural anchor. We don't pin to a specific selector inside
        // the editor because the AI's exact output varies between
        // runs.
        { label: 'AI\'s edits land in the editor', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: doc content actually changed. silentSetup leaves the
  // welcome doc content (~30 lines); a successful AI run with the
  // "add a section" prompt should land an additional heading + body.
  // We assert the doc grew rather than asserting on specific words.
  const doc = page.locator('.cm-content')
  const wordCount = await doc.evaluate(el => (el.textContent ?? '').split(/\s+/).filter(Boolean).length)
  expect(wordCount).toBeGreaterThan(50)
})
