import { test, expect } from '../fixtures/flow'

// Tier 1: "Skip the blank page — start from a template."
//
// User-job: a writer opens markoto staring at an empty editor and
// freezes. Job done when they've seen the nine built-in templates,
// picked one (Meeting notes), and watched markoto seed the doc with
// a real structural skeleton (headings, hint comments, action-items
// table) instead of dumping them at line 1 with a blinking caret.
//
// Highlights an underloved feature: every template body is a real
// markdown file in `shared/templates/content/<id>/<locale>.md`,
// rendered server-side at doc creation. The skeleton survives
// editing, the comments hint at what to write where, and the
// preview is publishable on day one.
test('Start from a template', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Opens the homepage and clicks "+ New Document" — the dialog
  // appears with all nine templates visible. Capture the dialog so
  // the reader sees the template grid before we make a choice.
  await editor.recordPreamble()
  // Demo is the pre-selected template.
  await expect(editor.page.newDocDialog.templateCard('demo')).toHaveAttribute('aria-pressed', 'true')

  await flow.heading('Start from a template instead of a blank page', 3)
  await flow.narrate(
    'Every new doc starts from a template. Demo, picked for you, is a '
    + 'short tour of markdown and of markoto itself; Blank is an empty '
    + 'page; Resume is a one-page sample CV to rewrite; six skeletons '
    + 'cover the common cases (report, business plan, academic paper, '
    + 'recipe, meeting notes, project readme). Each '
    + 'skeleton is a real markdown file with hint comments '
    + 'where you fill in the gaps; the structure survives editing, '
    + 'and the preview is publishable on day one.'
  )

  // ─── Tour the template cards ────────────────────────────────────
  await flow.heading('Nine templates in the new-doc dialog', 3)
  await flow.narrate(
    'Each card shows an icon + name + one-line description. Hover '
    + 'or tap to read the description; the selection lights up so '
    + 'you can see which one you\'re about to commit to.'
  )

  // Hover each template card so the slideshow tours all six. Hovers
  // are silent on flow.hover — they capture an approach shot but
  // no outcome. Use the testid pattern from NewDocumentDialog.vue.
  const templates = ['demo', 'blank', 'business-plan', 'academic-paper', 'recipe', 'meeting-notes', 'project-readme', 'resume', 'report']
  const labels: Record<string, string> = {
    'demo': 'Demo',
    'blank': 'Blank',
    'business-plan': 'Business plan',
    'academic-paper': 'Academic paper',
    'recipe': 'Recipe',
    'meeting-notes': 'Meeting notes',
    'project-readme': 'Project README',
    'resume': 'Resume',
    'report': 'Report'
  }

  // Capture one shot per template card with the cursor on it. We
  // don't need an outcome for each — the next hover IS the after-
  // state of the previous. flow.hover does exactly this.
  for (const id of templates) {
    await flow.hover(
      `Hover "${labels[id]}"`,
      editor.page.newDocDialog.templateCard(id)
    )
  }

  // ─── Pick one ──────────────────────────────────────────────────
  await flow.heading('Pick "Meeting notes"', 3)
  await flow.narrate(
    'The Meeting notes template scaffolds a real working doc — '
    + 'date / attendees / purpose at the top, an Agenda section '
    + 'with hint comments, a Discussion section, an Action items '
    + 'table. Pick it and the editor opens with the skeleton '
    + 'already in place.'
  )

  await flow.click(
    'Click the "Meeting notes" card',
    editor.page.newDocDialog.templateCard('meeting-notes'),
    {
      result: '"Meeting notes" is selected — the card lights up with the brand ring.'
    }
  )

  // Name the doc so the editor + cover show a real title, not "Untitled".
  await flow.type(
    'Give the meeting a title',
    editor.page.newDocDialog.titleInput,
    'Weekly product sync',
    { result: 'The title is set.' }
  )
  await expect(editor.page.newDocDialog.titleInput).toHaveValue('Weekly product sync')

  // Submit with the template applied. submitCreate posts the form
  // (vs submitBlank which would skip the template).
  await flow.click(
    'Click "Create document"',
    editor.page.newDocDialog.submitCreate,
    {
      hero: true,
      result: 'The editor opens with the meeting skeleton in place: Date, Attendees, '
        + 'Purpose, Agenda, Discussion, Action items, Decisions, Notes. The grey '
        + 'notes say what goes where; they never show in the preview or the PDF.',
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

  // ASSERTION: the template body lands in the editor source. We
  // check for the meeting-notes-specific landmarks (Agenda heading,
  // Action items section, hint-comment patterns).
  await expect(editor.page.titleButton).toContainText('Weekly product sync')
  const editorText = await page.locator('.cm-content').textContent()
  expect(editorText).toMatch(/Agenda/i)
  expect(editorText).toMatch(/Action items/i)
  // The templates use HTML comments (`<!-- -->`) for hints — those
  // render as muted ghost text in the editor and stay hidden in
  // the preview / PDF. Verify at least one survives.
  expect(editorText).toMatch(/<!--/)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Now invite a collaborator to fill in a section together'
  })
})
