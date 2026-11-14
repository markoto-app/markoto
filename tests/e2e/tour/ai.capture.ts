import fs from 'node:fs'
import path from 'node:path'
import { requireLiveAi } from '../fixtures/flow'
import { test, expect, settlePreview, applyTheme, useOwnMistralKey, withCover, TOUR_OUTPUT } from './fixture'
import { demoDocument as demo, knowledgeFile } from './content/demoDocument'

// Scenes 5 and 6: the AI writing a whole block of the report live, and an
// answer grounded in an uploaded file. The AI runs on the signed-in user's
// own key (the hosted markoto.app shape: no instance-paid AI, no points
// meter). Every answer is checked before the clip is kept: the required
// text, and every number in it must come from its sources.

const noCover = withCover(demo.theme, false)

/** Every number the AI wrote must exist in one of the sources (no invented figures). */
function expectNumbersFrom(added: string, sources: string[]): void {
  const norm = (s: string) => s.replace(/[\u2009\u202f\u00a0]/g, ' ').replace(/−/g, '-')
  const haystack = sources.map(norm).join('\n')
  const numbers = norm(added).match(/\d+(?:[.,]\d+)*/g) ?? []
  const missing = numbers.filter(n => !haystack.includes(n))
  expect(missing, `numbers not found in the sources:\n${added}`).toEqual([])
}

/** The footage shows the AI's text: no em-dash (U+2014), as everywhere in markoto's own copy. Retake instead. */
function expectNoEmDash(added: string): void {
  expect(added, 'the AI wrote an em-dash; record the scene again').not.toMatch(/\u2014/)
}

test('Tour: AI in the document', async ({ page, editor, tour }) => {
  requireLiveAi()
  test.setTimeout(600_000)
  await editor.page.loginAsTestUser(demo.author)
  await useOwnMistralKey(page)
  // A minimal document: the title only.
  await editor.silentSetup({ title: demo.title, body: `# ${demo.title}\n\n` })
  await applyTheme(page, noCover)
  // The facts the AI may use live in the document's description (document context).
  const meta = await page.request.put(`/api/docs/${editor.page.currentDocId()}/meta`, { data: { description: demo.aiDescription } })
  expect(meta.ok(), await meta.text()).toBe(true)
  await settlePreview(page, 1500)
  await expect(page.getByTestId('usage-badge')).toHaveCount(0)

  const clip = await tour.clip('ai')
  await clip.frame(8)
  await clip.click(editor.page.ai.promptBarInput)
  await clip.type(demo.aiPrompt, 4)
  await clip.frame(4)
  const before = await editor.page.docText()
  await clip.click(editor.page.ai.promptBarSend, { after: () => editor.page.waitForAiActive() })
  await clip.cursor(false)
  // The AI writes into the document; one frame every ~0.4 s while it works.
  await clip.record(async () => (await editor.page.ai.promptBar.getAttribute('data-active')) === 'false', { everyMs: 400, maxFrames: 400 })
  await editor.page.waitForAiIdle()
  await settlePreview(page, 1500)
  const added = await editor.page.addedText(before)
  console.log(`[tour:ai] added text:\n${added}`)
  for (const fact of demo.aiMustMention) expect(added).toMatch(fact)
  expectNoEmDash(added)
  // The title line stays as it was; the summary goes below it.
  expect((await editor.page.docText()).split('\n')[0]).toBe(`# ${demo.title}`)
  expectNumbersFrom(added, [demo.aiDescription, demo.markdown])
  await editor.page.dismissToasts().catch(() => {})
  await clip.frame(6)
  const box = await page.locator('iframe').first().boundingBox()
  await clip.done({
    description: 'From a title only, the AI writes an executive summary with a key-figures table into the report while the preview updates.',
    focus: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(Math.min(box.height, 900 - box.y)) } : { x: 720, y: 120, w: 720, h: 760 }
  })
})

