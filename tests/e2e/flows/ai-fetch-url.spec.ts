import { test, expect } from '../fixtures/flow'

// Tier 2: "Drop a URL into the prompt and the AI reads it for you".
//
// User-job: a writer wants to summarise an article without leaving
// markoto — paste the URL into the AI prompt bar, ask "what's this
// about?", let the AI fetch it and weave the answer into the doc.
// Job done when the AI calls `fetch_url`, fetches the page through
// the SSRF-guarded URL fetcher, and inserts a summary paragraph.
//
// Pipeline: AI calls `fetch_url(url)` → server-side `urlContext`
// sub-call to Gemini with structured-output schema (summary +
// images[]) → AI weaves the result back into the doc, often with
// a citation note about the source.
//
// Live Gemini call. Skipped if no key.
test('Ask the AI to read a URL', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows.'
  )
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  await flow.heading('Drop a URL — the AI reads it for you', 3)
  await flow.narrate(
    'Paste any URL into the AI prompt bar with a question and the '
    + 'AI calls `fetch_url`: a guarded server-side fetcher (no '
    + 'private CIDRs, no `file://`, no internal hostnames) feeds '
    + 'the page through Gemini with `urlContext` and structured '
    + 'output, then the AI summarises into your doc with a '
    + 'citation. Useful for articles, docs, RFC drafts, anything '
    + 'public on the open web.'
  )

  // ─── Prompt with a URL ──────────────────────────────────────────
  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The bar lifts and glows — ready for the URL + question.' }
  )

  // Vue.js docs landing page: stable, public, returns a clear short
  // page Gemini's `urlContext` summarises predictably. Avoid news
  // sites (paywalls / cookies banners change the fetched body and
  // produce flaky summaries).
  const prompt = 'Read https://vuejs.org/guide/introduction.html and add a one-paragraph summary at the end of this doc.'
  await flow.type(
    'Paste the URL with a question',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is staged. The URL signals fetch_url to the AI.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — fetch_url runs, then the summary lands in the doc.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // fetch_url + insert_text is typically 2-3 turns; 15-45s wallclock.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI fetched the URL, ran a grounded summary, and wrote the '
    + 'paragraph into the doc — with the source URL preserved so '
    + 'the reader can verify.',
    {
      hero: true,
      highlights: [
        { label: 'AI-written summary', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: the doc grew with a Vue-related summary. We can't
  // assert exact wording (Gemini is non-deterministic) but the
  // model receives the URL in its prompt + sees the page contents
  // through urlContext, so SOME mention of Vue / framework / JS
  // should make it through.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const ytext = await page.evaluate(() => {
    type Win = { __DEBUG_ytext?: { toString: () => string } }
    return (window as unknown as Win).__DEBUG_ytext?.toString() ?? ''
  })
  expect(ytext.length).toBeGreaterThan(200)
  expect(ytext).toMatch(/vue|javascript|framework/i)

  flow.next({
    slug: 'ask-the-ai-for-current-information',
    why: 'Need information that\'s NOT at a specific URL? Web search is the next tool over'
  })
})
