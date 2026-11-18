import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect, requireLiveAi } from '../fixtures/flow'

// AI Flow: "Ask about one part of a long handbook".
//
// User-job: the operations handbook is about 180 pages long and the writer
// needs one rule from it: how fast the on-call person has to be on site.
// Job done when the AI answers in the prompt bar with the number from
// section 2.4 "Pikettdienst" and the handbook is unchanged.
//
// Runs against the LIVE LiteLLM proxy: on a document this size the model
// reads the outline and the one section (outline, read_section) instead of
// the whole text; the assertions check the answer and the document, not
// which tools ran.

const HANDBOOK = readFileSync(fileURLToPath(new URL('../fixtures/content/large-handbook/betriebshandbuch.md', import.meta.url)), 'utf8')

test('Ask about one section of a long document', async ({ flow, editor }) => {
  requireLiveAi()
  test.setTimeout(420_000)

  await editor.page.loginAsTestUser('Martina Studer')
  await editor.silentSetup({ title: 'Betriebshandbuch IT- und Netzbetrieb', body: HANDBOOK, cover: false })

  await flow.heading('Ask about one section', 3)
  await flow.narrate(
    'Long documents are fine: the AI looks at the table of contents first and reads only '
    + 'the part your question is about, so the answer comes quickly even for a whole handbook.'
  )

  await flow.click('Click into the AI prompt bar', editor.page.ai.promptBarInput, {
    chain: true,
    after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
  })
  const prompt = 'Wie schnell muss die Person im Pikettdienst am Standort sein? Antworte kurz und nenne den Abschnitt.'
  await flow.type('Ask your question', editor.page.ai.promptBarInput, prompt, {
    result: 'Your question is ready to send.'
  })
  await flow.click('Click send', editor.page.ai.promptBarSend, {
    result: 'The AI finds the right section and reads it.',
    after: () => editor.page.waitForAiActive()
  })

  await flow.heading('The answer, with the section it comes from', 3)
  await editor.page.waitForAiIdle()

  const answer = editor.page.page.locator('[data-testid="ai-response-panel"]')
  await expect(answer).toBeVisible({ timeout: 15_000 })
  // Section 2.4 says "innerhalb von dreissig Minuten am Standort Birkenmatt".
  await expect(answer).toContainText(/2\.4|Pikettdienst/)
  await expect(answer).toContainText(/30|dreissig/i)
  // A question gets an answer, not an edit.
  expect(await editor.page.docText()).toBe(HANDBOOK)

  await flow.shot('The answer names the 30 minutes and points to section 2.4 Pikettdienst.', { hero: true })

  flow.next({ slug: 'write-with-ai', why: 'Ask the AI to write new sections for you' })
})
