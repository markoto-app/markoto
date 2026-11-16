import { test, expect, skipForProviderOutage } from '../fixtures/flow'
import { fakeOpenAiBaseUrl } from '../../integration/setup/env'

// "Generate an image yourself": Insert → Generate image with AI.
//
// User-job: the writer knows exactly which picture belongs where and
// doesn't want to phrase it as a request to the assistant. Everything the
// AI can do a user can do by hand: describe the image, pick a format, see
// what it costs, and it lands at the cursor.
//
// Pipeline: the dialog → POST /api/docs/:docId/images/generate → the same
// `generateDocumentImage` the AI's `generate_image` tool runs (image
// provider, AI Points, storage quota) → the Markdown goes in at the cursor.
//
// Provider: with BFL_API_KEY in the env (release + staging full suite) the
// instance default (BFL FLUX 3 Image Klein, ~$0.009 per image) draws a real
// picture and the cost line shows AI Points. Without it, the flow first
// connects the test stack's fake OpenAI-compatible image provider as the
// user's own key (a 1x1 PNG, "runs on your own provider"), so the dialog,
// the route and the insertion still run end to end. A provider outage on
// the live path skips the flow (tests/e2e/AGENTS.md → Live-provider outages).

const IMAGE_PROVIDER_DOWN = 'The image provider is not available right now'

test('Generate an image yourself', async ({ page, flow, editor }) => {
  test.setTimeout(240_000)
  const live = Boolean(process.env.BFL_API_KEY)

  await editor.page.loginAsTestUser('Maya Chen')
  if (!live) {
    const saved = await page.request.put('/api/user/ai-providers/image', {
      data: { baseUrl: fakeOpenAiBaseUrl(), model: 'fake-image', apiKey: 'sk-flow-fake-image-4242' }
    })
    expect(saved.ok(), await saved.text()).toBe(true)
  }
  const draft = '# Studio newsletter\n\nOur spring open day is on the first Saturday of April. Come and see the new print workshop.\n'
  await editor.silentSetup({ title: 'Studio newsletter', body: draft, cover: false })

  await flow.heading('Generate an image yourself', 3)
  await flow.narrate(
    'You don\'t have to ask the assistant for a picture. Describe it yourself, '
    + 'pick a format, and markoto draws it with your image provider and puts it '
    + 'where your cursor is, stored with the document like an uploaded image.'
  )

  // The cursor goes to the end of the text: the image lands there.
  const cm = page.locator('.cm-content')
  await cm.focus()
  await cm.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')

  const prompt = page.locator('textarea#generate-image-prompt')
  if (editor.isMobile) {
    await flow.click('Tap the Editor tab', editor.page.mobileTabs.editor, {
      result: 'The Editor drawer slides up with Formatting, Headings, Lists and Insert.',
      after: () => page.getByTestId('ecp-generate-image').waitFor({ state: 'visible' })
    })
    await flow.click('Tap "AI image"', page.getByTestId('ecp-generate-image'), {
      // eslint-disable-next-line playwright/no-force-option -- mobile branch only: the drawer sits in the bottom sheet, whose host intercepts pointer routing (tests/e2e/AGENTS.md)
      force: true,
      result: 'The image dialog opens.',
      after: () => prompt.waitFor({ state: 'visible' })
    })
  } else {
    const insertMenu = page.locator('nav[aria-label="Menu bar"] > button').nth(3)
    const menuItem = page.getByRole('menuitem', { name: /generate image with ai/i }).first()
    await flow.click('Open the Insert menu', insertMenu, {
      result: 'The Insert menu opens.',
      after: () => menuItem.waitFor({ state: 'visible' })
    })
    await flow.click('Pick "Generate image with AI"', menuItem, {
      result: 'The image dialog opens.',
      after: () => prompt.waitFor({ state: 'visible' })
    })
  }

  await flow.type(
    'Describe the picture',
    prompt,
    'A sunny print workshop with a letterpress, paper drying on lines, watercolour style',
    { result: 'Your description is ready.' }
  )
  await page.getByTestId('generate-image-size').getByRole('tab', { name: /landscape/i }).click()
  const cost = page.getByTestId('generate-image-cost')
  await expect(cost).toHaveText(live ? /AI Points/ : /your own image provider/)
  await flow.shot('Pick a format. The dialog says what one image costs before you generate it.', {
    highlights: [{ label: 'Cost', selector: '[data-testid="generate-image-cost"]' }]
  })

  const modal = page.getByTestId('generate-image-modal')
  const error = page.getByTestId('generate-image-error')
  await flow.click('Click "Generate"', page.getByTestId('generate-image-submit'), {
    result: 'markoto draws the picture; this takes a few seconds.',
    after: async () => {
      await expect(modal.or(error).first()).toBeVisible()
      await expect.poll(async () => (await error.isVisible()) || !(await modal.isVisible()), { timeout: 120_000 }).toBe(true)
    }
  })
  if (await error.isVisible()) {
    const text = (await error.textContent()) ?? ''
    if (text.includes(IMAGE_PROVIDER_DOWN)) skipForProviderOutage('the image provider (Black Forest Labs) is unavailable')
    throw new Error(`image generation failed: ${text}`)
  }

  // ASSERTION: an image stored with THIS document, as its own paragraph
  // after the text, and (desktop) loaded in the preview.
  const docId = editor.page.currentDocId()
  const added = await editor.page.addedText(draft)
  expect(added, `no image reference in: ${added}`).toMatch(new RegExp(`!\\[[^\\]]*\\]\\(/api/files/${docId}/[^)]+\\)`))
  expect(await editor.page.docText()).toMatch(/workshop\.\n\n!\[/)
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

  await flow.shot('The picture is in your document, right where the cursor was.', {
    hero: true,
    highlights: [
      editor.isMobile
        ? { label: 'The image in your text', selector: '.cm-line:has-text("/api/files/")' }
        : { label: 'The generated image', selector: 'iframe' }
    ]
  })

  flow.next({ slug: 'ask-the-ai-to-draw-an-image', why: 'Or let the assistant pick and place the picture' })
})
