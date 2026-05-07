import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 2: "Ask the AI a question that needs current information."
//
// User-job: a writer is drafting a doc that needs a fact the AI's
// training data doesn't cover — latest version of a library, current
// stock price, who won last week's match. Job done when the AI runs
// a web search, gets sources, folds them into its reply, and inserts
// a paragraph into the doc with the grounded answer.
//
// Pipeline: AI calls `web_search` → 2-call sub-pipeline (Jina Reader
// fetches live web results, then Mistral synthesises a 3–6 sentence
// answer with cited sources) → AI inserts the paragraph (often with
// a citation-style note about the source).
//
// Live LiteLLM round-trip → Mistral. Skipped if no key.
test('Ask the AI for current information', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  await flow.heading('Ask the AI for current information', 3)
  await flow.narrate(
    'The AI\'s training data has a cutoff. For anything more recent — '
    + 'current library versions, latest news, who shipped what last '
    + 'week — it can call `web_search`, which fetches live web results '
    + 'via Jina Reader and hands them to Mistral for synthesis, and '
    + 'weaves the result back into your doc. The answer cites the '
    + 'sources it found, so you can verify before publishing.'
  )

  // ─── Prompt + send ──────────────────────────────────────────────
  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The prompt bar lifts and glows — ready for your prompt.' }
  )

  // Phrase the prompt so web_search is the obvious tool. "Latest"
  // + "release" + a specific recent product cues the model
  // strongly.
  const prompt = 'What is the latest stable release of Vue.js? Add a one-line note at the top of the doc with the version number.'
  await flow.type(
    'Type a question that needs current info',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is staged. The "latest" + "release" cues the AI to web_search.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — web_search runs, then the AI inserts the grounded answer.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // 3-tool runs (web_search → maybe view_document → insert_text)
  // typically resolve in 15-30s.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI ran a web search, found the current Vue.js release, and '
    + 'wrote a one-line note into the doc — grounded in real sources.',
    {
      hero: true,
      highlights: [
        { label: 'Grounded answer', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: doc grew. We can't assert the exact version number
  // (Vue's release cadence means it changes), but the doc body
  // should have grown by at least a sentence and contain "Vue".
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/vue/i)
  const wordCount = (editorText ?? '').split(/\s+/).filter(Boolean).length
  expect(wordCount).toBeGreaterThan(50)

  flow.next({
    slug: 'tell-the-ai-who-you-re-writing-for',
    why: 'Steer the AI\'s tone + language too — set the document context'
  })
})
