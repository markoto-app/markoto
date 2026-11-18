import { readFile } from 'node:fs/promises'
import { test, expect } from '../fixtures/flow'
import { showTextFile } from '../fixtures/downloadViewer'
import { ExplorerPage, apiCreateDoc, apiCreateFolder, apiCreateWorkspace, apiListDocs, dbAddMember } from '../fixtures/explorer'

// "When someone else moves or deletes your document": two people in one
// workspace. Maya writes in a document; Sam, a workspace admin, files it
// into another folder (Maya keeps writing, nothing interrupts her), then
// deletes that folder. Maya sees that the document was deleted and saves
// her text as Markdown before she closes it. Desktop only: the story is
// two people at their desks.
test('Explorer two people', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'two people at their desks')
  test.setTimeout(180_000)

  // ---------- set-up: a workspace, two folders, Maya's document, Sam as admin ----------
  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const workspaceId = await apiCreateWorkspace(page, 'Platform team')
  const ws = { workspaceId }
  const draftsId = await apiCreateFolder(page, 'Drafts', ws)
  const archiveId = await apiCreateFolder(page, 'Archive', ws)
  const docId = await apiCreateDoc(page, {
    ...ws,
    folderId: draftsId,
    title: 'API design notes',
    content: '# API design notes\n\nVersioned URLs, cursor pagination.\n'
  })

  const sam = await flow.spawn('Sam')
  const samUser = await sam.editor.loginAsTestUser('Sam Reeves')
  await dbAddMember(workspaceId, samUser.userId, 'admin')
  const samExplorer = new ExplorerPage(sam.page)

  await page.goto(`/d/${docId}`)
  await editor.page.waitForReady()
  await editor.page.switchToSplitView()

  await flow.heading('When someone else moves or deletes your document', 3)
  await flow.narrate(
    'Maya is writing in "API design notes", in the Drafts folder of her team\'s workspace. '
    + 'At the same time Sam tidies up the workspace.'
  )
  await flow.shot('Maya is writing.')

  // ---------- Sam moves the document ----------
  await sam.page.goto(`/w/${workspaceId}/f/${draftsId}`)
  await samExplorer.waitForList()
  await expect(samExplorer.row('API design notes')).toBeVisible()
  await sam.flow.hover('Sam right-clicks "API design notes"', samExplorer.row('API design notes'))
  await samExplorer.row('API design notes').click({ button: 'right' })
  await sam.flow.click('and picks "Move to..."', sam.page.getByRole('menuitem', { name: /^move to/i }), {
    chain: true,
    after: () => sam.page.getByTestId('explorer-move-dialog').waitFor({ state: 'visible' })
  })
  await sam.flow.click('Sam picks "Archive"', sam.page.getByTestId('explorer-move-dialog').getByText('Archive', { exact: true }), {
    chain: true,
    after: () => expect(sam.page.getByTestId('explorer-move-confirm')).toBeEnabled()
  })
  await sam.flow.click('and clicks "Move here"', sam.page.getByTestId('explorer-move-confirm'), {
    result: 'The document is in Archive now.',
    after: () => expect(samExplorer.row('API design notes')).toHaveCount(0)
  })
  await expect.poll(async () => (await apiListDocs(sam.page, archiveId, ws)).map(d => d.docId)).toEqual([docId])

  // ---------- Maya keeps writing ----------
  const added = 'Errors follow the problem details format.'
  await flow.step('Maya keeps typing: the move doesn\'t interrupt her', async () => {
    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type(added)
    await expect.poll(() => editor.page.docText()).toContain(added)
    await expect(editor.page.nonConnectedBadge).toHaveCount(0)
    await expect(page.getByTestId('doc-deleted-notice')).toHaveCount(0)
  }, { highlights: [{ label: 'Still editing', selector: `.cm-line:has-text("${added}")` }] })

  // The text reached the server: Sam can find it by the new words.
  await expect.poll(async () => {
    const res = await sam.page.request.get('/api/search/documents', { params: { q: 'problem details' } })
    return res.ok() ? (await res.json() as { results: Array<{ docId: string }> }).results.map(r => r.docId) : []
  }, { timeout: 20_000 }).toContain(docId)

  // ---------- Sam deletes the folder ----------
  await sam.page.goto(`/w/${workspaceId}`)
  await samExplorer.waitForList()
  await sam.flow.hover('Sam right-clicks the Archive folder', samExplorer.row('Archive'))
  await samExplorer.row('Archive').click({ button: 'right' })
  await sam.flow.click('and picks "Delete"', sam.page.getByRole('menuitem', { name: /^delete/i }), {
    result: 'Sam is told the folder holds one document.',
    after: () => expect(sam.page.getByTestId('explorer-delete-counts')).toContainText(/1 folders? and 1 documents?/)
  })
  await sam.flow.click('Sam confirms', sam.page.getByTestId('explorer-delete-confirm'), {
    result: 'Archive and the document in it are deleted.',
    after: () => expect(samExplorer.row('Archive')).toHaveCount(0)
  })

  // ---------- Maya sees the notice and keeps a copy ----------
  await expect(page.getByTestId('doc-deleted-notice')).toBeVisible({ timeout: 20_000 })
  await flow.shot('Maya is told the document was deleted. Her text is still on screen.', {
    hero: true,
    highlights: [{ label: 'Document deleted', selector: '[role="dialog"]' }]
  })
  expect(await editor.page.docText()).toContain(added)

  const download = page.waitForEvent('download')
  await flow.click('Maya clicks "Download Markdown"', page.getByTestId('doc-deleted-download'), {
    chain: true
  })
  const file = await download
  const saved = await readFile(await file.path(), 'utf8')
  expect(saved).toContain('API design notes')
  expect(saved).toContain(added)

  const viewer = await flow.spawn('file')
  await showTextFile(viewer.page, saved)
  await viewer.flow.shot('Her copy has everything she wrote, including the last sentence.', {
    addressBar: `Downloads/${file.suggestedFilename()}`
  })

  flow.next({ slug: 'organize-a-workspace', why: 'Folders, drag and drop and search in a workspace.' })
})
