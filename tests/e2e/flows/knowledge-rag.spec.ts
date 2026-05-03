import { test, expect } from '../fixtures/flow'
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
// Live Gemini call. NUXT_GOOGLE_GEMINI_API_KEY required.
//
// Setup shortcut: the workspace is created via the API, not the UI
// (UI workspace creation is a `WorkspaceFormModal` dance that's
// uninteresting plumbing — the demo's value is what happens AFTER
// you have a workspace + a file). The flow starts at the workspace
// landing page so readers see the upload + AI grounding from the
// first frame.
//
// Desktop only: the workspace landing page packs the documents
// list + members + knowledge tabs into a layout that scrolls
// awkwardly on `<sm` widths. Mobile users get the same Knowledge
// drawer inside a doc; that's a separate tier-2 candidate.
test('Knowledge grounded AI', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Knowledge-RAG flow uses the workspace landing page upload UI; mobile workspace layout is a different shape and warrants its own tier-2 flow.'
  )
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows — set it in the host shell before `bun run flows:test`.'
  )
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
  await page.goto(`/w/${ws.workspaceId}`)
  // Wait for the workspace landing page to render the tabs (vs the
  // 404 "Workspace not found" page).
  await page.getByRole('tab', { name: /documents/i }).waitFor({ state: 'visible', timeout: 10_000 })

  // Title + intro before the first capture.
  await flow.heading('Ask the AI about a file you uploaded', 3)
  await flow.narrate(
    'Workspaces have a Knowledge tab — drop in PDFs, Word docs, '
    + 'HTML exports, the team\'s RFCs, customer FAQs. markoto converts '
    + 'them to markdown via markitdown, splits them into heading-aware '
    + 'chunks, embeds each chunk with Gemini, and indexes both the '
    + 'vector AND a tsvector for hybrid retrieval. The AI gets a '
    + '`search_knowledge` tool that hits this index.'
  )

  // ─── Upload a knowledge file ────────────────────────────────────
  await flow.heading('Upload the file', 3)

  // Switch to the Knowledge tab on the workspace landing page.
  // The tabs use `role="tab"` from Reka — the Knowledge tab's
  // accessible name comes from the i18n string `workspace.tabs.knowledge`
  // (en: "Knowledge").
  await flow.click(
    'Open the Knowledge tab',
    page.getByRole('tab', { name: /knowledge/i }),
    {
      annotations: [
        { label: 'knowledge tab', selector: '[role="tab"][aria-selected="false"]', kind: 'arrow' }
      ],
      result: 'The Knowledge panel opens — empty until you upload your first file.',
      after: () => page.getByRole('button', { name: /upload/i }).first().waitFor({ state: 'visible' })
    }
  )

  // The Upload button opens a native file chooser via VueUse's
  // useFileDialog. Same pattern as import-existing — register the
  // waitForEvent BEFORE the click that triggers the chooser.
  const fixture = path.resolve('tests/e2e/fixtures/import-files/q3-launch-postmortem.html')
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })

  await flow.click(
    'Click Upload to pick a file',
    page.getByRole('button', { name: /upload/i }).first(),
    {
      annotations: [
        { label: 'upload', selector: 'button:has-text("Upload")', kind: 'arrow' }
      ],
      result: 'The file picker opens — pick the postmortem HTML and markitdown takes over.',
      after: async () => {
        const chooser = await chooserPromise
        await chooser.setFiles(fixture)
        // Wait for the file row to appear in the list.
        await page.getByText(/q3-launch-postmortem\.html/i).first().waitFor({ state: 'visible', timeout: 10_000 })
      }
    }
  )

  // Wait for the file to flip from `processing` → `ready`. The
  // panel polls `/api/workspaces/:id/knowledge` every 5s; the
  // status badge changes accordingly. The processing pipeline
  // (markitdown → chunk → embed each chunk → pgvector insert)
  // typically finishes in 3-15s for a small HTML file.
  await flow.heading('Processing — markitdown + embeddings', 3)
  await flow.narrate(
    'The file streams to the markitdown sidecar for HTML → markdown '
    + 'conversion, gets split into heading-aware chunks, each chunk '
    + 'is embedded via Gemini\'s 768-d embedding model, and the '
    + 'resulting vectors land in pgvector with a parallel tsvector '
    + 'for lexical search. Hybrid RRF (Reciprocal Rank Fusion) over '
    + 'the two indices gives the AI a grounded retrieval surface.'
  )

  // Poll for ready. The badge text uses the i18n string
  // `knowledge.statusReady` ("Ready"). 60s budget — small HTML
  // should finish in <15s; the budget is for cold markitdown
  // / cold embedding.
  await expect(page.getByText(/^ready$/i).first()).toBeVisible({ timeout: 60_000 })

  await flow.shot(
    'The file is processed — markdown cached, chunks embedded, ready for retrieval.'
  )

  // ─── Create a doc inside the workspace ───────────────────────────
  await flow.heading('Now ask the AI about it', 3)
  await flow.narrate(
    'Create a new doc in this workspace and the AI gets two extra '
    + 'tools: `search_knowledge` (hybrid retrieval over the chunk '
    + 'index) and `get_knowledge_file` (full markdown of one file). '
    + 'It picks them automatically when your prompt smells like a '
    + 'knowledge question.'
  )

  // Switch back to the Documents tab and click "New document".
  await flow.click(
    'Switch to the Documents tab',
    page.getByRole('tab', { name: /documents/i }),
    {
      result: 'The Documents tab opens — no docs yet, but a "New document" button is right there.',
      after: () => page.getByRole('button', { name: /new document/i }).first().waitFor({ state: 'visible' })
    }
  )

  // Create a workspace doc. The button calls a method that POSTs
  // to /api/docs with the workspaceId, then routes to the new doc.
  await flow.click(
    'Click "New document"',
    page.getByRole('button', { name: /new document/i }).first(),
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

  const prompt = 'Summarise what the Q3 postmortem said about staged rollouts.'
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
  // Gemini's wording varies — but the staged-rollout reference is
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
