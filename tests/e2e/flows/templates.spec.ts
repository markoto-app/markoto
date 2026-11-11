import { test, expect } from '../fixtures/flow'

// Tier 1: "Skip the blank page — start from a template."
//
// User-job: a writer opens markoto staring at an empty editor and
// freezes. Job done when they've seen the templates — each one a
// starting text in a design that suits it, shown as a picture of its
// first page — picked one (Report), and watched markoto open the doc
// with the report's skeleton (headings, hint comments, key-figures
// table) in the report design (cover page, contents).
//
// Highlights an underloved feature: every template body is a real
// markdown file in `shared/templates/content/<id>/<locale>.md`,
// rendered server-side when the doc first opens, and the design comes
// with it — one choice instead of two. The skeleton survives editing,
// the comments hint at what to write where, and the design can be
// changed later in the theme panel.
test('Start from a template', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Opens the homepage and clicks "+ New Document"; the Template row
  // opens the picture grid. A fresh browser's first document starts
  // from the Demo.
  await editor.recordPreamble()
  await flow.click(
    'Open "Template"',
    editor.page.newDocDialog.section('template'),
    {
      result: 'The templates open, each as a picture of its first page. Demo is picked for your first document; after that, new documents start blank.',
      after: async () => {
        await expect(editor.page.newDocDialog.section('template')).toHaveAttribute('aria-expanded', 'true')
      }
    }
  )
  await expect(editor.page.newDocDialog.templateCard('demo')).toHaveAttribute('aria-pressed', 'true')

  await flow.heading('Start from a template instead of a blank page', 3)
  await flow.narrate(
    'A template is a starting text in a design that suits it: a report '
    + 'with a cover page and contents, a paper with a title block and '
    + 'numbered sections, a runbook with numbered steps and framed '
    + 'commands. Demo, picked for your first document, is a short tour '
    + 'of markdown and of markoto itself; Blank is an empty page in your '
    + 'default design. Grey comments in each skeleton say what goes '
    + 'where; the preview and the PDF never show them.'
  )

  // Tour the template cards
  await flow.heading('A picture of every template', 3)
  await flow.narrate(
    'Each card shows the template\'s first page in its design, its name '
    + 'and one line about what is in it. The tabs sort them by who they '
    + 'are for: engineering, academic, business, writing.'
  )

  const tour: Array<[string, string]> = [
    ['demo', 'Demo'],
    ['blank', 'Blank'],
    ['runbook', 'On-call runbook'],
    ['arxiv', 'arXiv preprint'],
    ['proposal', 'Client proposal'],
    ['resume', 'Resume']
  ]
  for (const [id, label] of tour) {
    await flow.hover(`Hover "${label}"`, editor.page.newDocDialog.templateCard(id))
  }

  // Pick one
  await flow.click(
    'Open the "Business" tab',
    page.locator('[data-testid="template-tabs"]').getByRole('tab', { name: 'Business' }),
    {
      result: 'Only the business templates are left: report, business plan, proposal, one-pager, memo, meeting notes.',
      after: async () => {
        await expect(editor.page.newDocDialog.templateCard('runbook')).toHaveCount(0)
        await expect(editor.page.newDocDialog.templateCard('report')).toBeVisible()
      }
    }
  )

  await flow.heading('Pick "Report"', 3)
  await flow.narrate(
    'The Report template brings a cover page, a table of contents, an '
    + 'executive summary, a key-figures table, results, an outlook and an '
    + 'appendix — in the Corporate report design. Pick it and the editor '
    + 'opens with the skeleton in place.'
  )

  await flow.click(
    'Click the "Report" card',
    editor.page.newDocDialog.templateCard('report'),
    {
      result: '"Report" is selected — the card lights up and the Template row names it.',
      after: async () => {
        await expect(editor.page.newDocDialog.templateCard('report')).toHaveAttribute('aria-pressed', 'true')
        await expect(editor.page.newDocDialog.summary('template')).toHaveText('Report')
      }
    }
  )

  // Name the doc so the editor + cover show a real title, not "Untitled".
  await flow.type(
    'Give the report a title',
    editor.page.newDocDialog.titleInput,
    'Q3 2026 report',
    { result: 'The title is set.' }
  )
  await expect(editor.page.newDocDialog.titleInput).toHaveValue('Q3 2026 report')

  await flow.click(
    'Click "Create document"',
    editor.page.newDocDialog.submitCreate,
    {
      hero: true,
      result: 'The editor opens with the report skeleton in place, and the preview '
        + 'shows it in the report design: cover page, contents, numbered pages. '
        + 'The grey notes say what goes where; they never show in the preview or the PDF.',
      highlights: [
        { label: 'Ready-made structure', selector: '.cm-content' }
      ],
      after: async () => {
        // First anonymous document in this browser: accept the terms
        // (the quick-share flow shows this step; here it is just setup).
        await expect(editor.page.anonGate.dialog).toBeVisible()
        await editor.page.acceptAnonGate()
        await page.waitForURL(/\/d\/[^/]+/)
        await editor.page.waitForReady()
        if (!editor.isMobile) {
          await editor.page.switchToSplitView()
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  // ASSERTION: the template body lands in the editor source, with its
  // landmarks (Executive summary, Key figures) and hint comments.
  await expect(editor.page.titleButton).toContainText('Q3 2026 report')
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/Executive summary/i)
  expect(editorText).toMatch(/Key figures/i)
  expect(editorText).toMatch(/<!--/)

  // ASSERTION: the design came with the template (Corporate report's
  // heading font), not the default.
  const docId = /\/d\/([^/?#]+)/.exec(page.url())?.[1]
  const meta = await page.request.get(`/api/docs/${docId}/token`).then(r => r.json()) as { theme?: { headings?: { font?: string } } }
  expect(meta.theme?.headings?.font).toMatch(/source serif/i)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Change the design later — every template\'s look is a theme you can switch'
  })
})
