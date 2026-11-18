import { test, expect } from '../fixtures/flow'
import { ExplorerPage, apiCreateDoc, apiCreateFolder, apiListFolders } from '../fixtures/explorer'

// "Delete a folder": a folder and everything in it (subfolders and their
// documents) goes in one step. The confirmation names how many folders
// and documents that is, so nobody deletes a tree of documents by
// accident. Desktop: right-click; phone: press and hold.
test('Delete a folder', async ({ page, flow, editor }) => {
  test.setTimeout(150_000)
  const explorer = new ExplorerPage(page)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const oldId = await apiCreateFolder(page, 'Old projects')
  const yearId = await apiCreateFolder(page, '2023', { parentId: oldId })
  const docIds = [
    await apiCreateDoc(page, { title: 'Website relaunch', folderId: oldId, content: '# Website relaunch\n\nDone in March.\n' }),
    await apiCreateDoc(page, { title: 'Budget draft', folderId: oldId, content: '# Budget draft\n\nSuperseded.\n' }),
    await apiCreateDoc(page, { title: 'Conference notes', folderId: yearId, content: '# Conference notes\n\nTalks worth rewatching.\n' })
  ]
  await apiCreateDoc(page, { title: 'Current plan', content: '# Current plan\n\nWhat we do now.\n' })

  await page.goto('/')
  await explorer.waitForList()
  await expect(explorer.row('Old projects')).toBeVisible()

  await flow.heading('Delete a folder', 3)
  await flow.narrate(
    '"Old projects" holds two documents and a subfolder with one more. Deleting the folder deletes all of it, '
    + 'so markoto first tells you how much that is.'
  )

  await flow.hover(editor.isMobile ? 'Press and hold "Old projects"' : 'Right-click "Old projects"', explorer.row('Old projects'))
  if (editor.isMobile) {
    await explorer.longPress(explorer.row('Old projects'))
    await expect(page.locator('.mk-sheet-host').getByRole('button', { name: /^delete/i })).toBeVisible()
  } else {
    await explorer.row('Old projects').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /^delete/i })).toBeVisible()
  }
  await flow.shot('Delete is at the bottom of the folder\'s actions.')

  const deleteAction = editor.isMobile
    ? page.locator('.mk-sheet-host').getByRole('button', { name: /^delete/i })
    : page.getByRole('menuitem', { name: /^delete/i })
  await flow.click(editor.isMobile ? 'Tap "Delete"' : 'Click "Delete"', deleteAction, {
    hero: true,
    result: 'The confirmation names what goes: the two folders and the three documents in them.',
    highlights: [{ label: 'What gets deleted', selector: '[data-testid="explorer-delete-counts"]' }],
    after: () => expect(page.getByTestId('explorer-delete-counts')).toHaveText('This deletes 2 folders and 3 documents, including everything inside the folders.')
  })
  await expect(page.getByTestId('explorer-delete-dialog')).toContainText('Delete Old projects?')

  await flow.click('Click "Delete" to confirm', page.getByTestId('explorer-delete-confirm'), {
    result: 'The folder and everything in it are gone. Documents outside it stay.',
    after: async () => {
      await expect(explorer.row('Old projects')).toHaveCount(0)
      await expect(explorer.row('Current plan')).toBeVisible()
    }
  })
  expect(await apiListFolders(page)).toEqual([])
  for (const id of docIds) {
    expect((await page.request.get(`/api/docs/${id}/meta`)).status(), `document ${id}`).toBe(404)
  }

  flow.next({ slug: 'explorer-two-people', why: 'What someone sees when you move or delete a document they have open.' })
})
