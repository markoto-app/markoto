import { readFile } from 'node:fs/promises'
import { test, expect } from '../fixtures/flow'
import { showTextFile } from '../fixtures/downloadViewer'
import { splitMarkotoFrontmatter } from '../../../shared/utils/markdown/markdownFrontmatter'

// Tier 1: "Save the doc as a .md file."
//
// User-job: a writer wants the markdown source on their disk, to
// commit to a git repo, paste into another tool, archive, or share
// the source verbatim with a collaborator who doesn't use markoto.
// Job done when File → Save as Markdown triggers a `.md` download
// containing the doc body.
//
// Lighter sibling of polished-pdf. The PDF goes through the
// renderer sidecar; the markdown is a one-line client-side
// `URL.createObjectURL(new Blob(...))` of the editor's source.
// No server round-trip, no S3, no auth, works on anonymous docs
// too.
//
// Runs on desktop AND mobile. Same client-side download path; entry
// point differs:
//   - Desktop: File → Export → "Markdown (.md)" submenu pick.
//   - Mobile: hamburger ("more") → "Export" (the mobile menu flattens
//     Export's submenu down to its markdown action, Print + Save as
//     PDF live as separate items in the same hamburger).
const NOTES = [
  '# Weekly sync',
  '',
  '**Date:** 3 November  ',
  '**Attendees:** Maya, Sam, Priya',
  '',
  '## Decisions',
  '',
  '- Ship the new export on Thursday',
  '- Move the retro to Friday afternoon',
  '',
  '## Action items',
  '',
  '- [ ] Sam: write the release notes',
  '- [ ] Priya: update the [support FAQ](https://example.com/faq)'
].join('\n')

test('Save as Markdown', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.silentSetup({ title: 'Weekly sync', body: NOTES })

  await flow.heading('Save the doc as a .md file', 3)
  await flow.narrate(
    'Sometimes you want the source, not the finished page. File › Export › '
    + 'Markdown saves the document as a .md file straight to your downloads '
    + 'folder. Useful for a git repository, another Markdown editor, or an '
    + 'archive.'
  )

  // Open the menu containing Export
  const openMenuTrigger = editor.isMobile
    ? page.getByRole('button', { name: /^menu$/i }).first()
    : page.locator('nav[aria-label="Menu bar"] > button').first()

  await flow.click(
    editor.isMobile ? 'Open the topbar menu' : 'Click the File menu',
    openMenuTrigger,
    {
      result: editor.isMobile
        ? 'The topbar menu opens, Export sits in the file actions.'
        : 'The File menu opens, Export sits between Import and Print.',
      after: () => page.getByRole('menuitem', { name: /^export$/i }).first().waitFor({ state: 'visible' })
    }
  )

  // Desktop opens a format submenu (Markdown / PDF); mobile collapses
  // Export to mean "markdown" directly, so the click below triggers
  // the download.
  let triggerLocator: import('@playwright/test').Locator
  let triggerCaption: string
  if (editor.isMobile) {
    triggerLocator = page.getByRole('menuitem', { name: /^export$/i }).first()
    triggerCaption = 'Tap "Export" to download the .md'
  } else {
    await flow.hover(
      'Hover "Export" for the format submenu',
      page.getByRole('menuitem', { name: /^export$/i }).first()
    )
    triggerLocator = page.getByRole('menuitem', { name: /markdown \(\.md\)/i }).first()
    await triggerLocator.waitFor({ state: 'visible' })
    triggerCaption = 'Click "Markdown (.md)" to download'
  }

  // Trigger the download
  // The export-markdown handler creates an object URL and triggers
  // an `<a download="...">` click. Playwright's download event
  // captures it. Pre-register BEFORE the click that triggers it.
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 })

  await flow.click(
    triggerCaption,
    triggerLocator,
    {
      result: 'Your browser saves the file, named after the document.',
      after: async () => {
        await downloadPromise
      }
    }
  )

  // ASSERTION: the download is a .md named after the doc, and its
  // contents are the document's Markdown under a markoto frontmatter
  // block (theme + document properties, so an import restores them).
  const download = await downloadPromise
  const filename = download.suggestedFilename()
  expect(filename).toMatch(/^Weekly sync.*\.md$/i)
  const saved = await readFile(await download.path(), 'utf8')
  const split = splitMarkotoFrontmatter(saved)
  expect(split.kind).toBe('markoto')
  if (split.kind !== 'markoto') throw new Error('no markoto frontmatter in the download')
  expect(split.body).toBe(await editor.page.docText())
  expect(split.data.title).toBe('Weekly sync')
  expect(split.data.theme).toBeTruthy()

  // Open the file
  await flow.heading('Open the file', 3)
  const viewer = await flow.spawn('file')
  await showTextFile(viewer.page, saved)
  await viewer.flow.shot(
    'The saved file is plain Markdown: headings, lists and links as you wrote them. '
    + 'A short block at the top keeps the theme and the document settings for a later import.',
    { hero: true, addressBar: `Downloads/${filename}` }
  )

  flow.next({
    slug: 'polished-pdf',
    why: 'Or download a styled PDF instead, same File menu, different format'
  })
})
