import { test, expect, requireLiveAi } from '../fixtures/flow'
import { findAiWritingTells } from '../../../shared/ai/writingTells'

// AI Flow: "Rename something everywhere in one go".
//
// User-job: a product got a new name and the writer wants every mention
// changed, but not the code sample that calls the old command or the link
// that still points at the old address. Job done when the prose and the
// heading carry the new name and the code block and URL are untouched.
//
// Runs against the LIVE LiteLLM proxy (no fixture or mock): the model
// should find the term with search_document and change it with replace_all
// (preview, then apply). Assertions check the document, not the wording.

const OLD = 'MyProduct'
const NEW = 'MySuperCoolProduct'
const CODE_LINE = 'myproduct sync --all'
const LINK_URL = 'https://example.com/MyProduct/docs'

test('Rename a name everywhere with AI', async ({ flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Alice Liu')
  const draft = [
    `# Getting started with ${OLD}`,
    '',
    `${OLD} keeps your team's notes in one place. Every workspace in ${OLD} has its own members.`,
    '',
    `## Install ${OLD}`,
    '',
    'Run the sync command once after you sign in:',
    '',
    '```bash',
    CODE_LINE,
    '```',
    '',
    `Read the [${OLD} manual](${LINK_URL}) for the details.`,
    ''
  ].join('\n')
  await editor.silentSetup({ title: 'Product notes', body: draft, cover: false })

  await flow.heading('Ask for the rename', 3)
  await flow.narrate(
    'A new product name has to show up everywhere at once. Ask the AI in one sentence: '
    + 'it finds every mention, previews the change, and applies it as one edit. '
    + 'Code samples and link addresses stay as they are, so commands and links keep working.'
  )

  await flow.click('Click into the AI prompt bar', editor.page.ai.promptBarInput, {
    chain: true,
    after: () => editor.page.ai.promptBarInput.waitFor({ state: 'visible' })
  })
  const prompt = `Rename ${OLD} to ${NEW} everywhere`
  await flow.type('Type what should change', editor.page.ai.promptBarInput, prompt, {
    result: 'Your request is ready to send.'
  })
  await expect(editor.page.ai.promptBarInput).toHaveValue(prompt)

  await flow.click('Click send', editor.page.ai.promptBarSend, {
    result: 'The AI searches the document and replaces the name.',
    after: () => editor.page.waitForAiActive()
  })

  await flow.heading('Every mention changed, code and links kept', 3)
  await editor.page.waitForAiIdle()

  const text = await editor.page.docText()
  // Prose and headings carry the new name.
  expect(text).toContain(`# Getting started with ${NEW}`)
  expect(text).toContain(`## Install ${NEW}`)
  expect(text).toContain(`${NEW} keeps your team's notes in one place.`)
  expect(text).toContain(`Every workspace in ${NEW} has its own members.`)
  expect(text).toContain(`[${NEW} manual]`)
  // The code sample and the link address are untouched.
  expect(text).toContain(`\`\`\`bash\n${CODE_LINE}\n\`\`\``)
  expect(text).toContain(`(${LINK_URL})`)
  // No old name left outside the code block and the URL.
  const outside = text.replace(CODE_LINE, '').replace(LINK_URL, '')
  expect(outside).not.toMatch(new RegExp(`\\b${OLD}\\b`))
  // The AI's own text follows the writing rules (no em-dash and friends).
  expect(findAiWritingTells(text)).toEqual([])

  await editor.page.scrollEditorTo(new RegExp(NEW))
  await flow.shot('The new name is in the headings and the text; the command and the link address kept the old one.', {
    hero: true,
    highlights: editor.isMobile ? [] : [{ label: 'Renamed heading', selector: `.cm-line:has-text("${NEW}")` }]
  })

  flow.next({ slug: 'write-with-ai', why: 'Ask the AI to write new sections for you' })
})
