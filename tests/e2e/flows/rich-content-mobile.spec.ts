import { test, expect } from '../fixtures/flow'

// Tier 1 (mobile sibling): "Tables, alerts, math, and diagrams — on
// mobile."
//
// Same payoff as rich-content.spec.ts: code block + alert + math +
// diagram, all rendered live. Different surface: the desktop menubar
// is hidden on mobile, so every insert goes through the Editor
// drawer's Insert grid (tap the Editor tab → tap Code block →
// drawer closes, the snippet lands at the cursor).
//
// Mobile-only: skips on desktop variants.
test('Rich content on mobile', async ({ page, flow, editor }) => {
  test.skip(
    !editor.isMobile,
    'Mobile-only sibling — desktop story is in rich-content.spec.ts.'
  )
  test.setTimeout(120_000)

  // Login + disable cover so the inserted content is visible in the
  // preview iframe (see desktop sibling for the full reasoning).
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  // Clear the welcome content so the inserts land on page 1 of the
  // mobile preview surface (when the user toggles preview later).
  await page.locator('.cm-content').click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.locator('.cm-content').press(`${accel}+a`)
  await page.locator('.cm-content').press('Delete')
  await page.waitForTimeout(500)

  await flow.heading('Tables, alerts, math, and diagrams on mobile', 3)
  await flow.narrate(
    'Plain markdown gets you headings, lists, and links. markoto '
    + 'extends that with the things people actually need to publish '
    + 'real documents — syntax-highlighted code, KaTeX math, GitHub-'
    + 'style alert callouts, and eight kinds of Mermaid diagram. On '
    + 'mobile, every insert lives in the Editor drawer\'s Insert '
    + 'section; the inserted markdown lands at the cursor and renders '
    + 'in the preview just like desktop.'
  )

  const cmContent = page.locator('.cm-content')

  // ─── A code block ──────────────────────────────────────────────
  await flow.heading('Insert a code block', 3)
  await flow.narrate(
    'Tap the Editor tab → Code block in the Insert grid. The drawer '
    + 'closes; the fenced code block lands at the cursor. Type a '
    + 'language hint after the opening backticks for syntax '
    + 'highlighting in the preview.'
  )

  await flow.click(
    'Tap the Editor tab',
    editor.page.mobileTabs.editor,
    {
      result: 'The Editor drawer slides up — Formatting / Headings / Lists / Insert / File.',
      after: () => page.locator('[data-testid="ecp-insert-code-block"]').waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Tap Code block',
    page.locator('[data-testid="ecp-insert-code-block"]'),
    {
      result: 'A fenced code block lands at the cursor — drawer closes, editor regains focus.',
      after: () => cmContent.click()
    }
  )

  // Type a language hint + a real Python snippet.
  await cmContent.press('ArrowUp')
  await cmContent.pressSequentially('python')
  await cmContent.press('ArrowDown')
  await cmContent.pressSequentially('def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        yield a\n        a, b = b, a + b')

  // ─── An alert ──────────────────────────────────────────────────
  await flow.heading('Add an alert callout', 3)
  await flow.narrate(
    'Alerts have five flavours (Note, Tip, Important, Warning, '
    + 'Caution). Tap Editor → Alert; the drawer steps to a sub-grid '
    + 'with each flavour. Tap Tip and the alert lands at the cursor.'
  )

  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')

  await flow.click(
    'Tap the Editor tab',
    editor.page.mobileTabs.editor,
    {
      result: 'The Editor drawer slides up again.',
      after: () => page.locator('[data-testid="ecp-insert-alert"]').waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Tap Alert',
    page.locator('[data-testid="ecp-insert-alert"]'),
    {
      result: 'The drawer steps to a 2-column grid of alert flavours.',
      after: () => page.locator('[data-testid="ecp-alert-tip"]').waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Tap Tip',
    page.locator('[data-testid="ecp-alert-tip"]'),
    {
      result: 'A Tip alert lands at the cursor — type the body inside the blockquote.',
      after: () => cmContent.click()
    }
  )

  await cmContent.pressSequentially('Try Cmd / Ctrl + P to save this doc as a polished PDF.')

  // ─── A math equation ───────────────────────────────────────────
  await flow.heading('Drop in a math equation', 3)
  await flow.narrate(
    'Math is rendered with KaTeX. Tap Editor → Math and a block '
    + 'equation placeholder lands at the cursor with the $$ fences '
    + 'pre-seeded.'
  )

  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')

  await flow.click(
    'Tap the Editor tab',
    editor.page.mobileTabs.editor,
    {
      result: 'The Editor drawer slides up.',
      after: () => page.locator('[data-testid="ecp-insert-math"]').waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Tap Math',
    page.locator('[data-testid="ecp-insert-math"]'),
    {
      result: 'A block-equation placeholder lands at the cursor.',
      after: () => cmContent.click()
    }
  )

  await cmContent.pressSequentially('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')

  // ─── A Mermaid diagram ─────────────────────────────────────────
  await flow.heading('Render a diagram', 3)
  await flow.narrate(
    'Diagrams use Mermaid — six kinds available in the mobile drawer '
    + '(flowchart, sequence, class, ER, Gantt, pie). Tap Editor → '
    + 'Diagram → pie and a working starter snippet lands at the cursor.'
  )

  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')

  await flow.click(
    'Tap the Editor tab',
    editor.page.mobileTabs.editor,
    {
      result: 'The Editor drawer slides up.',
      after: () => page.locator('[data-testid="ecp-insert-diagram"]').waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Tap Diagram',
    page.locator('[data-testid="ecp-insert-diagram"]'),
    {
      result: 'The drawer steps to a 2-column grid of diagram kinds.',
      after: () => page.locator('[data-testid="ecp-diagram-pie"]').waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Tap pie',
    page.locator('[data-testid="ecp-diagram-pie"]'),
    {
      hero: true,
      result: 'A working pie-chart Mermaid snippet lands at the cursor — edit the slices to your data.',
      after: () => cmContent.click()
    }
  )

  // ASSERTIONS: the markdown source has the four landmark fences.
  const editorText = await cmContent.textContent()
  expect(editorText).toMatch(/```python/i)
  expect(editorText).toMatch(/> \[!TIP\]/i)
  expect(editorText).toMatch(/\$\$/)
  expect(editorText).toMatch(/```mermaid[\s\S]*pie/i)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Now invite a collaborator to leave a comment on what you wrote'
  })
})
