import { test, expect } from '../fixtures/flow'
import { pdfText, showPdf } from '../fixtures/downloadViewer'

// "Cite sources": add a reference by pasting BibTeX, cite it, and get a
// formatted bibliography in the preview and the PDF.
//
// User-job: a student has a source in Zotero (or on a publisher page) and
// wants it cited properly. Job done when the citation reads "(Lovelace,
// 1843)" and the reference list in the downloaded PDF carries the entry.
//
// Desktop opens the References panel from the sidebar strip; mobile from
// the Editor drawer (no tab of its own). Mobile is edit-only, so the
// preview check runs on desktop and the PDF check on both.
const BIBTEX = [
  '@article{lovelace1843,',
  '  author  = {Lovelace, Ada},',
  '  title   = {Notes by the Translator},',
  '  journal = {Scientific Memoirs},',
  '  volume  = {3},',
  '  pages   = {666--731},',
  '  year    = {1843}',
  '}'
].join('\n')

const DRAFT = [
  '# The first program',
  '',
  'The first published algorithm for a machine was written for an engine that was never built. It computed Bernoulli numbers, step by step, in a table.',
  ''
].join('\n')

test('Cite sources', async ({ page, flow, editor }) => {
  test.setTimeout(180_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'The first program', body: DRAFT, cover: false })

  await flow.heading('Cite a source', 3)
  await flow.narrate(
    'Keep your sources in the document\'s bibliography: paste a BibTeX '
    + 'entry from Zotero, Google Scholar or a publisher page, or add a DOI. '
    + 'Cite with [@key] and markoto writes the citation and the reference '
    + 'list in the style you pick, in the preview and in the PDF.'
  )

  // Open the References panel.
  if (editor.isMobile) {
    await flow.click('Open the Editor tab', editor.page.mobileTabs.editor, {
      chain: true,
      after: () => page.locator('[data-testid="ecp-references"]').waitFor({ state: 'visible' })
    })
    await flow.click('Tap "References"', page.locator('[data-testid="ecp-references"]'), {
      result: 'The References panel opens: the citation style, ways to add sources and the list of entries.',
      after: () => page.locator('[data-testid="references-panel"]').waitFor({ state: 'visible' })
    })
  } else {
    await flow.click('Open the References panel', editor.page.sidebar.references, {
      annotations: [{ label: 'references', selector: '[data-testid="sidebar-tab-references"]', kind: 'arrow' }],
      result: 'The References panel opens: the citation style, ways to add sources and the list of entries.',
      after: () => page.locator('[data-testid="references-panel"]').waitFor({ state: 'visible' })
    })
  }

  // Paste the BibTeX entry.
  await flow.click('Click "Paste BibTeX"', page.locator('[data-testid="references-add-paste"]'), {
    chain: true,
    after: () => page.locator('[data-testid="references-paste-input"] textarea, textarea[data-testid="references-paste-input"]').first().waitFor({ state: 'visible' })
  })
  const pasteBox = page.locator('[data-testid="references-paste-input"] textarea, textarea[data-testid="references-paste-input"]').first()
  await flow.type('Paste the entry you copied from your reference manager', pasteBox, BIBTEX, {
    result: 'The BibTeX entry is in the box: key, authors, title, journal, year.'
  })
  await flow.click('Click "Add"', page.locator('[data-testid="references-paste-submit"]'), {
    result: 'The source is in the bibliography under its key, @lovelace1843, with a preview of how it will be printed.',
    after: () => expect(page.locator('[data-testid="references-list"] li[data-key="lovelace1843"]')).toBeVisible()
  })
  await expect(page.locator('[data-testid="references-list"] li[data-key="lovelace1843"]')).toContainText('Notes by the Translator')

  // Cite it at the end of the paragraph.
  const content = page.locator('.cm-content')
  await content.focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  // Drop the full stop: the citation goes before it.
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(' ')
  await flow.click('Click the quote mark next to the entry to cite it where the cursor is', page.locator('[data-testid="references-list"] li[data-key="lovelace1843"] [data-testid="references-cite"]'), {
    result: 'The citation [@lovelace1843] is in the text.',
    after: () => expect(content).toContainText('[@lovelace1843]')
  })
  await page.keyboard.insertText('.')

  // The preview: citation and reference list (desktop; mobile edits only).
  if (!editor.isMobile) {
    await flow.click('Close the panel to see the preview', page.locator('[data-testid="references-panel"] [data-testid="panel-close"]'), {
      chain: true,
      after: () => page.locator('[data-testid="references-panel"]').waitFor({ state: 'detached' })
    })
    await editor.page.waitForPreviewPaginated()
    const preview = page.frameLocator('iframe').first()
    await expect(preview.locator('.csl-entry').first()).toContainText('Lovelace, A. (1843). Notes by the Translator.', { timeout: 20_000 })
    await expect(preview.locator('.markoto-cite').first()).toContainText('(Lovelace, 1843)')
    await flow.shot('The preview reads "(Lovelace, 1843)" and lists the source under References, formatted in APA style.', { hero: true })
  }

  // The PDF carries the same reference list.
  await flow.heading('Download the PDF', 3)
  const pdfUrl = `${new URL(page.url()).origin}/api/docs/${editor.page.currentDocId()}/pdf?inline=1`
  let pdf = Buffer.alloc(0)
  const reader = await flow.spawn('pdf')
  // The server renders what has been saved; the last edit takes a moment to arrive.
  await expect.poll(async () => {
    const res = await page.request.get(pdfUrl)
    if (!res.ok()) return ''
    pdf = Buffer.from(await res.body())
    return pdfText(reader.page, pdf)
  }, { timeout: 60_000, intervals: [2000, 3000, 5000] }).toContain('Notes by the Translator')
  const text = await pdfText(reader.page, pdf)
  expect(text).toContain('(Lovelace, 1843)')
  expect(text).toContain('References')
  await showPdf(reader.page, pdfUrl, pdf, 1)
  await reader.flow.shot('The PDF has the citation in the text and the formatted entry under References.')

  flow.next({
    slug: 'polished-pdf',
    why: 'Give the paper its final look and download it'
  })
})
