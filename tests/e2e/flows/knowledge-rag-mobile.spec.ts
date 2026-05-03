import { test, expect } from '../fixtures/flow'
import path from 'node:path'

// Tier 2 (mobile sibling): "Ask the AI about a file you uploaded —
// on mobile."
//
// Same payoff as knowledge-rag.spec.ts: upload → embed → AI grounds
// its answer in the file. Different surface: mobile users do this
// from INSIDE a doc (the workspace landing page is awkward at narrow
// widths) — the Knowledge tab on the mobile bottom bar opens the
// same upload + list panel that desktop users see in the right
// sidebar.
//
// Setup shortcut: workspace + doc created via API so the flow starts
// at the in-doc mobile editor where the demo actually happens.
//
// Live Gemini call. Mobile-only.
test('Knowledge grounded AI on mobile', async ({ page, flow, editor }) => {
  test.skip(
    !editor.isMobile,
    'Mobile-only sibling — desktop story is in knowledge-rag.spec.ts.'
  )
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows.'
  )
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  // Touch the homepage so the session cookie attaches before the
  // POST to /api/workspaces (same reason as the desktop sibling).
  await page.goto('/')

  // Create the workspace + a doc inside it via API.
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Q3 launch — engineering retro' }
  })
  if (!wsRes.ok()) {
    throw new Error(`[knowledge-rag-mobile] workspace create failed: ${wsRes.status()} ${await wsRes.text()}`)
  }
  const ws = await wsRes.json() as { workspaceId: string }

  const docRes = await page.request.post('/api/docs', {
    data: { workspaceId: ws.workspaceId }
  })
  if (!docRes.ok()) {
    throw new Error(`[knowledge-rag-mobile] doc create failed: ${docRes.status()} ${await docRes.text()}`)
  }
  const doc = await docRes.json() as { docId: string }

  // Land in the editor.
  await page.goto(`/d/${doc.docId}`)
  await editor.page.waitForReady()
  // Cover sheet hides any inserted content in the preview; disable.
  await editor.page.disableCoverPage()

  await flow.heading('Ask the AI about a file you uploaded on mobile', 3)
  await flow.narrate(
    'Workspaces have a Knowledge tab — drop in PDFs, Word docs, '
    + 'HTML exports, the team\'s RFCs. markoto converts them to '
    + 'markdown, embeds each chunk, and gives the AI a '
    + '`search_knowledge` tool that hits the index when your prompt '
    + 'smells like a knowledge question. On mobile, the Knowledge '
    + 'tab on the bottom bar surfaces the same upload + list panel '
    + 'that desktop users get in the right sidebar.'
  )

  // ─── Open the Knowledge drawer + upload ─────────────────────────
  await flow.click(
    'Tap the Knowledge tab on the bottom bar',
    editor.page.mobileTabs.knowledge,
    {
      result: 'The Knowledge drawer slides up — empty until you upload your first file.',
      after: () => page.locator('[data-testid="knowledge-upload-button"]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // Same chooser dance as the desktop sibling — register before the
  // click that opens the file picker.
  const fixture = path.resolve('tests/e2e/fixtures/import-files/q3-launch-postmortem.html')
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })

  await flow.click(
    'Tap Upload',
    page.locator('[data-testid="knowledge-upload-button"]').first(),
    {
      result: 'The file picker opens — pick the postmortem HTML.',
      after: async () => {
        const chooser = await chooserPromise
        await chooser.setFiles(fixture)
        await page.locator('[data-testid^="knowledge-file-row-"][data-filename="q3-launch-postmortem.html"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      }
    }
  )

  // Wait for processing → ready (same pipeline as desktop: markitdown
  // → chunk → embed → pgvector).
  await flow.heading('Processing — markitdown + embeddings', 3)
  await flow.narrate(
    'The file streams to the markitdown sidecar for HTML → markdown '
    + 'conversion, gets split into heading-aware chunks, each chunk '
    + 'is embedded via Gemini\'s 768-d embedding model, and the '
    + 'resulting vectors land in pgvector with a parallel tsvector '
    + 'for lexical search. Hybrid RRF over the two indices gives the '
    + 'AI a grounded retrieval surface.'
  )

  await expect(page.locator('[data-testid^="knowledge-file-row-"][data-status="ready"]').first()).toBeVisible({ timeout: 60_000 })

  // Close the Knowledge drawer so the AI prompt bar is reachable.
  // The drawer covers the bottom tab bar — tapping Knowledge again
  // can't close it because the tab is behind the drawer. Press
  // Escape; the drawer host listens for it.
  await flow.step(
    'Close the drawer (Escape)',
    async () => {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
    },
    { result: 'The drawer slides down — the AI prompt bar is reachable.' }
  )

  // ─── Ask a question grounded in the file ────────────────────────
  await flow.heading('A question grounded in the postmortem', 3)
  await flow.narrate(
    'The fixture file is a Q3 launch postmortem with specific facts: '
    + 'a 24-hour staged rollout, an avatar regression caught at 5%, '
    + 'an open question about whether on-call should include a '
    + 'designer. The AI should pick up `search_knowledge`, find the '
    + 'relevant chunks, and quote them back in its answer.'
  )

  await flow.click(
    'Tap the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The prompt bar lifts — ready for your question.' }
  )

  const prompt = 'Summarise what the Q3 postmortem said about staged rollouts.'
  await flow.type(
    'Type a question only the file knows the answer to',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'The question is staged.' }
  )

  await flow.click(
    'Tap send',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — `search_knowledge` runs the hybrid retrieval, the model folds the chunks into its reply.',
      after: () => editor.page.waitForAiActive()
    }
  )

  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI quoted the postmortem — the staged-rollout interval (24h), '
    + 'the avatar-bug catch at 5%. None of this is generic AI '
    + 'knowledge — it came straight from the file.',
    {
      hero: true,
      highlights: [
        { label: 'AI\'s grounded answer', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: the doc body mentions specific facts from the postmortem.
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText?.length ?? 0).toBeGreaterThan(100)
  expect(editorText).toMatch(/staged rollout|5%|24h|avatar/i)

  flow.next({
    slug: 'polished-pdf-mobile',
    why: 'Now download the grounded answer as a PDF'
  })
})
