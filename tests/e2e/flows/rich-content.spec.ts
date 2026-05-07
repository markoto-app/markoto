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

  // Log in so we can disable the cover page via PUT /api/docs/:id/meta
  // (anon users get 401 from that endpoint). Without disabling the
  // cover, the preview iframe shows page 1 = the cover sheet, and
  // every inserted code block / alert / math / diagram lands on a
  // later page that the iframe doesn't auto-scroll to. Reader of
  // the slideshow needs to see the rendered output to understand
  // the demo.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  // Wipe the seeded welcome content so the inserted rich-content
  // samples are the FIRST thing on page 1 of the preview. Inserting
  // at end-of-doc pushes the new content onto page 2+; the preview
  // iframe doesn't auto-scroll to the cursor, so the reader of the
  // slideshow only ever sees the doc title page in the preview pane
  // even though we're actively inserting code blocks + diagrams. By
  // starting from a blank doc, every insert lands on visible page 1.
  await page.locator('.cm-content').click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${accel}+a`)
  await page.keyboard.press('Delete')
  // After delete, the caret is at line 1, col 0 — every subsequent
  // insertBlock / insertAlert / insertMath / insertDiagram lands at
  // the top of the doc. The Y.js delete + paged.js repaginate
  // settles in <500 ms; brief pause so the preview is in a clean
  // state before the first chapter card.
  await page.waitForTimeout(500)

  // Title + intro.
  await flow.heading('Tables, alerts, math, and diagrams', 3)
  await flow.narrate(
    'Plain markdown gets you headings, lists, and links. markoto '
    + 'extends that with the things people actually need to publish '
    + 'real documents — syntax-highlighted code, KaTeX math, GitHub-'
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

  // Helper: open the Insert surface for a single insert.
  async function openInsertSurface() {
    if (editor.isMobile) {
      await editor.page.mobileTabs.editor.click()
      await page.locator('[data-testid="ecp-insert-code-block"]').first().waitFor({ state: 'visible', timeout: 5_000 })
    } else {
      await insertMenuTrigger.click()
    }
  }

  // After mobile insert: drawer closes itself, but make sure
  // .cm-content has focus before keyboard input lands.
  async function refocusEditor() {
    await cmContentLocator.click()
  }

  // ─── A real code block ──────────────────────────────────────────
  await flow.heading('Insert a code block', 3)
  await flow.narrate(
    'Code blocks pick up syntax highlighting from the language hint. '
    + 'markoto loads highlight.js styles from the same CDN every '
    + 'Markdown editor uses, so a Python fence renders the keywords '
    + 'and strings the way readers expect.'
  )

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
  // is meaningful (not just monospaced text on a grey background).
  // Use the editor locator's pressSequentially so the target is
  // explicit even if some other element steals focus mid-test.
  const cmContent = page.locator('.cm-content')
  await cmContent.press('ArrowUp')
  await cmContent.pressSequentially('python')
  await cmContent.press('ArrowDown')
  await cmContent.pressSequentially('def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        yield a\n        a, b = b, a + b')

  // ─── An alert callout ───────────────────────────────────────────
  await flow.heading('Add an alert callout', 3)
  await flow.narrate(
    'Alerts are GitHub-style callouts — five flavours (Note, Tip, '
    + 'Important, Warning, Caution) each with a coloured stripe and '
    + 'icon in the preview. Useful for marking a callout that should '
    + 'stand out from the surrounding prose.'
  )

  // Move below the code fence so the alert lands cleanly.
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')

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
        result: 'The flavour grid opens — Note / Tip / Important / Warning / Caution.',
        after: () => page.locator('[data-testid="ecp-alert-tip"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Tip"',
      page.locator('[data-testid="ecp-alert-tip"]').first(),
      {
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

  // ─── A math equation ────────────────────────────────────────────
  await flow.heading('Drop in a math equation', 3)
  await flow.narrate(
    'Math is rendered with KaTeX — inline with $...$, block with '
    + '$$...$$. The Insert menu seeds the right delimiters so you '
    + 'don\'t have to remember which goes where.'
  )

  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')

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

  // ─── A Mermaid diagram ──────────────────────────────────────────
  await flow.heading('Render a diagram', 3)
  await flow.narrate(
    'Diagrams use Mermaid — eight diagram kinds (flowchart, sequence, '
    + 'class, ER, Gantt, pie, mind-map, state). The Insert menu seeds '
    + 'a working starter snippet for each so you can edit the labels '
    + 'and see your data render without learning Mermaid\'s syntax.'
  )

  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')

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
        result: 'The diagram-kind grid opens.',
        after: () => page.locator('[data-testid="ecp-diagram-pie"]').first().waitFor({ state: 'visible' })
      }
    )
    await flow.click(
      'Tap "Pie chart"',
      page.locator('[data-testid="ecp-diagram-pie"]').first(),
      {
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
          // Mermaid loads + renders in the preview iframe. Give paged.js
          // a beat to repaginate around the new diagram. (Tried polling
          // for `div.mermaid img` — paged.js's iframe-mount + base64
          // <img> wrapping makes the rendered node hard to detect from
          // outside the iframe; the catch-on-timeout pattern just
          // burned the full polling window. 2 s buffers the debounce
          // and the mermaid CDN load on cold runs.)
          await page.waitForTimeout(2_000)
          await editor.page.waitForPreviewPaginated()
        }
      }
    )
  }

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
