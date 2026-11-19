import { test, expect, requireLiveAi } from '../fixtures/flow'
import { ExplorerPage, apiCreateDoc, apiCreateWorkspace } from '../fixtures/explorer'

// "Keep a project bible": a novelist keeps the facts of the book
// (characters, places, style) in one ordinary document and wants the AI to
// respect them in every chapter without pasting them into each prompt. Job
// done when the bible is marked as AI context for the workspace, a chapter
// lists it in its Document panel, and the AI writes a fact only the bible
// holds into the chapter.
//
// Desktop: right-click the bible, "Use as AI context" → "For the whole
// workspace". Phone: press and hold, "Use as AI context" (a document at the
// top level then applies to the whole workspace).
//
// Live AI round-trip (the payoff is the AI using the bible).
const BIBLE = [
  '# Story bible',
  '',
  '## Characters',
  '',
  '- **Mara Lind**: 34, ferry pilot, grew up in Vellmar. Calls the ferry "the Heron".',
  '',
  '## Places',
  '',
  '- **Vellmar**: a small harbour town on a northern island, the only stop of the Heron.',
  '',
  '## Style',
  '',
  '- Past tense, third person, close to Mara.',
  ''
].join('\n')

test('Keep a project bible', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)
  const explorer = new ExplorerPage(page)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const workspaceId = await apiCreateWorkspace(page, 'Harbour novel')
  const bibleId = await apiCreateDoc(page, { workspaceId, title: 'Story bible', content: BIBLE })
  const chapterId = await apiCreateDoc(page, { workspaceId, title: 'Chapter 1', content: '# Chapter 1\n\n' })

  await page.goto(`/w/${workspaceId}`)
  await explorer.waitForList()
  await expect(explorer.rows).toHaveCount(2)

  await flow.heading('Mark the bible as AI context', 3)
  await flow.narrate(
    'Keep the facts of your project in an ordinary document: characters, places, a glossary, a style guide. '
    + 'Mark it as AI context and markoto reads it whenever you ask the AI for help in this workspace.'
  )

  if (editor.isMobile) {
    await flow.step('Press and hold "Story bible"', async () => {
      await explorer.longPress(explorer.row('Story bible'))
      await expect(page.locator('.mk-sheet-host').getByRole('button', { name: /use as ai context/i })).toBeVisible()
    }, { highlights: [{ label: 'Actions', selector: '.mk-sheet-host' }] })
    await flow.click('Tap "Use as AI context"', page.locator('.mk-sheet-host').getByRole('button', { name: /use as ai context/i }), {
      result: 'The bible now applies to every document in the workspace.',
      after: () => expect(explorer.row('Story bible').getByTestId('explorer-context-badge')).toBeVisible()
    })
  } else {
    await flow.step('Right-click "Story bible"', async () => {
      await explorer.row('Story bible').click({ button: 'right' })
      await expect(page.getByRole('menuitem', { name: /use as ai context/i })).toBeVisible()
    }, { highlights: [{ label: 'Actions', selector: '[role="menu"]' }] })
    await flow.click('Point at "Use as AI context"', page.getByRole('menuitem', { name: /use as ai context/i }), {
      result: 'Choose where the AI should use it: in this folder, or in the whole workspace.',
      after: () => expect(page.getByRole('menuitemcheckbox', { name: /whole workspace/i })).toBeVisible()
    })
    await flow.click('Pick "For the whole workspace"', page.getByRole('menuitemcheckbox', { name: /whole workspace/i }), {
      result: 'The bible gets an "AI context" badge.',
      after: () => expect(explorer.row('Story bible').getByTestId('explorer-context-badge')).toBeVisible()
    })
  }
  await expect.poll(async () => {
    const res = await page.request.get(`/api/docs/${bibleId}/context`)
    return res.ok() ? ((await res.json()) as { contextScope: string | null }).contextScope : null
  }).not.toBeNull()
  await flow.shot('The bible is marked as AI context for the workspace.', {
    highlights: [{ label: 'AI context', selector: '[data-testid="explorer-context-badge"]' }]
  })

  // ---------- the chapter sees it ----------
  await flow.heading('See which context a document uses', 3)
  await page.goto(`/d/${chapterId}`)
  await editor.page.waitForReady()
  const documentTab = editor.isMobile ? editor.page.mobileTabs.document : editor.page.sidebar.document
  await flow.click(
    editor.isMobile ? 'Tap the Info tab on the bottom bar' : 'Open the Document tab of "Chapter 1"',
    documentTab,
    {
      result: 'Under "AI context", the panel lists the documents the AI reads here.',
      after: () => expect(page.getByTestId('doc-context-applied')).toContainText('Story bible')
    }
  )
  await page.getByTestId('doc-context-section').scrollIntoViewIfNeeded()
  await flow.shot('"Story bible" applies to this chapter because it is context for the whole workspace.', {
    highlights: [{ label: 'AI context', selector: '[data-testid="doc-context-section"]' }]
  })
  if (editor.isMobile) {
    await page.locator('.mk-sheet-host button[aria-label="Close"]').click()
    await page.locator('.mk-sheet-host').waitFor({ state: 'detached', timeout: 5_000 })
  }

  // ---------- the AI uses it ----------
  await flow.heading('Write with the bible in mind', 3)
  await flow.narrate(
    'Ask for a scene without repeating the facts. The prompt names neither the town nor the ferry; '
    + 'the AI takes both from the bible.'
  )
  await flow.click('Click into the AI prompt bar', editor.page.ai.promptBarInput, {
    result: 'The prompt bar is ready.'
  })
  await flow.type(
    'Ask for the opening scene',
    editor.page.ai.promptBarInput,
    'Write the opening paragraph of this chapter below the heading: Mara steers her ferry home at dawn. Name the town and the ferry.',
    { result: 'A short ask; the facts come from the bible.' }
  )
  await flow.click('Send it', editor.page.ai.promptBarSend, {
    result: 'markoto is writing.',
    after: () => editor.page.waitForAiActive()
  })
  await editor.page.waitForAiIdle()

  const text = await editor.page.docText()
  expect(text, 'the AI did not use the bible\'s town').toMatch(/Vellmar/)
  expect(text, 'the AI did not use the bible\'s ferry name').toMatch(/Heron/)
  await editor.page.scrollEditorTo('Vellmar')
  await flow.shot('The opening names Vellmar and the Heron, facts only the bible holds.', {
    hero: true,
    highlights: [{ label: 'AI\'s paragraph', selector: '.cm-content' }]
  })

  flow.next({
    slug: 'tell-the-ai-who-you-re-writing-for',
    why: 'Set the audience and language of each document too'
  })
})
