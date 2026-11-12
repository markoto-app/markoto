import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 2: "Ask the AI a question that needs current information."
//
// User-job: a writer is drafting a doc that needs a fact the AI's
// training data doesn't cover, latest version of a library, current
// stock price, who won last week's match. Job done when the AI runs
// a web search, gets sources, folds them into its reply, and inserts
// a paragraph into the doc with the grounded answer.
//
// Pipeline: AI calls `web_search` → 2-call sub-pipeline (Staan returns
// live web results, then the chat model synthesises a short answer
// with its sources) → AI inserts the note with a link to a source
// (the system prompt asks it to cite web facts as Markdown links).
//
// Live LiteLLM round-trip → Mistral. Skipped if no key.
test('Ask the AI for current information', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  const draft = '# Frontend upgrade plan\n\n## Why now\n\nOur dashboard still runs on an old Vue.js release. This plan covers the move to the current one.\n'
  await editor.silentSetup({ title: 'Frontend upgrade plan', body: draft, cover: false })

  await flow.heading('Ask the AI for current information', 3)
  await flow.narrate(
    'The AI\'s training data has a cutoff. For anything more recent, '
    + 'current library versions, latest news, who shipped what last '
    + 'week: it can search the web and weave the result into your doc. '
    + 'The search runs on the instance\'s European search provider; your '
    + 'AI provider writes the answer. It links the sources it used, so '
    + 'you can verify before publishing.'
  )

  // Prompt + send
  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The prompt bar lifts and glows, ready for your prompt.' }
  )

  // Phrase the prompt so web_search is the obvious tool. "Latest"
  // + "release" + a specific recent product cues the model
  // strongly.
  const prompt = 'What is the latest stable release of Vue.js? Add a one-line note with the version number right below the main heading.'
  await flow.type(
    'Type a question that needs current info',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is ready. Asking for the "latest" release tells the AI to search the web.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working, it searches the web, then writes the answer into the doc.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // 3-tool runs (web_search → maybe view_document → insert_text)
  // typically resolve in 15-30s.
  await editor.page.waitForAiIdle()

  // ASSERTION: the AI searched the web this session (the Activity log
  // records every AI tool call), added a note with a version number,
  // and linked a source. We can't pin the exact version (Vue keeps
  // releasing), but a dotted version number and an http(s) link must
  // both be in what it added.
  const docId = editor.page.currentDocId()
  await expect.poll(async () => {
    const res = await page.request.get(`/api/docs/${docId}/activity`)
    return res.ok() ? JSON.stringify(await res.json()) : ''
  }, { timeout: 15_000, message: 'the AI never called web_search' }).toMatch(/web_search/)
  const added = await editor.page.addedText(draft)
  expect(added, 'the AI added nothing').toMatch(/vue/i)
  expect(added, `no version number in: ${added}`).toMatch(/\b\d+\.\d+(\.\d+)?\b/)
  expect(added, `no source link in: ${added}`).toMatch(/\]\(https?:\/\/[^)\s]+\)|<https?:\/\/[^>\s]+>|https?:\/\/\S+/)
  // Under the title, not above it: the H1 is still the first line.
  expect((await editor.page.docText()).trimStart()).toMatch(/^# Frontend upgrade plan\n/)
  await editor.page.scrollEditorTo(/\d+\.\d+/)
  if (!editor.isMobile) {
    // The link renders as a real link in the preview.
    await expect(editor.page.previewRoot().locator('#mount a[href^="http"]').first()).toBeAttached()
  }

  await flow.shot(
    'The AI searched the web, found the current Vue.js release, and '
    + 'wrote the note into the doc, with a link to its source.',
    {
      hero: true,
      highlights: [
        { label: 'Answer with its source', selector: '.cm-line:has-text("](http")' }
      ]
    }
  )

  flow.next({
    slug: 'tell-the-ai-who-you-re-writing-for',
    why: 'Steer the AI\'s tone + language too, set the document context'
  })
})
