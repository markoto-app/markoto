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
// Runs on desktop AND mobile. Same client-side insert helpers
// (`insertBlock`, `insertAlert`, `insertMath`, `insertDiagram`);
// entry point differs:
//   - Desktop: menubar Insert → submenu pick.
//   - Mobile: Editor tab on the bottom-tab-bar → Insert grid in the
//     `EditorCommandsPanel` drawer.
// (Until Phase 6.30 there was a `rich-content-mobile.spec.ts`
//  sibling carrying mobile-specific narration. Deleted as part of the
//  "single canonical spec per feature" cleanup — Flow.vue auto-routes
//  variants by viewport via `useMediaQuery('(max-width: 639px)')`.)
test('Rich content', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // A one-line doc with the cover off, so every inserted block lands on
  // the preview's first page instead of behind the title sheet.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Engineering handbook', body: '# Engineering handbook\n', cover: false })
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'

  // Title + intro.
  await flow.heading('Tables, alerts, math, and diagrams', 3)
  await flow.narrate(
    'Plain markdown gets you headings, lists, and links. markoto '
    + 'extends that with the things people actually need to publish '
    + 'real documents — syntax-highlighted code, math, GitHub-'
    + 'style alert callouts, and eight kinds of Mermaid diagram. '
    + 'Everything renders in the live preview and survives PDF export.'
  )

  // Insert UI shape differs per surface:
  //   Desktop — menubar Insert → submenu (hover for Alert/Math/Diagram).
  //   Mobile — Editor tab on the bottom-tab-bar → drawer Insert grid;
  //            Alert/Diagram open a kind picker inside the drawer;
  //            drawer auto-closes after each insert.
  const insertMenuTrigger = page.locator('nav[aria-label="Menu bar"] > button').nth(3) // Insert is 4th
  const cmContentLocator = page.locator('.cm-content')

  // Give the editor focus back WITHOUT moving the caret. (Clicking
  // .cm-content put the caret wherever the click landed — that is how
  // an earlier run typed the language hint after the closing fence and
  // the LaTeX into the code block.) CM6 restores its selection on focus.
  async function refocusEditor() {
    await cmContentLocator.focus()
    await expect(cmContentLocator).toBeFocused()
  }

  // Every block starts after a blank line below everything so far.
  // insertText (not Enter) so CM6 doesn't continue the previous
  // block's markup — Enter after an alert line would add another "> ".
  async function newLineAtEnd() {
    await refocusEditor()
    await cmContentLocator.press(`${accel}+End`)
    await page.keyboard.insertText('\n\n')
  }

  // ─── A real code block ──────────────────────────────────────────
  await flow.heading('Insert a code block', 3)
  await flow.narrate(
    'Code blocks pick up syntax highlighting from the language hint, '
    + 'so a Python fence renders the keywords and strings the way '
    + 'readers expect — in the preview and in the PDF.'
  )

  await newLineAtEnd()

  if (editor.isMobile) {
    await flow.click(
      'Tap the Editor tab',
      editor.page.mobileTabs.editor,
      {
        result: 'The Editor drawer slides up — Formatting / Headings / Lists / Insert / File.',
        after: () => page.locator('[data-testid="ecp-insert-code-block"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Code block"',
      page.locator('[data-testid="ecp-insert-code-block"]').first(),
      {
        // Mobile: Editor drawer renders inside BottomSheet; pointer
        // routing intercepted. See `tests/e2e/AGENTS.md`.
        force: true,
        result: 'A fenced code block lands at the cursor — drawer closes, editor regains focus.',
        after: refocusEditor
      }
    )
  } else {
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
        result: 'A fenced code block lands at the cursor — type a language hint after the opening backticks.',
        // After the Reka menu closes, focus moves to the menu's trigger
        // button (the menubar's "Insert"), NOT back to the editor.
        // Subsequent `page.keyboard.press/type` would land in the
        // wrong target. Refocus the editor before any keystrokes.
        after: refocusEditor
      }
    )
  }

  // Type a language hint + a real Python snippet so the highlight
  // is meaningful. The caret sits after the block: the menubar's
  // block is "\n```\n\n```\n" (caret on the empty line below it),
  // the mobile drawer's "```\n\n```" (caret after the closing fence).
  // Walk up to the opening fence, add the language, step into the
  // empty body line.
  const cmContent = cmContentLocator
  const upToOpeningFence = editor.isMobile ? 2 : 3
  for (let i = 0; i < upToOpeningFence; i++) await cmContent.press('ArrowUp')
  await cmContent.press('End')
  await cmContent.pressSequentially('python')
  await cmContent.press('ArrowDown')
  await cmContent.press('End')
  // insertText = what a paste does: the snippet's own indentation,
  // without CM6's auto-indent stacking on every typed newline.
  await page.keyboard.insertText('def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        yield a\n        a, b = b, a + b')
  await expect.poll(() => editor.page.docText()).toContain('```python\ndef fibonacci(n):\n    a, b = 0, 1\n')

  // ─── An alert callout ───────────────────────────────────────────
  await flow.heading('Add an alert callout', 3)
  await flow.narrate(
    'Alerts are GitHub-style callouts — five flavours (Note, Tip, '
    + 'Important, Warning, Caution) each with a coloured stripe and '
    + 'icon in the preview. Useful for marking a callout that should '
    + 'stand out from the surrounding prose.'
  )

  // Fresh line below the code fence so the alert lands cleanly.
  await newLineAtEnd()

  if (editor.isMobile) {
    await flow.click(
      'Tap the Editor tab',
      editor.page.mobileTabs.editor,
      {
        result: 'The Editor drawer slides back up.',
        after: () => page.locator('[data-testid="ecp-insert-alert"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Alert"',
      page.locator('[data-testid="ecp-insert-alert"]').first(),
      {
        force: true,
        result: 'The flavour grid opens — Note / Tip / Important / Warning / Caution.',
        after: () => page.locator('[data-testid="ecp-alert-tip"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Tip"',
      page.locator('[data-testid="ecp-alert-tip"]').first(),
      {
        force: true,
        result: 'A Tip alert lands — drawer closes, editor regains focus.',
        after: refocusEditor
      }
    )
  } else {
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
        result: 'A Tip alert lands — type the body inside the blockquote.',
        after: refocusEditor
      }
    )
  }

  await cmContent.pressSequentially('Try Cmd / Ctrl + P to save this doc as a polished PDF.')
  await expect.poll(() => editor.page.docText()).toMatch(/^> \[!TIP\]\n> Try Cmd \/ Ctrl \+ P/m)

  // ─── A math equation ────────────────────────────────────────────
  await flow.heading('Drop in a math equation', 3)
  await flow.narrate(
    'Math is typeset like in a paper — inline with $...$, block with '
    + '$$...$$. The Insert menu seeds the right delimiters so you '
    + 'don\'t have to remember which goes where.'
  )

  await newLineAtEnd()

  if (editor.isMobile) {
    await flow.click(
      'Tap the Editor tab',
      editor.page.mobileTabs.editor,
      {
        result: 'The Editor drawer slides back up.',
        after: () => page.locator('[data-testid="ecp-insert-math"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Math"',
      page.locator('[data-testid="ecp-insert-math"]').first(),
      {
        force: true,
        result: 'A block equation placeholder lands — drawer closes, editor regains focus.',
        after: refocusEditor
      }
    )
  } else {
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
        result: 'A block equation placeholder lands — type the LaTeX inside the $$ fence.',
        after: refocusEditor
      }
    )
  }

  await cmContent.pressSequentially('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')
  await expect.poll(() => editor.page.docText()).toContain('$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$')

  // ─── A Mermaid diagram ──────────────────────────────────────────
  await flow.heading('Render a diagram', 3)
  await flow.narrate(
    'Diagrams use Mermaid — eight diagram kinds (flowchart, sequence, '
    + 'class, ER, Gantt, pie, mind-map, state). The Insert menu seeds '
    + 'a working starter snippet for each so you can edit the labels '
    + 'and see your data render without learning Mermaid\'s syntax.'
  )

  await newLineAtEnd()

  if (editor.isMobile) {
    await flow.click(
      'Tap the Editor tab',
      editor.page.mobileTabs.editor,
      {
        result: 'The Editor drawer slides back up.',
        after: () => page.locator('[data-testid="ecp-insert-diagram"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Diagram"',
      page.locator('[data-testid="ecp-insert-diagram"]').first(),
      {
        force: true,
        result: 'The diagram-kind grid opens.',
        after: () => page.locator('[data-testid="ecp-diagram-pie"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Pie chart"',
      page.locator('[data-testid="ecp-diagram-pie"]').first(),
      {
        force: true,
        result: 'A working pie-chart Mermaid snippet lands — drawer closes, editor regains focus.',
        after: refocusEditor
      }
    )
    // Mobile is edit-only; no preview iframe to repaginate.
  } else {
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
          // Mermaid loads from its CDN and renders into the preview as
          // an <img> of the SVG; wait for that, not for a fixed time.
          await expect(editor.page.previewRoot().locator('#mount div.mermaid img').first()).toBeAttached({ timeout: 30_000 })
          await editor.page.waitForPreviewPaginated()
        }
      }
    )
  }

  // ─── See it all rendered ────────────────────────────────────────
  await flow.heading('Live preview shows the render', 3)
  await flow.narrate(
    'Every insert shows up in the preview pane the moment you finish '
    + 'typing. The preview and the PDF come out of the same page '
    + 'layout, so what you see really is what you ship.'
  )

  // ASSERTIONS: the source holds four well-formed blocks, each on its
  // own lines (an earlier run produced "python```" and LaTeX inside
  // the code fence and still passed)...
  const source = await editor.page.docText()
  expect(source).toMatch(/^```python\ndef fibonacci\(n\):\n {4}a, b = 0, 1\n {4}for _ in range\(n\):\n {8}yield a\n {8}a, b = b, a \+ b\n```$/m)
  expect(source).toMatch(/^> \[!TIP\]\n> Try Cmd \/ Ctrl \+ P to save this doc as a polished PDF\.$/m)
  expect(source).toMatch(/^\$\$\n\\sum_\{i=1\}\^\{n\} i = \\frac\{n\(n\+1\)\}\{2\}\n\$\$$/m)
  expect(source).toMatch(/^```mermaid\npie\b[\s\S]*?\n```$/m)

  // ...and the preview renders each of them: highlighted code, the
  // alert callout, typeset math and the diagram image.
  if (!editor.isMobile) {
    const preview = editor.page.previewRoot().locator('#mount')
    await expect(preview.locator('pre code.hljs.language-python')).toHaveCount(1)
    await expect(preview.locator('.markdown-alert')).toHaveCount(1)
    await expect(preview.locator('.katex').first()).toBeAttached()
    await expect(preview.locator('div.mermaid img').first()).toBeAttached()
    await expect(preview.locator('.mermaid-error')).toHaveCount(0)
  }

  await flow.shot(
    'Code block, Tip alert, math equation, pie chart — all in one doc, all rendered live.',
    {
      // Hero outcome: the four elements stacked in the preview is
      // the "markoto handles real publishing content" payoff.
      hero: true
    }
  )

  // Forward route: rich content is the "look at the surface area"
  // moment; comment threads (collaboration on that surface) is
  // the natural next step.
  flow.next({
    slug: 'discuss-with-comments',
    why: 'Now invite a collaborator to leave a comment on what you wrote'
  })
})