test('Tour: answers from your own files', async ({ page, editor, tour }) => {
  requireLiveAi()
  test.setTimeout(600_000)
  await editor.page.loginAsTestUser(demo.author)
  await useOwnMistralKey(page)

  // The memo as a PDF, printed from its HTML source.
  const pdfPath = path.join(TOUR_OUTPUT, knowledgeFile.pdfName)
  fs.mkdirSync(TOUR_OUTPUT, { recursive: true })
  const printer = await page.context().newPage()
  await printer.setContent(fs.readFileSync(path.resolve(knowledgeFile.path), 'utf8'))
  await printer.pdf({ path: pdfPath, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' } })
  await printer.close()

  const wsRes = await page.request.post('/api/workspaces', { data: { name: knowledgeFile.workspace } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const ws: unknown = await wsRes.json()
  const workspaceId = typeof ws === 'object' && ws !== null ? String(Reflect.get(ws, 'workspaceId')) : ''
  const docRes = await page.request.post('/api/docs', { data: { workspaceId, title: knowledgeFile.docTitle } })
  expect(docRes.ok(), await docRes.text()).toBe(true)
  const doc: unknown = await docRes.json()
  const docId = typeof doc === 'object' && doc !== null ? String(Reflect.get(doc, 'docId')) : ''
  await page.goto(`/d/${docId}`)
  await editor.page.waitForReady()
  await editor.page.setDocText(knowledgeFile.docBody)
  await editor.page.switchToSplitView()
  await editor.page.waitForPreviewPaginated()
  await applyTheme(page, noCover)
  await settlePreview(page, 1200)

  const clip = await tour.clip('knowledge')
  await clip.frame(6)
  // Open the workspace knowledge and upload the memo.
  await clip.click(editor.page.sidebar.knowledge, {
    after: async () => { await page.locator('[data-testid="knowledge-upload-button"]').first().waitFor({ state: 'visible' }) }
  })
  await clip.frame(4)
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 })
  await clip.click(page.locator('[data-testid="knowledge-upload-button"]').first(), {
    after: async () => {
      const chooser = await chooserPromise
      await chooser.setFiles(pdfPath)
    }
  })
  const row = page.locator(`[data-testid^="knowledge-file-row-"][data-filename="${knowledgeFile.pdfName}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await clip.record(async () => (await row.getAttribute('data-status')) === 'ready', { everyMs: 500, maxFrames: 200 })
  await expect(row).toHaveAttribute('data-status', 'ready', { timeout: 90_000 })
  await clip.moveTo(row)
  await clip.frame(10)

  // Ask; the answer quotes the memo.
  const before = await editor.page.docText()
  await clip.click(editor.page.ai.promptBarInput)
  await clip.type(knowledgeFile.prompt, 6)
  await clip.click(editor.page.ai.promptBarSend, { after: () => editor.page.waitForAiActive() })
  await clip.record(async () => (await editor.page.ai.promptBar.getAttribute('data-active')) === 'false', { everyMs: 400, maxFrames: 400 })
  await editor.page.waitForAiIdle()
  await settlePreview(page, 1200)
  const added = await editor.page.addedText(before)
  console.log(`[tour:knowledge] added text:\n${added}`)
  const quoted = knowledgeFile.facts.filter(f => f.test(added))
  expect(quoted.length, `the answer must quote the memo's figures, got:\n${added}`).toBeGreaterThanOrEqual(3)
  expect(added).toMatch(/memo|carrier/i)
  expectNoEmDash(added)
  expectNumbersFrom(added, [fs.readFileSync(path.resolve(knowledgeFile.path), 'utf8'), knowledgeFile.docBody, knowledgeFile.prompt])
  await page.frameLocator('iframe').first().locator('#mount').evaluate((mount: HTMLElement) => {
    const ps = mount.querySelectorAll('p')
    ps[ps.length - 1]?.scrollIntoView({ block: 'center' })
  })
  await expect(page.getByTestId('usage-badge')).toHaveCount(0)
  await editor.page.dismissToasts().catch(() => {})
  const answer = page.locator('.cm-line').filter({ hasText: /no-show/i }).first()
  await clip.moveTo(answer)
  await clip.frame(8)
  const previewBox = await page.locator('iframe').first().boundingBox()
  const left = Math.round(previewBox?.x ?? 560)
  await clip.done({
    description: 'A carrier network memo is uploaded to the workspace knowledge, processed, and the AI answers from it, quoting its figures.',
    focus: { x: left, y: 110, w: 1440 - left, h: Math.min(780, Math.round((1440 - left) * 0.8)) }
  })
})
