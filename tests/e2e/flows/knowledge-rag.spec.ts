import { test, expect, requireLiveAi } from '../fixtures/flow'
import path from 'node:path'

// Tier 2: "Ask the AI about a file you uploaded".
//
// User-job: a team has reference docs (postmortems, RFCs, FAQs) and
// wants the AI to ground its answers in THOSE files instead of
// generic knowledge. Job done when the user uploads a file to a
// workspace, the file processes (markitdown → chunks → embeddings),
// and a subsequent AI prompt produces an answer that cites facts
// from the file.
//
// Pipeline: Upload (presigned PUT → S3 → confirm → markitdown →
// pgvector). Retrieval: hybrid RRF (cosine + BM25) over chunks.
// AI: `search_knowledge` tool returns top-K snippets; the model
// folds them into its reply.
//
// Live LiteLLM round-trip. Drives Mistral embeddings (search) + Mistral
// (synthesis). MISTRAL_API_KEY required.
//
// Setup shortcut: the workspace is created via the API, not the UI
// (UI workspace creation is a `WorkspaceFormModal` dance that's
// uninteresting plumbing: the demo's value is what happens AFTER
// you have a workspace + a file). The flow starts at the workspace
// landing page so readers see the upload + AI grounding from the
// first frame.
//
// Runs on desktop AND mobile. Same workspace + knowledge pipeline;
// the upload entry point differs:
//   - Desktop: workspace landing page → Knowledge tab → Upload.
//   - Mobile: skip the workspace landing page (it stacks awkwardly
//     on `<sm`); land directly in a workspace doc and use the
//     editor's Knowledge bottom-tab drawer to upload. The drawer's
//     upload UI is the same `[data-testid="knowledge-upload-button"]`
//     used by the workspace page, same backend pipeline either way.
test('Knowledge grounded AI', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  // Login + create the workspace via the API. The UI flow for
  // creating a workspace (modal → name → submit) is its own demo
  // worth doing later; here it's setup noise that distracts from
  // the actual story (upload + AI grounding).
  await editor.page.loginAsTestUser('Maya Chen')

  // Touch the homepage first so the session cookie attaches to the
  // browser context (some auth middleware paths only see cookies
  // that have round-tripped via a real navigation, not the cookies
  // that addCookies() set into a context that's never loaded an
  // origin yet).
  await page.goto('/')

  const wsName = 'Q3 launch, engineering retro'
  const docTitle = 'Q4 rollout plan'
  // A short starting draft so the AI's paragraph lands on the first
  // preview page instead of after several pages of Demo text.
  const docBody = '# Q4 rollout plan\n\nWhat we carry over from the Q3 launch.\n'
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: wsName }
  })
  if (!wsRes.ok()) {
    throw new Error(`[knowledge-rag] workspace create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  // The endpoint returns `{ workspaceId }`, the public nanoid that
  // the route uses, NOT the integer DB id. Navigating to /w/<int>
  // would 404 even though the workspace exists.
  const ws = await wsRes.json() as { workspaceId: string }

  // On mobile, skip the workspace landing page (UX is awkward at
  // `<sm`) and create the workspace doc via API, then land in the
  // editor where the Knowledge bottom-tab drawer surfaces the same
  // upload UI as the desktop landing page's Knowledge tab.
  if (editor.isMobile) {
    const docRes = await page.request.post('/api/docs', {
      data: { workspaceId: ws.workspaceId, title: docTitle }
    })
    if (!docRes.ok()) {
      throw new Error(`[knowledge-rag] doc create failed: ${docRes.status()} ${await docRes.text()}`)
    }
    const doc = await docRes.json() as { docId: string }
    await page.goto(`/d/${doc.docId}`)
    await editor.page.waitForReady()
    await editor.page.setDocText(docBody)
    await editor.page.disableCoverPage()
  } else {
    await page.goto(`/w/${ws.workspaceId}`)
    // Wait for the workspace landing page to render the tabs (vs the
    // 404 "Workspace not found" page).
    await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })
  }

  // Title + intro before the first capture.
  await flow.heading('Ask the AI about a file you uploaded', 3)
  await flow.narrate(
    'Workspaces have a Knowledge tab, drop in PDFs, Word docs, '
    + 'HTML exports, the team\'s RFCs, customer FAQs. markoto reads '
    + 'each file and indexes it, so the AI can look things up in it '
    + 'whenever you write inside the workspace, and answer from your '
    + 'files instead of from general knowledge.'
  )

  // Upload a knowledge file
  await flow.heading('Upload the file', 3)

  // Open the Knowledge surface. Desktop = workspace-landing-page
  // tab. Mobile = bottom-tab-bar drawer in the editor.
  if (editor.isMobile) {
    await flow.click(
      'Tap the Knowledge tab on the bottom bar',
      editor.page.mobileTabs.knowledge,
      {
        result: 'The Knowledge drawer slides up, empty until you upload your first file.',
        after: () => page.locator('[data-testid="knowledge-upload-button"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      }
    )
  } else {
    // Tabs use `role="tab"` from Reka, the Knowledge tab's
    // accessible name comes from `workspace.tabs.knowledge` (en: "Knowledge").
    await flow.click(
      'Open the Knowledge tab',
      page.getByRole('tab', { name: /knowledge/i }),
      {
        annotations: [
          { label: 'knowledge tab', selector: '[role="tab"][aria-selected="false"]', kind: 'arrow' }
        ],
        result: 'The Knowledge panel opens, empty until you upload your first file.',
        after: () => page.locator('[data-testid="knowledge-upload-button"]').first().waitFor({ state: 'visible' })
      }
    )
  }

  // The Upload button opens a native file chooser via VueUse's
  // useFileDialog. On mobile the button is inside the Knowledge
  // BottomSheet portal where Reka's overlay intercepts pointer
  // events: and DOM-level `el.click()` workaround doesn't trigger
  // the filechooser (browsers require a real user-gesture click for
  // file dialogs). Bypass the chooser entirely by writing directly
  // to the hidden `<input type="file">` via setInputFiles. Desktop
  // path stays on the user-visible filechooser flow.
  const fixture = path.resolve('tests/e2e/fixtures/import-files/q3-launch-postmortem.html')
  if (editor.isMobile) {
    // useFileDialog mounts the hidden `<input type="file">` lazily,
    // it only exists in DOM AFTER the upload button's click handler
    // calls input.click(). Trigger the handler via DOM-level click
    // (force-evaluate bypasses the BottomSheet's pointer-event
    // interception); register the filechooser listener BEFORE the
    // click. Some browsers accept the synthetic click as a user-
    // gesture-derived chain since it dispatches through normal
    // event listeners.
    await flow.step(
      'Tap Upload + choose the postmortem HTML',
      async () => {
        const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })
        await page.locator('[data-testid="knowledge-upload-button"]').first().evaluate((el: HTMLElement) => el.click())
        const chooser = await chooserPromise
        await chooser.setFiles(fixture)
        await page.locator('[data-testid^="knowledge-file-row-"][data-filename="q3-launch-postmortem.html"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      }
    )
  } else {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })
    await flow.click(
      'Click Upload to pick a file',
      page.locator('[data-testid="knowledge-upload-button"]').first(),
      {
        annotations: [
          { label: 'upload', selector: 'button:has-text("Upload")', kind: 'arrow' }
        ],
        result: 'Pick the postmortem file, it lands in the list and markoto starts reading it.',
        after: async () => {
          const chooser = await chooserPromise
          await chooser.setFiles(fixture)
          await page.locator('[data-testid^="knowledge-file-row-"][data-filename="q3-launch-postmortem.html"]').first().waitFor({ state: 'visible', timeout: 10_000 })
        }
      }
    )
  }

  // Wait for the file to flip from `processing` → `ready`. The
  // panel polls `/api/workspaces/:id/knowledge` every 5s; the
  // status badge changes accordingly. The processing pipeline
  // (markitdown → chunk → embed each chunk → pgvector insert)
  // typically finishes in 3-15s for a small HTML file.
  await flow.heading('markoto reads the file', 3)
  await flow.narrate(
    'markoto converts the file to text, splits it into sections and '
    + 'indexes them, both by meaning and by exact words. A small file '
    + 'is ready in a few seconds; the badge flips to Ready when the AI '
    + 'can use it.'
  )

  // Poll for ready. The badge text uses the i18n string
  // `knowledge.statusReady` ("Ready"). 60s budget, small HTML
  // should finish in <15s; the budget is for cold markitdown
  // / cold embedding.
  await expect(page.locator('[data-testid^="knowledge-file-row-"][data-status="ready"]').first()).toBeVisible({ timeout: 60_000 })

  await flow.shot(
    'The file is Ready, the AI can now look things up in it.'
  )

  // Create a doc inside the workspace
  await flow.heading('Now ask the AI about it', 3)
  await flow.narrate(
    editor.isMobile
      ? 'You\'re already in a document inside the workspace, so the AI can '
      + 'search the workspace\'s files whenever your request refers to them. '
      + 'Close the Knowledge drawer so the AI prompt bar is reachable.'
      : 'Create a new document in this workspace. Inside a workspace the '
        + 'AI can search its files whenever your request refers to them '
        + ': no extra setup.'
  )

  if (editor.isMobile) {
    // Already in a workspace doc, close the Knowledge drawer so the
    // AI prompt bar is reachable. Same Escape pattern the mobile
    // sibling uses (BottomSheet listens on document keydown).
    await flow.step(
      'Close the Knowledge drawer (Escape)',
      async () => {
        await page.keyboard.press('Escape')
        await page.locator('.mk-sheet-host').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
      }
    )
  } else {
    // Switch back to the Documents tab and pick New -> New document.
    await flow.click(
      'Switch to the Documents tab',
      page.getByRole('tab', { name: /documents/i }),
      {
        result: 'The Documents tab opens: no documents yet, and a "New" button above the list.',
        after: () => page.getByTestId('explorer-new').waitFor({ state: 'visible' })
      }
    )

    await flow.click(
      'Click "New"',
      page.getByTestId('explorer-new'),
      {
        result: 'The menu offers a new document, a new folder or an import.',
        after: () => page.getByRole('menuitem', { name: /^new document/i }).waitFor({ state: 'visible' })
      }
    )

    // "New document" opens the new-document dialog; creating it POSTs
    // to /api/docs with the workspaceId, then routes to the new doc.
    await flow.click(
      'Pick "New document"',
      page.getByRole('menuitem', { name: /^new document/i }),
      {
        result: 'The new-document dialog opens. Give the doc a name.',
        after: async () => {
          // The data-testid on UModal never reaches the DOM; probe the
          // title input, which is inside the open dialog body.
          await page.locator('[data-testid="newdoc-title-input"]').waitFor({ state: 'visible', timeout: 10_000 })
        }
      }
    )

    await editor.page.newDocDialog.titleInput.click()
    await editor.page.newDocDialog.titleInput.pressSequentially(docTitle)
    await expect(editor.page.newDocDialog.titleInput).toHaveValue(docTitle)
    await flow.click(
      'Click "Create document"',
      editor.page.newDocDialog.submitCreate,
      {
        result: 'The editor opens inside the workspace, with the AI prompt bar at the bottom.',
        after: async () => {
          await page.waitForURL(/\/d\/[^/]+/)
          await editor.page.waitForReady()
          await expect(editor.page.titleButton).toContainText(docTitle)
          await editor.page.setDocText(docBody)
          await editor.page.switchToSplitView()
          await editor.page.waitForPreviewPaginated()
          // Cover off so the preview's first page shows the AI's
          // grounded answer, not the title sheet.
          await editor.page.disableCoverPage()
        }
      }
    )
  }

  // Ask a question grounded in the file
  await flow.heading('A question grounded in the postmortem', 3)
  await flow.narrate(
    'The uploaded postmortem has specific facts no AI could guess: the '
    + 'staged rollout caught an avatar bug at 5%, and the team wants to '
    + 'cut the 24-hour rollout interval to 12 hours. Ask about it and '
    + 'the AI looks it up in the file before it writes.'
  )

  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    {
      result: 'The prompt bar lifts and glows, ready for your question.'
    }
  )

  // Imperative phrasing pinning the AI to a doc edit. A pure
  // "Summarise…" reads as a chat question and Mistral may answer via
  // `message_to_user` (lands in the prompt-bar response panel, not
  // the doc). The "Insert a short paragraph" lead-in routes the
  // answer through `insert_text` so the assertion below, which reads
  // off `.cm-content`: actually sees it.
  const prompt = 'Add a short paragraph at the end of this doc on what our uploaded Q3 launch postmortem says about staged rollouts.'
  await flow.type(
    'Type a question only the file knows the answer to',
    editor.page.ai.promptBarInput,
    prompt,
    {
      result: 'The question is ready. Send it and the AI searches your files first.'
    }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working, it searches the workspace files, then writes the paragraph.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // The agentic loop typically runs 1-3 turns for a knowledge query:
  // search_knowledge and/or get_knowledge_file → insert_text
  // with the grounded answer. 90s budget covers worst case.
  await editor.page.waitForAiIdle()

  // ASSERTION: the AI actually consulted the knowledge base this session
  // (the Activity log records every AI tool call), through
  // search_knowledge, or by reading the file directly with
  // get_knowledge_file, which the model picks when the workspace holds a
  // single short file; both are grounded, and the paragraph it
  // wrote carries the file's real figures, 5%, 24 hours, 12 hours.
  // Invented numbers ("~40%", "5–10%") fail here.
  const docId = editor.page.currentDocId()
  await expect.poll(async () => {
    const res = await page.request.get(`/api/docs/${docId}/activity`)
    return res.ok() ? JSON.stringify(await res.json()) : ''
  }, { timeout: 15_000, message: 'the AI never consulted the knowledge base' }).toMatch(/"tool":"(search_knowledge|get_knowledge_file)"/)
  const docText = await editor.page.docText()
  expect(docText).toMatch(/5\s?%/)
  expect(docText).toMatch(/24[\s-]?(h\b|hours?)/i)
  // "12 hours" / "12h", or the unit carried over from the 24 ("from 24
  // hours to 12"), which the model writes about as often. Still the
  // file's real figure; an invented interval fails.
  expect(docText).toMatch(/12[\s-]?(h\b|hours?)|\bto\s+12\b/i)
  await editor.page.scrollEditorTo(/5\s?%/)

  await flow.shot(
    'The AI quoted the postmortem, the avatar bug caught at 5%, and the '
    + 'plan to cut the 24-hour rollout interval to 12 hours. None of '
    + 'this is generic AI knowledge, it came straight from the file.',
    {
      // Hero outcome: a doc body containing facts that ONLY exist in
      // the uploaded file. This is the "AI grounded in YOUR data"
      // moment that sells the workspace knowledge feature.
      hero: true,
      highlights: [
        { label: 'AI\'s grounded answer', selector: '.cm-content' }
      ]
    }
  )

  // Forward route: now that the workspace has knowledge, sharing
  // a polished version of the AI's grounded answer is the natural
  // next step.
  flow.next({
    slug: 'polished-pdf',
    why: 'Now polish the grounded answer and download it as a PDF'
  })
})
