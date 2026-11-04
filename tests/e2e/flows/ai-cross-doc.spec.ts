import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 2: "Ask the AI about another doc in your workspace".
//
// User-job: a writer is in doc A inside a workspace and wants to
// reference doc B without opening it themselves. They ask "what
// does the Q3 postmortem say about onboarding?" The AI calls
// `list_workspace_documents` to find sibling docs, picks the
// matching one, calls `view_other_document` to read it, then
// answers in doc A — citing doc B by title.
//
// Pipeline: AI agentic loop with two cross-doc tools (only
// available when the session has a workspaceId AND the user is a
// member). The tools are gated server-side; non-workspace docs
// don't get them in their tool list.
//
// Live LiteLLM round-trip → Mistral. Skipped if no key.
test('Ask the AI about another doc', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')

  // Set up a workspace + a "sibling" doc that the AI will discover
  // and read. All via API — the story is the cross-doc tool path,
  // not the workspace setup.
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Engineering library' }
  })
  if (!wsRes.ok()) throw new Error(`workspace create failed: ${wsRes.status()}`)
  const ws = await wsRes.json() as { workspaceId: string }

  // Seed the sibling doc with the relevant content baked into its
  // DESCRIPTION (which `list_workspace_documents` returns inline) and
  // its TITLE. This avoids the Hocuspocus-flush race: the body would
  // need an open WS client to reach `yjs_documents`, but the description
  // is just a column on the `documents` row that POST /api/docs writes
  // synchronously, so it's immediately readable by the AI's
  // `list_workspace_documents` call.
  const siblingRes = await page.request.post('/api/docs', {
    data: {
      workspaceId: ws.workspaceId,
      title: 'Q3 launch postmortem — onboarding fixes',
      description: 'Top onboarding fix: a single-page authentication setup checklist for new hires.',
      accessMode: 'private'
    }
  })
  if (!siblingRes.ok()) throw new Error(`sibling create failed: ${siblingRes.status()}`)
  const sibling = await siblingRes.json() as { docId: string }
  // The AI looks the id up itself via list_workspace_documents; the
  // flow only uses it to check the citation never shows it raw.
  const postmortemId = sibling.docId
  expect(postmortemId).toBeTruthy()

  // Now create the PRIMARY doc the user is sitting in.
  const primaryRes = await page.request.post('/api/docs', {
    data: {
      workspaceId: ws.workspaceId,
      title: 'Onboarding playbook',
      accessMode: 'private'
    }
  })
  if (!primaryRes.ok()) throw new Error(`primary create failed: ${primaryRes.status()}`)
  const primary = await primaryRes.json() as { docId: string }

  await page.goto(`/d/${primary.docId}`)
  await editor.page.waitForReady()
  await expect(editor.page.titleButton).toContainText('Onboarding playbook')
  // A short real draft instead of the Demo text, cover off, so the
  // AI's paragraph lands on the preview's first page.
  const draft = '# Onboarding playbook\n\n## First week\n\nEvery new hire pairs with a buddy for their first five days.\n'
  await editor.page.setDocText(draft)
  if (!editor.isMobile) {
    await editor.page.switchToSplitView()
    await editor.page.waitForPreviewPaginated()
  }
  await editor.page.disableCoverPage()

  await flow.heading('Ask the AI about another doc in your workspace', 3)
  await flow.narrate(
    'Inside a workspace the AI can find and read the other documents '
    + 'you have access to. Ask about another doc by name and it looks '
    + 'it up, reads it, then writes the answer into the doc you are in '
    + '— naming the doc it took it from.'
  )

  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The bar lifts, ready for your question.' }
  )

  // Phrase as an insertion request, not a question. Questions tend
  // to route the AI to `message_to_user` (ephemeral chat answer);
  // "summarise into this doc" forces an `insert_text` end-state.
  const prompt = 'Read our Q3 launch postmortem doc in this workspace and append a one-paragraph summary of its top onboarding fix at the end of this doc.'
  await flow.type(
    'Ask about a sibling doc',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt names another doc in the workspace — the AI will go and read it.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI finds the postmortem, reads it, and writes the answer into this doc.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // Cross-doc tools chain: list_workspace_documents → view_other_document
  // → insert_text. Typically 3-4 turns, 30-60s wallclock.
  await editor.page.waitForAiIdle()

  // ASSERTION: the AI added a paragraph carrying the fact that exists
  // only in the other doc (the authentication-setup checklist) — the
  // draft mentions neither word, so it had to read the postmortem.
  const added = await editor.page.addedText(draft)
  expect(added.length, 'the AI added nothing').toBeGreaterThan(80)
  expect(added, `no fact from the postmortem in: ${added}`).toMatch(/checklist|authentication/i)
  // A citation names the other doc by its title, never by its bare id
  // (a link to /d/<id> is fine).
  expect(added.replace(/\(\/d\/[^)]+\)/g, ''), `bare doc id in: ${added}`).not.toContain(postmortemId)
  // A link to the postmortem is labelled with the postmortem's title.
  for (const m of added.matchAll(new RegExp(`\\[([^\\]]+)\\]\\(/d/${postmortemId}\\)`, 'g'))) {
    expect(m[1], `link to the postmortem labelled "${m[1]}"`).toMatch(/postmortem/i)
  }
  await editor.page.scrollEditorTo(/checklist|authentication/i)
  if (!editor.isMobile) {
    await expect(editor.page.previewRoot().locator('#mount')).toContainText(/checklist|authentication/i)
  }

  await flow.shot(
    'The AI summarised the Q3 postmortem\'s onboarding finding into '
    + 'this doc — citing the source. The user never had to open the '
    + 'sibling doc themselves.',
    {
      hero: true,
      highlights: [
        { label: 'Answer from the other doc', selector: '.cm-line:has-text("checklist"), .cm-line:has-text("authentication")' }
      ]
    }
  )

  flow.next({
    slug: 'knowledge-grounded-ai',
    why: 'For files that aren\'t docs (PDFs, FAQs), the workspace knowledge base + RAG is the next step over'
  })
})
