import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/flow'
import { ExplorerPage, apiListDocs, apiListFolders } from '../fixtures/explorer'

// "Import a folder of Markdown files": someone moves their notes over
// from another tool. A folder with two Markdown files, one linking the
// other and an image next to it, goes in with one import: the folder
// structure is kept, the image comes along and the link points at the
// imported document. Desktop only: a phone can't pick a folder.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FOLDER = path.resolve(HERE, '../fixtures/import-folder/team-handbook')

test('Import a folder of Markdown', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'a phone has no folder picker')
  test.setTimeout(180_000)
  const explorer = new ExplorerPage(page)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  await explorer.waitForList()

  await flow.heading('Import a folder of Markdown files', 3)
  await flow.narrate(
    'Bring a whole folder in at once: Markdown, Word, PDF and the other formats markoto reads, '
    + 'with its subfolders. Images that the Markdown files show come along, and links between the files keep working.'
  )

  await flow.click('Click "New"', explorer.newButton, {
    result: 'New document, New folder or Import.',
    after: () => explorer.menuItem(/^import files/i).waitFor({ state: 'visible' })
  })
  await flow.click('Pick "Import files..."', explorer.menuItem(/^import files/i), {
    result: 'Choose files, a folder or a zip archive, or paste a GitHub link.',
    after: () => page.getByTestId('explorer-import-dialog').waitFor({ state: 'visible' })
  })

  const dialog = page.getByTestId('explorer-import-dialog')
  await flow.hover('Click "Choose a folder" and pick the folder', dialog.getByRole('button', { name: 'Choose a folder' }))
  await page.getByTestId('explorer-import-folder').setInputFiles(FOLDER)
  await expect(page.getByTestId('explorer-import-summary')).toContainText('2 documents, 1 images, 0 zip archives')
  await flow.shot('markoto lists what it will import before anything is uploaded: two documents and one image.', {
    highlights: [{ label: 'What will be imported', selector: '[data-testid="explorer-import-summary"]' }]
  })

  await flow.click('Click "Import"', page.getByTestId('explorer-import-start'), {
    result: 'The files upload and are imported one by one; the progress shows how far it got.',
    after: () => expect(page.getByTestId('explorer-import-progress').or(page.getByTestId('explorer-import-result'))).toBeVisible({ timeout: 30_000 })
  })
  await expect(page.getByTestId('explorer-import-result')).toContainText('Import finished', { timeout: 90_000 })
  await expect(page.getByTestId('explorer-import-progress')).toContainText('2 of 2 documents imported, 0 failed')
  await flow.shot('Done: two documents imported, nothing failed.', {
    highlights: [{ label: 'Result', selector: '[data-testid="explorer-import-result"]' }]
  })

  const folder = (await apiListFolders(page)).find(f => f.name === 'team-handbook')
  expect(folder, 'the imported folder').toBeTruthy()
  const docs = await apiListDocs(page, folder?.folderId ?? 'root')
  const handbook = docs.find(d => d.title === 'Team handbook')
  const onboarding = docs.find(d => d.title === 'Onboarding guide')
  expect(handbook && onboarding, `imported documents: ${docs.map(d => d.title).join(', ')}`).toBeTruthy()

  await flow.click('Close the window', page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last(), {
    result: 'The folder is in your documents, with its name from your computer.',
    highlights: [{ label: 'Imported folder', selector: '[data-testid="explorer-list"] tbody tr[data-kind="folder"]' }],
    after: async () => {
      await expect(dialog).toHaveCount(0)
      await expect(explorer.row('team-handbook')).toBeVisible()
    }
  })

  await flow.hover('Double-click the folder to open it', explorer.row('team-handbook'))
  await explorer.row('team-handbook').dblclick()
  await page.waitForURL(new RegExp(`/f/${folder?.folderId}`))
  await expect(explorer.row('Team handbook')).toBeVisible()
  await expect(explorer.row('Onboarding guide')).toBeVisible()
  await flow.shot('Both files are documents now, titled by their first heading.')

  await flow.hover('Double-click "Team handbook"', explorer.row('Team handbook'))
  await explorer.row('Team handbook').dblclick()
  await page.waitForURL(new RegExp(`/d/${handbook?.docId}`))
  await editor.page.waitForReady()

  // The link to the other file points at its document, the image at the copy uploaded with this one.
  const text = await editor.page.docText()
  expect(text).toContain(`[onboarding guide](/d/${onboarding?.docId})`)
  expect(text).toMatch(new RegExp(`!\\[The team at the summer offsite\\]\\(/api/files/${handbook?.docId}/[^)]+\\)`))

  await editor.page.switchToSplitView()
  await editor.page.waitForPreviewPaginated()
  // The text on the first page instead of the title sheet, so the image is in view.
  await editor.page.disableCoverPage()
  await editor.page.waitForPreviewPaginated()
  const preview = editor.page.previewRoot()
  const image = preview.locator('img[alt="The team at the summer offsite"]').first()
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(preview.locator('a', { hasText: 'onboarding guide' }).first()).toBeAttached()
  await flow.shot('The image shows in the document, and "onboarding guide" links to the other imported document.', {
    hero: true,
    highlights: [{ label: 'Imported image', selector: '.cm-line:has-text("summer offsite")' }]
  })

  flow.next({ slug: 'organize-a-workspace', why: 'Sort what you imported into folders, and find it again by a word in it.' })
})
