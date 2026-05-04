import { test, expect } from '../fixtures/flow'

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
// Live Gemini call. Skipped if no key.
test('Ask the AI about another doc', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows.'
  )
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
  // Reference sibling.docId so eslint doesn't flag the var; the AI
  // looks up the id itself via list_workspace_documents.
  expect(sibling.docId).toBeTruthy()

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
  await editor.page.disableCoverPage()

  await flow.heading('Ask the AI about another doc in your workspace', 3)
  await flow.narrate(
    'The AI in a workspace doc gets two extra tools: '
    + '`list_workspace_documents` to enumerate siblings, and '
    + '`view_other_document` to read one in full. Ask a question '
    + 'about another doc and the AI fans out: lists the sibling '
    + 'titles, reads the matching one, then answers in YOUR doc — '
    + 'citing the source by title.'
  )

  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The bar lifts, ready for the cross-doc question.' }
  )

  // Phrase as an insertion request, not a question. Questions tend
  // to route the AI to `message_to_user` (ephemeral chat answer);
  // "summarise into this doc" forces an `insert_text` end-state.
  const prompt = 'There is a sibling doc in this workspace called the Q3 launch postmortem. Read it via the cross-doc tools and append a one-paragraph summary of its top onboarding fix at the end of THIS doc.'
  await flow.type(
    'Ask about a sibling doc',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt names another doc in the workspace — the AI will fan out to read it.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI lists siblings, picks the postmortem, reads it, and writes the answer into THIS doc.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // Cross-doc tools chain: list_workspace_documents → view_other_document
  // → insert_text. Typically 3-4 turns, 30-60s wallclock.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI summarised the Q3 postmortem\'s onboarding finding into '
    + 'this doc — citing the source. The user never had to open the '
    + 'sibling doc themselves.',
    {
      hero: true,
      highlights: [
        { label: 'AI cross-doc answer', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: the primary doc's body grew with cross-doc content.
  // We can't pin the AI's exact answer (Gemini is non-deterministic
  // and might paraphrase "checklist" as "list" or "guide"), so we
  // assert that (a) the doc grew past its welcome baseline AND
  // (b) the body mentions any of the keywords seeded into the
  // sibling's description: checklist / authentication / onboarding /
  // postmortem. The model received those tokens via
  // `list_workspace_documents` so at least one is highly likely to
  // surface in its answer.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const ytext = await page.evaluate(() => {
    type Win = { __DEBUG_ytext?: { toString: () => string } }
    return (window as unknown as Win).__DEBUG_ytext?.toString() ?? ''
  })
  expect(ytext.length).toBeGreaterThan(2700) // welcome doc is ~2600 chars
  expect(ytext).toMatch(/checklist|authentication|onboarding|postmortem/i)

  flow.next({
    slug: 'knowledge-grounded-ai',
    why: 'For files that aren\'t docs (PDFs, FAQs), the workspace knowledge base + RAG is the next step over'
  })
})
