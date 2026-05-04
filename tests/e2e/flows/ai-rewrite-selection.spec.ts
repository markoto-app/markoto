import { test, expect } from '../fixtures/flow'

// Tier 2: "Select text and ask the AI to rewrite it".
//
// User-job: a writer has a paragraph that's almost right but too
// long, too formal, or in the wrong voice. Select it, type "make
// this shorter" in the prompt bar, and the AI replaces THAT
// passage — not the end of the doc. Job done when the AI's edit
// lands inside the originally-selected range, not appended at EOF.
//
// Pipeline: the editor pre-captures an `EditorSelectionSnapshot`
// (kind=`selection`, fromLine/toLine/text) at submit time and
// passes it as `editorSelection` on `/api/ai/prompt`. The AI sees
// the range inside `<editor_state>` in its system prompt and picks
// `replace_text` over `insert_text` — same prompt-bar surface as
// the bottom-bar tour, but the user's selection routes the model.
//
// Live Gemini call. Skipped if no key.
test('Rewrite a selection with the AI', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows.'
  )
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  // Type a long-winded paragraph at the end of the welcome doc so
  // there's a clear target for the rewrite. The seed sentence is
  // intentionally verbose — gives the AI a clear "make this
  // shorter" win.
  const editorContent = page.locator('.cm-content').first()
  await editorContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await editorContent.press(`${accel}+End`)
  await editorContent.press('Enter')
  await editorContent.press('Enter')
  const original = 'In the event that you should find yourself in a position '
    + 'where you are required to undertake the not-insignificant task of '
    + 'composing a document of any considerable length, it would behove '
    + 'you to consider, with all due deliberation, the merits of brevity.'
  await editorContent.pressSequentially(original)
  await page.waitForTimeout(800)

  await flow.heading('Rewrite a selection with the AI', 3)
  await flow.narrate(
    'The AI prompt bar is the same one you use to draft new '
    + 'sections — but if you SELECT text first, it tells the AI '
    + 'EXACTLY where to act. The selection rides along on the '
    + 'prompt; the model picks `replace_text` over `insert_text` '
    + 'and your edit lands in place.'
  )

  // ─── Select the paragraph ───────────────────────────────────────
  await flow.heading('Select the passage you want to rewrite', 3)
  await flow.narrate(
    'Triple-click selects the line, click-and-drag selects a range. '
    + 'Either way the AI gets the exact span (line numbers + text) '
    + 'so it knows where to edit.'
  )

  // Click on the line that has our verbose sentence (the last
  // non-empty line of the editor) and triple-click to select it.
  const target = editorContent.getByText(/In the event that you should find yourself/i).first()
  await flow.step(
    'Triple-click the verbose paragraph to select it',
    async () => {
      await target.click({ clickCount: 3 })
    }
  )
  // Confirm the selection is non-empty before submitting.
  const selectedLen = await page.evaluate(() => window.getSelection()?.toString().length ?? 0)
  expect(selectedLen).toBeGreaterThan(50)

  // ─── Ask the AI to rewrite ──────────────────────────────────────
  await flow.heading('Ask the AI to make it shorter', 3)
  await flow.narrate(
    'Type your ask into the prompt bar — short instructions work '
    + 'best ("make this shorter", "translate to German", "rewrite '
    + 'as bullet points"). The selection stays in place while you '
    + 'type; the editor snapshots it the moment you hit send.'
  )

  await editor.page.ai.promptBarInput.click()
  await flow.type(
    'Type the rewrite instruction',
    editor.page.ai.promptBarInput,
    'Make this much shorter — one crisp sentence, plain language.',
    { result: 'Your prompt is ready. The selection rides along on submit.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — replace_text targets the selection, the verbose paragraph shrinks to a crisp sentence.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // Replace_text on a single passage typically resolves in 1-2 turns.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The verbose paragraph is gone — replaced in place with the '
    + 'AI\'s shorter version. The end of the doc still ends with '
    + 'the rewrite, NOT a new paragraph appended after it.',
    {
      hero: true,
      highlights: [
        { label: 'AI-rewritten passage', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: the original verbose phrasing is GONE (the AI did a
  // replace, not an append). The "behove" + "considerable length"
  // markers are unique to the original — they should not survive.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const ytext = await page.evaluate(() => {
    type Win = { __DEBUG_ytext?: { toString: () => string } }
    return (window as unknown as Win).__DEBUG_ytext?.toString() ?? ''
  })
  expect(ytext).not.toMatch(/behove/i)
  expect(ytext).not.toMatch(/it would behove you to consider/i)

  flow.next({
    slug: 'write-with-ai',
    why: 'Selection-rewrite is the precision tool — for new sections, the bottom prompt bar is the entry point'
  })
})
