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
// Live LiteLLM round-trip. Drives Jina embeddings (search) + Mistral
// (synthesis). MISTRAL_API_KEY + JINA_AI_API_KEY required.
//
// Setup shortcut: the workspace is created via the API, not the UI
// (UI workspace creation is a `WorkspaceFormModal` dance that's
// uninteresting plumbing — the demo's value is what happens AFTER
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
//     used by the workspace page — same backend pipeline either way.
//
// (Until Phase 6.30 there was a `knowledge-rag-mobile.spec.ts`
//  sibling carrying mobile-specific narration. Deleted as part of the
//  "single canonical spec per feature" cleanup — Flow.vue auto-routes
//  variants by viewport via `useMediaQuery('(max-width: 639px)')`.)
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

  const wsName = 'Q3 launch — engineering retro'
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: wsName }
  })
  if (!wsRes.ok()) {
    throw new Error(`[knowledge-rag] workspace create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  // The endpoint returns `{ workspaceId }` — the public nanoid that
  // the route uses, NOT the integer DB id. Navigating to /w/<int>
  // would 404 even though the workspace exists.
  const ws = await wsRes.json() as { workspaceId: string }

  // On mobile, skip the workspace landing page (UX is awkward at
  // `<sm`) and create the workspace doc via API, then land in the
  // editor where the Knowledge bottom-tab drawer surfaces the same
  // upload UI as the desktop landing page's Knowledge tab.
  if (editor.isMobile) {
    const docRes = await page.request.post('/api/docs', {
      data: { workspaceId: ws.workspaceId }
    })
    if (!docRes.ok()) {
      throw new Error(`[knowledge-rag] doc create failed: ${docRes.status()} ${await docRes.text()}`)
    }
    const doc = await docRes.json() as { docId: string }
    await page.goto(`/d/${doc.docId}`)
    await editor.page.waitForReady()
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
    'Workspaces have a Knowledge tab — drop in PDFs, Word docs, '
    + 'HTML exports, the team\'s RFCs, customer FAQs. markoto converts '
    + 'them to markdown via markitdown, splits them into heading-aware '
    + 'chunks, embeds each chunk via Jina v5-text-nano (through the '
    + 'LiteLLM proxy), and indexes both the '
    + 'vector AND a tsvector for hybrid retrieval. The AI gets a '
    + '`search_knowledge` tool that hits this index.'
  )

  // ─── Upload a knowledge file ────────────────────────────────────
  await flow.heading('Upload the file', 3)

  // Open the Knowledge surface. Desktop = workspace-landing-page
  // tab. Mobile = bottom-tab-bar drawer in the editor.
  if (editor.isMobile) {
    await flow.click(
      'Tap the Knowledge tab on the bottom bar',
      editor.page.mobileTabs.knowledge,
      {
        result: 'The Knowledge drawer slides up — empty until you upload your first file.',
        after: () => page.locator('[data-testid="knowledge-upload-button"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      }
    )
  } else {
    // Tabs use `role="tab"` from Reka — the Knowledge tab's
    // accessible name comes from `workspace.tabs.knowledge` (en: "Knowledge").
    await flow.click(
      'Open the Knowledge tab',
      page.getByRole('tab', { name: /knowledge/i }),
      {
        annotations: [
          { label: 'knowledge tab', selector: '[role="tab"][aria-selected="false"]', kind: 'arrow' }
        ],
        result: 'The Knowledge panel opens — empty until you upload your first file.',
        after: () => page.locator('[data-testid="knowledge-upload-button"]').first().waitFor({ state: 'visible' })
      }
    )
  }

  // The Upload button opens a native file chooser via VueUse's
  // useFileDialog. On mobile the button is inside the Knowledge
  // BottomSheet portal where Reka's overlay intercepts pointer
  // events — and DOM-level `el.click()` workaround doesn't trigger
  // the filechooser (browsers require a real user-gesture click for
  // file dialogs). Bypass the chooser entirely by writing directly
  // to the hidden `<input type="file">` via setInputFiles. Desktop
  // path stays on the user-visible filechooser flow.
  const fixture = path.resolve('tests/e2e/fixtures/import-files/q3-launch-postmortem.html')
  if (editor.isMobile) {
    // useFileDialog mounts the hidden `<input type="file">` lazily —
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
      },
      { result: 'The file lands in the upload list — markitdown takes over from here.' }
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
        result: 'The file picker opens — pick the postmortem HTML and markitdown takes over.',
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
  await flow.heading('Processing — markitdown + embeddings', 3)
  await flow.narrate(
    'The file streams to the markitdown sidecar for HTML → markdown '
    + 'conversion, gets split into heading-aware chunks, each chunk '
    + 'is embedded via Jina v5-text-nano (768-d native), and the '
    + 'resulting vectors land in pgvector with a parallel tsvector '
    + 'for lexical search. Hybrid RRF (Reciprocal Rank Fusion) over '
    + 'the two indices gives the AI a grounded retrieval surface.'
  )

  // Poll for ready. The badge text uses the i18n string
  // `knowledge.statusReady` ("Ready"). 60s budget — small HTML
  // should finish in <15s; the budget is for cold markitdown
  // / cold embedding.
  await expect(page.locator('[data-testid^="knowledge-file-row-"][data-status="ready"]').first()).toBeVisible({ timeout: 60_000 })

  await flow.shot(
    'The file is processed — markdown cached, chunks embedded, ready for retrieval.'
  )

  // ─── Create a doc inside the workspace ───────────────────────────
  await flow.heading('Now ask the AI about it', 3)
  await flow.narrate(
    editor.isMobile
      ? 'You\'re already inside a workspace doc — the AI has two extra tools wired up: '
      + '`search_knowledge` (hybrid retrieval over the chunk index) and '
      + '`get_knowledge_file` (full markdown of one file). It picks them automatically '
      + 'when your prompt smells like a knowledge question. Close the Knowledge drawer '
      + 'so the AI prompt bar is reachable.'
      : 'Create a new doc in this workspace and the AI gets two extra '
        + 'tools: `search_knowledge` (hybrid retrieval over the chunk '
        + 'index) and `get_knowledge_file` (full markdown of one file). '
        + 'It picks them automatically when your prompt smells like a '
        + 'knowledge question.'
  )

  if (editor.isMobile) {
    // Already in a workspace doc — close the Knowledge drawer so the
    // AI prompt bar is reachable. Same Escape pattern the mobile
    // sibling uses (BottomSheet listens on document keydown).
    await flow.step(
      'Close the Knowledge drawer (Escape)',
      async () => {
        await page.keyboard.press('Escape')
        await page.locator('.mk-sheet-host').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
      },
      { result: 'The drawer slides down — the editor + AI prompt bar are visible again.' }
    )
  } else {
    // Switch back to the Documents tab and click "New document".
    await flow.click(
      'Switch to the Documents tab',
      page.getByRole('tab', { name: /documents/i }),
      {
        result: 'The Documents tab opens — no docs yet, but a "New document" button is right there.',
        after: () => page.locator('[data-testid="workspace-new-document"]').first().waitFor({ state: 'visible' })
      }
    )

    // Create a workspace doc. The button calls a method that POSTs
    // to /api/docs with the workspaceId, then routes to the new doc.
    await flow.click(
      'Click "New document"',
      page.locator('[data-testid="workspace-new-document"]').first(),
      {
        result: 'A blank doc opens, scoped to this workspace. The AI now has '
          + 'access to the postmortem you uploaded.',
        after: async () => {
          // Wait for the new-doc dialog. The data-testid is on UModal
          // (Reka renders it in a portal which doesn't always
          // surface attributes on the visible dialog content), so
          // probe the title input which IS reliably inside the open
          // dialog body.
          await page.locator('[data-testid="newdoc-title-input"]').waitFor({ state: 'visible', timeout: 10_000 })
        }
      }
    )

    // Submit the dialog with default settings (blank doc, just give
    // me the editor). The submit-blank path skips the form fields.
    await flow.click(
      'Pick "Just give me a blank doc" to skip the form',
      page.locator('[data-testid="newdoc-submit-blank"]'),
      {
        result: 'The editor opens. The AI prompt bar is at the bottom and the '
          + 'workspace knowledge tools are wired up server-side.',
        after: async () => {
          await page.waitForURL(/\/d\/[^/]+/)
          await editor.page.waitForReady()
          // Disable cover so the AI's grounded answer (lands at end-
          // of-doc which is page 1 of a blank doc) is visible in the
          // preview pane.
          await editor.page.disableCoverPage()
          await editor.page.switchToSplitView()
          await editor.page.waitForPreviewPaginated()
        }
      }
    )
  }

  // ─── Ask a question grounded in the file ────────────────────────
  await flow.heading('A question grounded in the postmortem', 3)
  await flow.narrate(
    'The fixture file is a Q3 launch postmortem with specific facts: '
    + 'a 24-hour staged rollout, an avatar-loading regression caught '
    + 'at 5%, an open question about whether on-call should include '
    + 'a designer. The AI should pick up `search_knowledge`, find '
    + 'the relevant chunks, and quote them back in its answer.'
  )

  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    {
      result: 'The prompt bar lifts and glows — ready for your question.'
    }
  )

  // Imperative phrasing pinning the AI to a doc edit. A pure
  // "Summarise…" reads as a chat question and Mistral may answer via
  // `message_to_user` (lands in the prompt-bar response panel, not
  // the doc). The "Insert a short paragraph" lead-in routes the
  // answer through `insert_text` so the assertion below — which reads
  // off `.cm-content` — actually sees it.
  const prompt = 'Insert a short paragraph at the end of this document summarising what the Q3 postmortem said about staged rollouts.'
  await flow.type(
    'Type a question only the file knows the answer to',
    editor.page.ai.promptBarInput,
    prompt,
    {
      result: 'The question is staged. Hit send and watch the AI search the knowledge base.'
    }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — it calls `search_knowledge`, gets back '
        + 'chunks from the postmortem, and folds them into its reply.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // The agentic loop typically runs 1-3 turns for a knowledge query:
  // search_knowledge → (optional) get_knowledge_file → insert_text
  // with the grounded answer. 90s budget covers worst case.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI quoted the postmortem — the staged-rollout interval (24h), '
    + 'the avatar-bug catch at 5%, the proposed change to 12h. None of '
    + 'this is generic AI knowledge — it came straight from the file.',
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

  // ASSERTION: the doc grew AND the body mentions specific facts
  // from the postmortem fixture. We don't assert exact phrasing —
  // the model's wording varies — but the staged-rollout reference is
  // the key claim, and "5%" or "24" should land verbatim because
  // they're concrete numbers the model has nothing to substitute
  // them with.
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText?.length ?? 0).toBeGreaterThan(100)
  // The fixture contains "Staged rollout caught the avatar-loading
  // regression at 5%" — the model should reproduce one of those
  // landmarks.
  expect(editorText).toMatch(/staged rollout|5%|24h|avatar/i)

  // Forward route: now that the workspace has knowledge, sharing
  // a polished version of the AI's grounded answer is the natural
  // next step.
  flow.next({
    slug: 'polished-pdf',
    why: 'Now polish the grounded answer and download it as a PDF'
  })
})
