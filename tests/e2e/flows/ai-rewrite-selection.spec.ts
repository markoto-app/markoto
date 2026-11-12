import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 2: "Select text and ask the AI to rewrite it".
//
// User-job: a writer has a paragraph that's almost right but too
// long, too formal, or in the wrong voice. Select it, type "make
// this shorter" in the prompt bar, and the AI replaces THAT
// passage: not the end of the doc. Job done when the AI's edit
// lands inside the originally-selected range, not appended at EOF.
//
// Pipeline: the editor pre-captures an `EditorSelectionSnapshot`
// (kind=`selection`, fromLine/toLine/text) at submit time and
// passes it as `editorSelection` on `/api/ai/prompt`. The AI sees
// the range inside `<editor_state>` in its system prompt and picks
// `replace_text` over `insert_text`: same prompt-bar surface as
// the bottom-bar tour, but the user's selection routes the model.
//
// Live LiteLLM round-trip → Mistral. Skipped if no key.
test('Rewrite a selection with the AI', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  // A short product update whose middle paragraph is far too wordy,
  // a clear "make this shorter" target with text before AND after it,
  // so an in-place rewrite is visibly different from an append.
  const original = 'In the event that you should find yourself in a position '
    + 'where you are required to undertake the not-insignificant task of '
    + 'exporting a document of any considerable length, it would behove '
    + 'you to know that the export now completes in roughly half the time.'
  await editor.silentSetup({
    title: 'Product update',
    body: [
      '# Product update: October',
      '',
      'Three changes shipped this month.',
      '',
      original,
      '',
      'Comments now show who resolved a thread and when.'
    ].join('\n'),
    cover: false
  })
  const editorContent = page.locator('.cm-content').first()
  await expect(editorContent).toContainText('it would behove you')

  await flow.heading('Rewrite a selection with the AI', 3)
  await flow.narrate(
    'The AI prompt bar is the same one you use to draft new sections. '
    + 'Select text first, and the AI works on exactly that passage: it '
    + 'rewrites it in place instead of adding text somewhere else.'
  )

  // Select the paragraph
  await flow.heading('Select the passage you want to rewrite', 3)
  await flow.narrate(
    'Triple-click selects a paragraph; click and drag selects any '
    + 'range.'
  )

  // Click on the line that has our verbose sentence (the last
  // non-empty line of the editor) and triple-click to select it.
  const target = editorContent.getByText(/In the event that you should find yourself/i).first()
  await flow.step(
    'Triple-click the wordy paragraph to select it',
    async () => {
      await target.click({ clickCount: 3 })
    }
  )
  // Confirm the selection is non-empty before submitting.
  const selectedLen = await page.evaluate(() => window.getSelection()?.toString().length ?? 0)
  expect(selectedLen).toBeGreaterThan(50)

  // Ask the AI to rewrite
  await flow.heading('Ask the AI to make it shorter', 3)
  await flow.narrate(
    'Type what you want into the prompt bar. Short instructions work '
    + 'best: "make this shorter", "translate to German", "turn this into '
    + 'bullet points". Your selection stays put while you type.'
  )

  await editor.page.ai.promptBarInput.click()
  await flow.type(
    'Type the rewrite instruction',
    editor.page.ai.promptBarInput,
    'Make this much shorter, one crisp sentence, plain language.',
    { result: 'Your instruction is ready; the paragraph is still selected.' }
  )

  // The outcome frame is the finished rewrite, not the "Thinking…" state.
  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    { chain: true, after: () => editor.page.waitForAiActive() }
  )

  // Replace_text on a single passage typically resolves in 1-2 turns.
  await editor.page.waitForAiIdle()
  await expect(editorContent).not.toContainText('it would behove you')
  await editor.page.dismissToasts()
  await editor.page.scrollEditorTo('Three changes shipped')

  await flow.shot(
    'The wordy paragraph is now one short sentence, in the same place: '
    + 'the paragraphs before and after it are untouched.',
    {
      hero: true,
      highlights: [
        { label: 'AI-rewritten passage', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: the original verbose phrasing is GONE (the AI did a
  // replace, not an append). The "behove" + "considerable length"
  // markers are unique to the original, they should not survive.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const ytext = await page.evaluate(() => {
    type Win = { __DEBUG_ytext?: { toString: () => string } }
    return (window as unknown as Win).__DEBUG_ytext?.toString() ?? ''
  })
  expect(ytext).not.toMatch(/behove/i)
  // In place: the paragraphs around the selection survive, in order.
  expect(ytext.indexOf('Three changes shipped this month.')).toBeGreaterThanOrEqual(0)
  expect(ytext.indexOf('Comments now show who resolved')).toBeGreaterThan(ytext.indexOf('Three changes shipped this month.'))
  expect(ytext.trimEnd().endsWith('Comments now show who resolved a thread and when.')).toBe(true)
  expect(ytext).toMatch(/export/i)

  flow.next({
    slug: 'write-with-ai',
    why: 'Ask the AI to draft a whole new section'
  })
})
