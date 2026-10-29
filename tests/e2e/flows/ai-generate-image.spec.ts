import { test, expect, requireLiveAi } from '../fixtures/flow'

// Tier 2: "Ask the AI to draw an image."
//
// User-job: a writer wants a hero image, a thumbnail, a diagram
// illustration — without leaving the doc to open Photoshop or pay
// for stock. Job done when the AI generates an image from a prompt
// and inserts it into the doc, where it renders inline in the
// preview just like any markdown image.
//
// Pipeline: prompt → AI calls `generate_image` → the image provider
// (bundled default: BFL FLUX.2 [pro] via LiteLLM) returns the image →
// markoto stores it under the doc → registers an `uploads` row →
// returns the markdown reference → the AI inserts it. The
// image is owned by the doc; deletion cascades clean up.
//
// Live LiteLLM round-trip → BFL. Cost: ~$0.030 per 1024² image. Skipped if no key.
test('Ask the AI to draw an image', async ({ flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  const draft = '# Field notebook\n\nA place for sketches, lists and half-finished thoughts from the studio.\n\n## This week\n\n- Sketch the new shelf layout\n- Order more paper\n'
  await editor.silentSetup({ title: 'Field notebook', body: draft, cover: false })

  await flow.heading('Ask the AI to draw an image', 3)
  await flow.narrate(
    'The AI prompt bar can do more than write. Ask it for an image '
    + 'and it draws one with your image provider, stores it with the '
    + 'document and places it in the text. It renders in the preview '
    + 'like any image you uploaded yourself, and it is deleted together '
    + 'with the document.'
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
    { result: 'Your prompt is ready. Hit send.' }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — it draws the image, then places it in the document.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // The agentic loop: generate_image (~5-15s) → insert_text → done.
  // Total budget 90s.
  await editor.page.waitForAiIdle()

  // ASSERTION: an image reference to a file stored with THIS doc
  // (![…](/api/files/<docId>/…)) landed in the text, and the preview
  // renders it as a loaded image — not a broken placeholder.
  const docId = editor.page.currentDocId()
  const added = await editor.page.addedText(draft)
  expect(added, `no image reference in: ${added}`).toMatch(new RegExp(`!\\[[^\\]]*\\]\\(/api/files/${docId}/[^)]+\\)`))
  await editor.page.scrollEditorTo('/api/files/')
  if (!editor.isMobile) {
    const img = editor.page.previewRoot().locator('#mount img[src*="/api/files/"]').first()
    await expect(img).toBeAttached({ timeout: 20_000 })
    await expect.poll(
      () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      { timeout: 20_000, message: 'the generated image never loaded in the preview' }
    ).toBe(true)
    await editor.page.scrollPreviewTo('img[src*="/api/files/"]')
  }

  await flow.shot(
    'The AI drew the illustration and placed it at the top of the '
    + 'document — the preview shows the image itself.',
    {
      hero: true,
      highlights: [
        { label: 'The image in your text', selector: '.cm-line:has-text("/api/files/")' }
      ]
    }
  )

  flow.next({
    slug: 'rich-content',
    why: 'More markdown extensions — code, alerts, math, diagrams'
  })
})
