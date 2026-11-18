import { test, expect } from '../fixtures/flow'
import { ExplorerPage, apiCreateDoc, apiCreateFolder, apiListDocs, apiListFolders } from '../fixtures/explorer'

// "Organize documents with the keyboard": everything in the explorer
// without a mouse. Tab into the list, Ctrl+Shift+N for a folder, type to
// jump to a name, F2 to rename, Ctrl+X / Ctrl+V to move, Backspace to go
// up, Delete with a confirmation. Desktop only: a phone has no keyboard
// shortcuts. No automated accessibility scan here: the suite has no axe
// integration (the explorer's ARIA grid is covered by its own tests).
test('Explorer keyboard only', async ({ page, flow, editor }) => {
  test.skip(editor.isMobile, 'keyboard shortcuts need a keyboard')
  test.setTimeout(150_000)
  const explorer = new ExplorerPage(page)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const archiveId = await apiCreateFolder(page, 'Archive')
  await apiCreateDoc(page, { title: '2024 retrospective', folderId: archiveId, content: '# 2024 retrospective\n\nWhat we learned.\n' })
  const draftId = await apiCreateDoc(page, { title: 'Old draft', content: '# Old draft\n\nAn early version.\n' })
  const scratchId = await apiCreateDoc(page, { title: 'Scratch notes', content: '# Scratch notes\n\nPhone numbers, a shopping list.\n' })
  await apiCreateDoc(page, { title: 'Roadmap', content: '# Roadmap\n\nWhat ships next.\n' })

  await page.goto('/')
  await explorer.waitForList()
  await expect(explorer.rows).toHaveCount(4)

  await flow.heading('Organize documents with the keyboard', 3)
  await flow.narrate(
    'The list works like a file manager: arrow keys move, Enter opens, and the shortcuts below do the rest. '
    + 'On a Mac, use Cmd where this says Ctrl.'
  )

  await flow.step('Press Tab until the list has the focus', async () => {
    await explorer.tabIntoList()
    expect(await explorer.focusedKey()).toBe(`f:${archiveId}`)
  }, { highlights: [{ label: 'Focus', selector: '[data-testid="explorer-list"] tbody tr[data-key]:focus' }] })

  // ---------- new folder ----------
  await flow.step('Press Ctrl+Shift+N for a new folder', async () => {
    await page.keyboard.press('ControlOrMeta+Shift+N')
    await expect(explorer.renameInput).toBeFocused()
    await expect(explorer.renameInput).toHaveValue('New folder')
  })
  await flow.step('Type "Drafts" and press Enter', async () => {
    await page.keyboard.type('Drafts')
    await page.keyboard.press('Enter')
    await expect(explorer.row('Drafts')).toBeVisible()
    await expect.poll(() => explorer.focusedKey()).toMatch(/^f:/)
  })
  await expect.poll(async () => (await apiListFolders(page)).map(f => f.name).sort()).toEqual(['Archive', 'Drafts'])

  // ---------- rename ----------
  await flow.step('Type "old" to jump to "Old draft"', async () => {
    await page.keyboard.type('old')
    await expect.poll(() => explorer.focusedKey()).toBe(`d:${draftId}`)
  })
  await flow.step('Press F2 to rename it', async () => {
    await page.keyboard.press('F2')
    await expect(explorer.renameInput).toBeFocused()
  })
  await flow.step('Type "Old draft 2025" and press Enter', async () => {
    await page.keyboard.type('Old draft 2025')
    await page.keyboard.press('Enter')
    await expect(explorer.row('Old draft 2025')).toBeVisible()
  })
  await expect.poll(async () => (await apiListDocs(page, 'root')).find(d => d.docId === draftId)?.title).toBe('Old draft 2025')

  // ---------- cut and paste ----------
  await flow.heading('Move with cut and paste', 3)
  await expect.poll(() => explorer.focusedKey()).toBe(`d:${draftId}`)
  await flow.step('Press Ctrl+X to cut it', async () => {
    await page.keyboard.press('ControlOrMeta+X')
    await expect(page.getByRole('status').filter({ hasText: /cut/i })).toHaveCount(1)
  })
  await flow.step('Type "arc" to jump to "Archive" and press Enter to open it', async () => {
    await page.keyboard.type('arc')
    await expect.poll(() => explorer.focusedKey()).toBe(`f:${archiveId}`)
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`/f/${archiveId}`))
    await expect(explorer.row('2024 retrospective')).toBeVisible()
  })
  await flow.step('Press Tab until the list has the focus again', async () => {
    await explorer.tabIntoList()
  })
  await flow.step('Press Ctrl+V to paste', async () => {
    await page.keyboard.press('ControlOrMeta+V')
    await expect(explorer.row('Old draft 2025')).toBeVisible()
  }, { hero: true, highlights: [{ label: 'Moved here', selector: `[data-testid="explorer-list"] tbody tr[data-key="d:${draftId}"]` }] })
  await expect.poll(async () => (await apiListDocs(page, archiveId)).map(d => d.title).sort()).toEqual(['2024 retrospective', 'Old draft 2025'])
  await editor.page.dismissToasts()

  // ---------- up and delete ----------
  await flow.heading('Go up and delete', 3)
  await explorer.tabIntoList()
  await flow.step('Press Backspace to go up one level', async () => {
    await page.keyboard.press('Backspace')
    await page.waitForURL(url => new URL(url).pathname === '/')
    await expect(explorer.row('Scratch notes')).toBeVisible()
  })
  await flow.step('Press Tab until the list has the focus, then type "scr"', async () => {
    await explorer.tabIntoList()
    await page.keyboard.type('scr')
    await expect.poll(() => explorer.focusedKey()).toBe(`d:${scratchId}`)
  })
  await flow.step('Press Delete', async () => {
    await page.keyboard.press('Delete')
    await expect(page.getByTestId('explorer-delete-dialog')).toBeVisible()
    await expect(page.getByTestId('explorer-delete-dialog')).toContainText('Scratch notes')
  })
  await flow.step('Press Tab until "Delete" has the focus, then Enter', async () => {
    const confirm = page.getByTestId('explorer-delete-confirm')
    await expect(confirm).toBeEnabled()
    for (let i = 0; i < 10 && !(await confirm.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(explorer.row('Scratch notes')).toHaveCount(0)
  })
  expect((await page.request.get(`/api/docs/${scratchId}/meta`)).status()).toBe(404)

  flow.next({ slug: 'delete-a-folder', why: 'Deleting a folder deletes everything inside it; markoto tells you how much first.' })
})
