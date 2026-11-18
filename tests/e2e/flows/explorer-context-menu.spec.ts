import { test, expect } from '../fixtures/flow'
import { ExplorerPage, apiCreateDoc, apiCreateFolder, apiListFolders } from '../fixtures/explorer'

// "Right-click for every action": the explorer's context menus. A
// document, a folder, a selection of several items and the empty space
// each get the actions that fit them. Desktop: right-click. Phone: a long
// press opens the same actions in a sheet.
test('Explorer context menu', async ({ page, flow, editor }) => {
  test.setTimeout(150_000)
  const explorer = new ExplorerPage(page)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  await apiCreateFolder(page, 'Client work')
  await apiCreateDoc(page, { title: 'Reading list', content: '# Reading list\n\nBooks for the summer.\n' })
  await apiCreateDoc(page, { title: 'Trip notes', content: '# Trip notes\n\nLisbon, three days.\n' })

  await page.goto('/')
  await explorer.waitForList()
  await expect(explorer.rows).toHaveCount(3)

  await flow.heading('Right-click for every action', 3)
  await flow.narrate(editor.isMobile
    ? 'Your documents and folders on the home page. Press and hold one to see what you can do with it.'
    : 'Your documents and folders on the home page. Right-click anything in the list to see what you can do with it.')

  const close = async () => {
    if (editor.isMobile) {
      await page.locator('.mk-sheet-host button[aria-label="Close"]').click()
      await page.locator('.mk-sheet-host').waitFor({ state: 'detached', timeout: 5_000 })
    } else {
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
    }
  }
  /** Open the item's actions: right-click on a desktop, a long press on a phone. */
  const openActions = async (caption: string, target: ReturnType<ExplorerPage['row']>, result: string, expected: RegExp[]) => {
    await flow.hover(caption, target)
    if (editor.isMobile) await explorer.longPress(target)
    else await target.click({ button: 'right' })
    const surface = editor.isMobile ? page.locator('.mk-sheet-host') : page.getByRole('menu')
    for (const name of expected) {
      await expect(editor.isMobile ? surface.getByRole('button', { name }) : surface.getByRole('menuitem', { name })).toBeVisible()
    }
    await flow.shot(result, {
      highlights: [{ label: 'Actions', selector: editor.isMobile ? '.mk-sheet-host' : '[role="menu"]' }]
    })
  }

  // ---------- a document ----------
  await openActions(
    editor.isMobile ? 'Press and hold "Reading list"' : 'Right-click "Reading list"',
    explorer.row('Reading list'),
    'Open, rename, move, cut, duplicate, copy the link, share or delete the document.',
    [/^open(?! in new tab)/i, /^rename/i, /^move to/i, /^duplicate/i, /^copy link/i, /^delete/i]
  )
  await close()

  // ---------- a folder ----------
  await openActions(
    editor.isMobile ? 'Press and hold the folder' : 'Right-click the folder',
    explorer.row('Client work'),
    'A folder can also get a new document or folder inside it, or an import.',
    [/^open(?! in new tab)/i, /^rename/i, /^new document/i, /^new folder/i, /^delete/i]
  )

  if (editor.isMobile) {
    // The long-press sheet's actions are the menu's; pick "New folder" here.
    await flow.click('Tap "New folder"', page.locator('.mk-sheet-host').getByRole('button', { name: /^new folder/i }), {
      chain: true,
      after: () => expect(explorer.renameInput).toBeFocused()
    })
    await flow.step('Type "Invoices" and tap Enter', async () => {
      await explorer.renameInput.pressSequentially('Invoices')
      await page.keyboard.press('Enter')
      await expect(explorer.row('Invoices')).toBeVisible()
    }, { hero: true })
    const folders = await apiListFolders(page)
    const parent = folders.find(f => f.name === 'Client work')
    expect(folders.find(f => f.name === 'Invoices')?.parentId).toBe(parent?.folderId)
    flow.next({ slug: 'organize-a-workspace', why: 'Folders, moving several documents at once and search.' })
    return
  }
  await close()

  // ---------- a selection ----------
  await flow.click('Click "Reading list"', explorer.row('Reading list'), {
    chain: true,
    after: () => expect(explorer.row('Reading list')).toHaveAttribute('aria-selected', 'true')
  })
  await flow.hover('Ctrl-click "Trip notes" (Cmd-click on a Mac)', explorer.row('Trip notes'))
  await explorer.row('Trip notes').click({ modifiers: ['ControlOrMeta'] })
  await expect(explorer.selectionBar).toContainText('2 selected')
  await openActions(
    'Right-click one of the selected documents',
    explorer.row('Trip notes'),
    'The menu now acts on both: move, cut, copy both links or delete them together.',
    [/^move to/i, /^copy links/i, /^delete 2 items/i]
  )
  await close()

  // ---------- the empty space ----------
  const listBox = await explorer.list.boundingBox()
  if (!listBox) throw new Error('list has no box')
  const empty = { x: listBox.width / 2, y: listBox.height - 30 }
  await flow.hover('Right-click the empty space below the list', explorer.list)
  await explorer.list.click({ button: 'right', position: empty })
  await expect(page.getByRole('menu')).toBeVisible()
  for (const name of [/^new document/i, /^new folder/i, /^import files/i, /^sort by/i]) {
    await expect(page.getByRole('menuitem', { name })).toBeVisible()
  }
  await expect(explorer.selectionBar).toHaveCount(0)
  await flow.shot('Create something here, import files, or change the sort order.', {
    highlights: [{ label: 'Actions', selector: '[role="menu"]' }]
  })
  await flow.click('Pick "New folder"', page.getByRole('menuitem', { name: /^new folder/i }), {
    chain: true,
    after: () => expect(explorer.renameInput).toBeFocused()
  })
  await flow.step('Type "Taxes" and press Enter', async () => {
    await explorer.renameInput.pressSequentially('Taxes')
    await page.keyboard.press('Enter')
    await expect(explorer.row('Taxes')).toBeVisible()
  }, {
    hero: true,
    highlights: [{ label: 'New folder', selector: '[data-testid="explorer-list"] tbody tr[data-kind="folder"]:has-text("Taxes")' }]
  })
  expect((await apiListFolders(page)).map(f => f.name)).toContain('Taxes')

  flow.next({ slug: 'explorer-keyboard-only', why: 'Everything in the menus also has a keyboard shortcut.' })
})
