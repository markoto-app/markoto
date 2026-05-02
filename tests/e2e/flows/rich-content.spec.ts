import { test, expect } from '../fixtures/flow'

// Tier 1: "Markdown is more than headings and lists".
//
// User-job: a writer wants to know "can I put a chart / equation /
// callout in a markoto doc?". Job done when they've seen four
// non-trivial markdown extensions render correctly in the preview.
//
// What this flow ISN'T: a complete reference of every Insert menu
// item. We pick FOUR that show range — code with syntax highlighting,
// a callout, a math equation, a Mermaid diagram — because together
// they answer "yes, this is a real publishing tool, not a notes
// app".
//
// Desktop-only: every action goes through the Insert menubar item,
// hidden on mobile. The mobile commands drawer surfaces a subset
// of these inserts but not the same affordance — that flow would
// be a different shape.
test('Rich content', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Rich-content insert menu is desktop-only — the menubar is hidden on `<sm`.'
  )
  test.setTimeout(120_000)

  await editor.silentSetup()

  // Move the caret to the end of the welcome doc so each insert
  // appends rather than overwriting the seeded body. CodeMirror's
  // Cmd+End jumps to doc end. The .cm-content focus is required
  // for keyboard shortcuts to land on the editor not the page.
  await page.locator('.cm-content').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  // Helper: open Insert menu, hover a submenu trigger if needed,
  // click the leaf item. Each insert function lives behind a
  // submenu (`Code block` is a leaf, `Alert/Math/Diagram` are
  // submenu groups), so the helper signature varies per call.
  const insertMenuTrigger = page.locator('nav[aria-label="Menu bar"] > button').nth(3) // Insert is 4th

  // ─── A real code block ──────────────────────────────────────────
  await flow.heading('Insert a code block', 3)
  await flow.narrate(
    'Code blocks pick up syntax highlighting from the language hint. '
    + "markoto loads highlight.js styles from the same CDN every "
    + "Markdown editor uses, so a Python fence renders the keywords "
    + 'and strings the way readers expect.'
  )

  await flow.click(
    'Open the Insert menu',
    insertMenuTrigger,
    {
      annotations: [
        { label: 'insert menu', selector: 'nav[aria-label="Menu bar"] > button:nth-child(4)', kind: 'arrow' }
      ],
      result: 'The Insert menu opens — code, alerts, math, diagrams, and more.',
      after: () => page.getByRole('menuitem', { name: /code block/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Pick "Code block"',
    page.getByRole('menuitem', { name: /code block/i }).first(),
    {
      result: 'A fenced code block lands at the cursor — type a language hint after the opening backticks.'
    }
  )

  // Type a language hint + a real Python snippet so the highlight
  // is meaningful (not just monospaced text on a grey background).
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('python')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        yield a\n        a, b = b, a + b')

  // ─── An alert callout ───────────────────────────────────────────
  await flow.heading('Add an alert callout', 3)
  await flow.narrate(
    'Alerts are GitHub-style callouts — five flavours (Note, Tip, '
    + 'Important, Warning, Caution) each with a coloured stripe and '
    + 'icon in the preview. Useful for marking a callout that should '
    + "stand out from the surrounding prose."
  )

  // Move below the code fence so the alert lands cleanly.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  await flow.click(
    'Open the Insert menu again',
    insertMenuTrigger,
    {
      result: 'The Insert menu re-opens.',
      after: () => page.getByRole('menuitem', { name: /^alert$/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.hover(
    'Hover "Alert" for the flavour submenu',
    page.getByRole('menuitem', { name: /^alert$/i }).first(),
    {
      annotations: [
        { label: 'alert flavours', selector: '[role="menuitem"]:has-text("Alert")', kind: 'arrow' }
      ]
    }
  )

  await flow.click(
    'Pick "Tip"',
    page.getByRole('menuitem', { name: /^tip$/i }).first(),
    {
      result: 'A Tip alert lands — type the body inside the blockquote.'
    }
  )

  await page.keyboard.type('Try Cmd / Ctrl + P to save this doc as a polished PDF.')

  // ─── A math equation ────────────────────────────────────────────
  await flow.heading('Drop in a math equation', 3)
  await flow.narrate(
    'Math is rendered with KaTeX — inline with $...$, block with '
    + '$$...$$. The Insert menu seeds the right delimiters so you '
    + "don't have to remember which goes where."
  )

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  await flow.click(
    'Open the Insert menu',
    insertMenuTrigger,
    {
      result: 'The Insert menu re-opens.',
      after: () => page.getByRole('menuitem', { name: /^math$/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.hover(
    'Hover "Math" for the inline / block options',
    page.getByRole('menuitem', { name: /^math$/i }).first()
  )

  await flow.click(
    'Pick "Block equation"',
    page.getByRole('menuitem', { name: /block equation/i }).first(),
    {
      result: 'A block equation placeholder lands — type the LaTeX inside the $$ fence.'
    }
  )

  await page.keyboard.type('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')

  // ─── A Mermaid diagram ──────────────────────────────────────────
  await flow.heading('Render a diagram', 3)
  await flow.narrate(
    'Diagrams use Mermaid — eight diagram kinds (flowchart, sequence, '
    + 'class, ER, Gantt, pie, mind-map, state). The Insert menu seeds '
    + 'a working starter snippet for each so you can edit the labels '
    + "and see your data render without learning Mermaid's syntax."
  )

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  await flow.click(
    'Open the Insert menu',
    insertMenuTrigger,
    {
      result: 'The Insert menu re-opens.',
      after: () => page.getByRole('menuitem', { name: /^diagram$/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.hover(
    'Hover "Diagram" for the kind submenu',
    page.getByRole('menuitem', { name: /^diagram$/i }).first()
  )

  await flow.click(
    'Pick "Pie chart"',
    page.getByRole('menuitem', { name: /pie chart/i }).first(),
    {
      result: 'A working pie-chart Mermaid snippet lands — edit the slices to your data.',
      after: async () => {
        // Mermaid loads + renders in the preview iframe. Give paged.js
        // a beat to repaginate around the new diagram.
        await page.waitForTimeout(2_000)
        await editor.page.waitForPreviewPaginated()
      }
    }
  )

  // ─── See it all rendered ────────────────────────────────────────
  await flow.heading('Live preview shows the render', 3)
  await flow.narrate(
    'Every insert shows up in the preview pane the moment you finish '
    + 'typing. The same paged.js engine drives the live preview AND '
    + 'the server-rendered PDF, so what you see really is what '
    + 'you ship.'
  )

  await flow.shot(
    'Code block, Tip alert, math equation, pie chart — all in one doc, all rendered live.',
    {
      // Hero outcome: the four elements stacked in the preview is
      // the "markoto handles real publishing content" payoff.
      hero: true
    }
  )

  // ASSERTIONS: each element survived the round-trip into the
  // editor source. We don't assert on iframe-side render details
  // (KaTeX HTML changes between versions, mermaid SVG is opaque) —
  // we assert the markdown source has the four landmark fences.
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/```python/i)
  expect(editorText).toMatch(/> \[!TIP\]/i)
  expect(editorText).toMatch(/\$\$/)
  expect(editorText).toMatch(/```mermaid[\s\S]*pie/i)

  // Forward route: rich content is the "look at the surface area"
  // moment; comment threads (collaboration on that surface) is
  // the natural next step.
  flow.next({
    slug: 'discuss-with-comments',
    why: 'Now invite a collaborator to leave a comment on what you wrote'
  })
})
