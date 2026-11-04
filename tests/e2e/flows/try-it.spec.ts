import { readFile } from 'node:fs/promises'
import { test, expect } from '../fixtures/flow'

// "Try markoto without a document": the `::try-it` block on the marketing
// pages (here: the Markdown cheat sheet).
//
// User-job: a visitor wants to see what markoto does with THEIR Markdown
// before committing to anything. Job done when they have a real
// document with their text open in the editor, and a PDF of it on disk.
//
// What the flow asserts:
//   - the block starts as a static rendering (no editor loaded) and turns
//     into a live editor + paged preview when it scrolls near;
//   - typing changes the preview (sanitised client render, sandboxed
//     iframe — the same pipeline as the editor);
//   - the notice says both actions create a document (and for how long it
//     lives without edits);
//   - "Download PDF" creates the document through the anonymous gate and
//     downloads the server-rendered PDF;
//   - "Open as a document" opens that same document, with the typed text.
//
// Tagged @marketing: runs in the marketing-site flow pass
// (`NUXT_MARKETING_SITE_ENABLED=true`, scripts/flows-ephemeral.ts). The
// marketing pages are 404 elsewhere, so the flow skips itself there.
// Desktop and mobile: on phones the block shows Edit / Preview tabs.

const ADDED = '\n## Your own section\n\nThis paragraph was typed on the cheat sheet.\n'

test('Try markoto without a document', { tag: '@marketing' }, async ({ page, flow, editor }) => {
  test.setTimeout(150_000)

  const probe = await page.request.get('/markdown-cheat-sheet')
  test.skip(probe.status() === 404, 'needs NUXT_MARKETING_SITE_ENABLED=true (marketing pages are off on this server)')

  await page.goto('/markdown-cheat-sheet')
  const block = page.getByTestId('try-it')

  // ASSERTION: before it is near the viewport the block is static
  // content — no editor code has run.
  await expect(page.getByTestId('try-it-static')).toHaveCount(1)
  await expect(block).toHaveAttribute('data-state', 'static')

  await flow.heading('Try it on the page', 3)
  await flow.narrate(
    'At the end of the cheat sheet there is a small editor with a sample '
    + 'document. Change the Markdown on the left and the pages on the right '
    + 'follow, exactly as they look in markoto. Nothing is saved while you type.'
  )

  await block.scrollIntoViewIfNeeded()
  await expect(block).toHaveAttribute('data-state', 'live', { timeout: 15_000 })
  const editorContent = page.getByTestId('try-it-editor')
  await expect(editorContent).toBeVisible({ timeout: 15_000 })
  if (!editor.isMobile) {
    await expect(page.getByTestId('try-it-page-count')).toBeVisible({ timeout: 30_000 })
  }

  await flow.step('Type your own text into the editor', async () => {
    await editorContent.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(ADDED)
  })

  // ASSERTION: the typed text is in the editor, and the preview (inside
  // the sandboxed frame) shows it as a heading.
  await expect(editorContent).toContainText('This paragraph was typed on the cheat sheet.')
  if (editor.isMobile) {
    await flow.click('Tap "Preview"', page.getByTestId('try-it-tab-preview'), {
      result: 'The preview shows your new section on the page.',
      after: () => expect(page.getByTestId('try-it-preview')).toBeVisible()
    })
  }
  const frame = page.getByTestId('try-it-preview').frameLocator('iframe')
  await expect(frame.getByRole('heading', { name: 'Your own section' })).toBeVisible({ timeout: 30_000 })
  await flow.shot('The pages on the right follow what you type.', {
    highlights: [{ label: 'your section', selector: '[data-testid="try-it-preview"]' }]
  })

  // ASSERTION: the visitor is told what the buttons do before using them.
  const notice = page.getByTestId('try-it-notice')
  await expect(notice).toContainText('Both buttons create a document')

  // ─── Download PDF ────────────────────────────────────────────
  await flow.heading('Download it as a PDF', 3)
  await flow.narrate(
    'Both buttons turn your text into a real markoto document. Without an '
    + 'account it is open to anyone with its link and deleted after a period '
    + 'without edits; the note under the buttons says how long.'
  )

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
  const pdfButton = page.getByTestId('try-it-pdf')
  await flow.click('Click "Download PDF"', pdfButton, {
    annotations: [{ label: 'creates a document', selector: '[data-testid="try-it-notice"]', kind: 'box' }],
    result: 'The first time, markoto asks you to accept its terms.',
    after: () => expect(editor.page.anonGate.dialog).toBeVisible({ timeout: 30_000 })
  })
  await flow.click('Accept the terms', editor.page.anonGate.accept, {
    result: 'With the terms accepted, you can continue.',
    after: () => expect(editor.page.anonGate.continue).toBeEnabled({ timeout: 30_000 })
  })
  await flow.click('Click "Continue"', editor.page.anonGate.continue, {
    result: 'markoto creates the document, renders the PDF on its server and your browser downloads it.',
    hero: true,
    after: async () => {
      await downloadPromise
    }
  })

  // ASSERTION: a real server-rendered PDF with the typed text's title.
  const download = await downloadPromise
  expect(download.url()).toMatch(/\/renders\/.+\.pdf/)
  const pdf = await readFile(await download.path())
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  expect(download.suggestedFilename()).toBe('Field notes.pdf')

  // ─── Open as a document ──────────────────────────────────────
  await flow.click('Click "Open as a document"', page.getByTestId('try-it-open'), {
    result: 'The same document opens in the editor, with your text in it.',
    after: () => page.waitForURL(/\/d\/[^/]+$/, { timeout: 30_000 })
  })

  // ASSERTION: the opened document carries the typed text (no second
  // document, no template body).
  await expect.poll(() => editor.page.docText(), { timeout: 30_000 }).toContain('This paragraph was typed on the cheat sheet.')
  const text = await editor.page.docText()
  expect(text.startsWith('# Field notes')).toBe(true)
  await flow.shot('Keep writing here, share the link, or sign in to keep the document in your account.')

  flow.next({
    slug: 'polished-pdf',
    why: 'Pick a theme and a cover page before you download the PDF'
  })
})
