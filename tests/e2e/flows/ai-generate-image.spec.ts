import { test, expect } from '../fixtures/flow'

// Tier 2: "Ask the AI to draw an image."
//
// User-job: a writer wants a hero image, a thumbnail, a diagram
// illustration — without leaving the doc to open Photoshop or pay
// for stock. Job done when the AI generates an image from a prompt
// and inserts it into the doc, where it renders inline in the
// preview just like any markdown image.
//
// Pipeline: prompt → AI calls `generate_image` → Gemini image-gen
// API returns base64 PNG → markoto uploads to S3 → registers an
// `uploads` row → returns markdown reference → AI's next turn
// inserts the reference. The image is owned by the doc; deletion
// cascades clean up.
//
// Live Gemini call. Cost: ~$0.045 per image gen. Skipped if no key.
test('Ask the AI to draw an image', async ({ page, flow, editor }) => {
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows.'
  )
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  await flow.heading('Ask the AI to draw an image', 3)
  await flow.narrate(
    'The AI prompt bar can do more than write. Ask it to generate '
    + 'an image and it calls Gemini\'s image-gen model, uploads the '
    + 'result to your doc\'s S3 prefix, and inserts the markdown '
    + 'reference at the cursor. The image renders inline in the '
    + 'preview just like any other; deleting the doc cascades the '
    + 'image cleanup.'
  )

  // ─── Prompt + send ──────────────────────────────────────────────
  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    { result: 'The prompt bar lifts and glows — ready for your prompt.' }
  )

  // The AI picks `generate_image` to mint a real markdown reference
  // (the system prompt forbids fabricating /api/files/... paths) and
  // then chains `insert_text` to place it in the doc. Phrasing the
  // request as "add a small illustration of X" is the canonical user
  // hook for this two-tool sequence.
  const prompt = 'Add a small illustration of a notebook with a pen to the top of this document.'
  await flow.type(
    'Type the image prompt',
    editor.page.ai.promptBarInput,
    prompt,
    { result: 'Your prompt is staged. Hit send to kick off the AI.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — generate_image runs, then the AI inserts the markdown reference.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // The agentic loop: generate_image (~5-15s) → insert_text → done.
  // Total budget 90s.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI generated an image, uploaded it, and inserted the '
    + 'markdown reference. The preview renders the actual PNG inline.',
    {
      hero: true,
      highlights: [
        { label: 'AI-generated image', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: an image markdown reference (![…](/api/files/…))
  // landed in the editor source. The AI is non-deterministic in its
  // wording around the image but always uses the markdown image
  // syntax so the renderer can pick it up.
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/!\[/)
  expect(editorText).toMatch(/\/api\/files\/[^/]+\/[^)]+\)/)

  flow.next({
    slug: 'rich-content',
    why: 'More markdown extensions — code, alerts, math, diagrams'
  })
})
