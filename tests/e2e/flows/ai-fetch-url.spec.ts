import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 2: "Drop a URL into the prompt and the AI reads it for you".
//
// User-job: a writer wants to summarise an article without leaving
// markoto — paste the URL into the AI prompt bar, ask "what's this
// about?", let the AI fetch it and weave the answer into the doc.
// Job done when the AI calls `fetch_url`, fetches the page through
// the SSRF-guarded URL fetcher, and inserts a summary paragraph.
//
// Pipeline: AI calls `fetch_url(url)` → 2-call sub-pipeline (Jina
// Reader fetches the page, then the chat model synthesises a
// structured `{summary, images[]}` extraction) → AI weaves the result
// into the doc with a link to the page (system-prompt citation rule).
//
// Live LiteLLM round-trip → Mistral. Skipped if no key.
test('Ask the AI to read a URL', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  const draft = '# Framework shortlist\n\n## Candidates\n\nWe are comparing frontend frameworks for the new customer dashboard.\n'
  await editor.silentSetup({ title: 'Framework shortlist', body: draft, cover: false })

  await flow.heading('Drop a URL — the AI reads it for you', 3)
  await flow.narrate(
    'Paste any public URL into the AI prompt bar with a question and '
    + 'the AI reads the page for you, then writes what you asked for '
    + 'into your doc with a link back to the page. Useful for articles, '
    + 'docs, RFC drafts, anything public on the open web. Private '
    + 'network addresses are refused.'
  )

  // ─── Prompt with a URL ──────────────────────────────────────────
  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The bar lifts and glows — ready for the URL + question.' }
  )

  // Vue.js docs landing page: stable, public, returns a clear short
  // page that Jina Reader → Mistral summarises predictably. Avoid
  // news sites (paywalls / cookies banners change the fetched body
  // and produce flaky summaries).
  const prompt = 'Read https://vuejs.org/guide/introduction.html and add a one-paragraph summary at the end of this doc.'
  await flow.type(
    'Paste the URL with a question',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is ready — the URL tells the AI which page to read.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — it reads the page, then the summary lands in the doc.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // fetch_url + insert_text is typically 2-3 turns; 15-45s wallclock.
  await editor.page.waitForAiIdle()

  // ASSERTION: the AI read the page this session (the Activity log
  // records every AI tool call) and added a Vue summary that links
  // back to the page it read.
  const docId = editor.page.currentDocId()
  await expect.poll(async () => {
    const res = await page.request.get(`/api/docs/${docId}/activity`)
    return res.ok() ? JSON.stringify(await res.json()) : ''
  }, { timeout: 15_000, message: 'the AI never called fetch_url' }).toMatch(/fetch_url/)
  const added = await editor.page.addedText(draft)
  expect(added.length, 'the AI added no summary').toBeGreaterThan(150)
  expect(added).toMatch(/vue/i)
  expect(added, `no link to the page in: ${added}`).toMatch(/vuejs\.org/i)
  await editor.page.scrollEditorTo(/vue/i)

  await flow.shot(
    'The AI read the page and wrote the summary into the doc — with '
    + 'a link to the source so the reader can verify.',
    {
      hero: true,
      highlights: [
        { label: 'AI-written summary', selector: '.cm-line:has-text("vue")' }
      ]
    }
  )

  flow.next({
    slug: 'ask-the-ai-for-current-information',
    why: 'Need information that\'s NOT at a specific URL? Web search is the next tool over'
  })
})
