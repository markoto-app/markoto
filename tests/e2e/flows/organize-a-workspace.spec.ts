import { test, expect } from '../fixtures/flow'
import { holdPointer } from '../fixtures/waits'
import { ExplorerPage, apiCreateDoc, apiCreateWorkspace, apiListDocs, apiListFolders } from '../fixtures/explorer'

// "Organize a workspace": a team's workspace has grown to a flat pile of
// documents; the admin sorts it into folders. Job done when the documents
// sit in folders, the person can find one by a word from its text, and
// folder links work with the browser's back and forward.
//
// Desktop: New -> New folder, F2 to fix a typo, drag a document onto a
// folder, Shift-click two documents and "Move to...". Phone: the same
// folders, then "Select" mode with check boxes and "Move to..." (no drag
// and drop, no F2 on a touch screen).
test('Organize a workspace', async ({ page, flow, editor }) => {
  test.setTimeout(180_000)
  const explorer = new ExplorerPage(page)

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const workspaceId = await apiCreateWorkspace(page, 'Product team')
  const ws = { workspaceId }
  await apiCreateDoc(page, { ...ws, title: 'Launch plan', content: '# Launch plan\n\nTimeline, owners and the pricing review before the October launch.\n' })
  await apiCreateDoc(page, { ...ws, title: 'Onboarding checklist', content: '# Onboarding checklist\n\nAccounts, laptop, first week.\n' })
  await apiCreateDoc(page, { ...ws, title: 'Hiring plan', content: '# Hiring plan\n\nTwo engineers and a designer this quarter.\n' })
  await apiCreateDoc(page, { ...ws, title: 'Customer interview: Acme', content: '# Customer interview: Acme\n\nThey export every report to PDF.\n' })
  await apiCreateDoc(page, { ...ws, title: 'Customer interview: Globex', content: '# Customer interview: Globex\n\nThey want shared folders.\n' })

  await page.goto(`/w/${workspaceId}`)
  await explorer.waitForList()
  await expect(explorer.rows).toHaveCount(5)

  await flow.heading('Organize a workspace', 3)
  await flow.narrate(
    'The Documents tab of a workspace works like the file manager on your computer: folders on the left, '
    + 'the open folder on the right. Here five documents sit loose at the top level; let\'s give them a home.'
  )
  await flow.shot('Five documents, no folders yet.', {
    highlights: [{ label: 'Documents', selector: '[data-testid="explorer-list"]' }]
  })

  // ---------- create folders ----------
  await flow.heading('Create folders', 3)
  async function newFolder(name: string, typed = name): Promise<string> {
    await flow.click('Click "New"', explorer.newButton, {
      result: 'New document, New folder or Import.',
      after: () => explorer.menuItem(/^new folder/i).waitFor({ state: 'visible' })
    })
    await flow.click('Pick "New folder"', explorer.menuItem(/^new folder/i), {
      chain: true,
      after: () => expect(explorer.renameInput).toBeFocused()
    })
    await flow.step(`Type "${typed}" and press Enter`, async () => {
      await explorer.renameInput.pressSequentially(typed)
      await page.keyboard.press('Enter')
      await expect(explorer.row(typed)).toBeVisible()
    }, { highlights: [{ label: typed, selector: '[data-testid="explorer-list"] tbody tr[data-kind="folder"]' }] })
    await expect.poll(async () => (await apiListFolders(page, ws)).map(f => f.name)).toContain(typed)
    return (await apiListFolders(page, ws)).find(f => f.name === typed)?.folderId ?? ''
  }

  const researchId = await newFolder('Research')
  // Desktop: a typo, fixed with F2. A phone has no F2, so the name is typed right.
  let planningId = await newFolder('Planning', editor.isMobile ? 'Planning' : 'Planing')

  if (!editor.isMobile) {
    // The new folder is still selected: F2 renames it.
    await expect(explorer.row('Planing')).toHaveAttribute('aria-selected', 'true')
    await flow.step('Typo! The folder is still selected: press F2 to rename it', async () => {
      await page.keyboard.press('F2')
      await expect(explorer.renameInput).toBeFocused()
    })
    await flow.step('Type "Planning" and press Enter', async () => {
      await explorer.renameInput.pressSequentially('Planning')
      await page.keyboard.press('Enter')
      await expect(explorer.row('Planning')).toBeVisible()
    })
    await expect.poll(async () => (await apiListFolders(page, ws)).find(f => f.folderId === planningId)?.name).toBe('Planning')
  }
  planningId = planningId || ''

  // ---------- move documents ----------
  await flow.heading('Move documents into folders', 3)
  if (!editor.isMobile) {
    await flow.narrate('Drag a document onto a folder, in the list, in the folder tree or on the path above the list.')
    const source = explorer.row('Launch plan')
    const target = explorer.row('Planning')
    await flow.hover('Drag "Launch plan" onto "Planning"', source)
    // A real drag: the pointer leaves the row a little first (the browser
    // starts dragging), then crosses into the folder row and rests there.
    const from = await source.boundingBox()
    const box = await target.boundingBox()
    if (!from || !box) throw new Error('rows have no box')
    await page.mouse.move(from.x + 40, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + 60, from.y + from.height / 2 + 6, { steps: 4 })
    await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2, { steps: 12 })
    await page.mouse.move(box.x + box.width / 4 + 4, box.y + box.height / 2, { steps: 2 })
    await holdPointer(page, 250)
    await page.mouse.up()
    await expect(explorer.row('Launch plan')).toHaveCount(0)
    await flow.shot('"Launch plan" is in Planning now.', {
      highlights: [{ label: 'Planning', selector: '[data-testid="explorer-list"] tbody tr[data-kind="folder"]:has-text("Planning")' }]
    })
    await expect.poll(async () => (await apiListDocs(page, planningId, ws)).map(d => d.title)).toEqual(['Launch plan'])

    await flow.narrate('To move several documents at once, select them first: Ctrl-click (Cmd-click on a Mac) adds one, Shift-click adds everything in between.')
    await flow.click('Sort by name, so the two interviews sit together', page.getByTestId('explorer-sort'), {
      chain: true,
      after: () => page.getByRole('option', { name: 'Name' }).waitFor({ state: 'visible' })
    })
    await flow.click('Pick "Name"', page.getByRole('option', { name: 'Name' }), {
      result: 'The list is sorted by name.',
      after: async () => {
        await page.waitForURL(/[?&]sort=title/)
        await expect(explorer.rows.nth(2)).toContainText('Customer interview: Acme')
      }
    })
    await flow.click('Click "Customer interview: Acme"', explorer.row('Customer interview: Acme'), {
      chain: true,
      after: () => expect(explorer.row('Customer interview: Acme')).toHaveAttribute('aria-selected', 'true')
    })
    await flow.hover('Shift-click "Customer interview: Globex"', explorer.row('Customer interview: Globex'))
    await explorer.row('Customer interview: Globex').click({ modifiers: ['Shift'] })
    await expect(explorer.selectionBar).toContainText('2 selected')
    await flow.shot('Both interviews are selected.', {
      highlights: [{ label: '2 selected', selector: '[data-testid="explorer-selection-bar"]' }]
    })
  } else {
    await flow.narrate('On a phone, tap "Select" and tick the documents you want to move.')
    await flow.click('Tap "Select"', page.getByRole('button', { name: /^select$/i }), {
      result: 'Every row gets a check box.',
      after: () => page.getByRole('checkbox', { name: 'Select Customer interview: Acme' }).waitFor({ state: 'visible', timeout: 10_000 })
    })
    await flow.click('Tick "Customer interview: Acme"', page.getByRole('checkbox', { name: 'Select Customer interview: Acme' }), {
      chain: true,
      after: () => expect(explorer.selectionBar).toContainText('1 selected')
    })
    await flow.click('Tick "Customer interview: Globex"', page.getByRole('checkbox', { name: 'Select Customer interview: Globex' }), {
      result: 'Both interviews are selected.',
      after: () => expect(explorer.selectionBar).toContainText('2 selected')
    })
  }

  await flow.click('Open "Actions"', page.getByTestId('explorer-selection-actions'), {
    result: 'Everything you can do with the selection.',
    after: () => explorer.menuItem(/^move to/i).waitFor({ state: 'visible' })
  })
  await flow.click('Pick "Move to..."', explorer.menuItem(/^move to/i), {
    result: 'Pick the folder they should go to.',
    after: () => page.getByTestId('explorer-move-dialog').waitFor({ state: 'visible' })
  })
  const dialog = page.getByTestId('explorer-move-dialog')
  await flow.click('Pick "Research"', dialog.getByText('Research', { exact: true }), {
    chain: true,
    after: () => expect(page.getByTestId('explorer-move-confirm')).toBeEnabled()
  })
  await flow.click('Click "Move here"', page.getByTestId('explorer-move-confirm'), {
    hero: true,
    result: 'Both interviews moved to Research.',
    highlights: [{ label: 'Research', selector: '[data-testid="explorer-list"] tbody tr[data-kind="folder"]:has-text("Research")' }],
    after: async () => {
      await expect(explorer.row('Customer interview: Acme')).toHaveCount(0)
      await expect(explorer.row('Customer interview: Globex')).toHaveCount(0)
    }
  })
  await expect.poll(async () => (await apiListDocs(page, researchId, ws)).map(d => d.title).sort())
    .toEqual(['Customer interview: Acme', 'Customer interview: Globex'])
  await editor.page.dismissToasts()
  if (editor.isMobile) await page.getByRole('button', { name: /^done$/i }).click()

  // ---------- a folder inside a folder, breadcrumbs, back and forward ----------
  await flow.heading('Folders inside folders', 3)
  const openFolder = async (name: string) => {
    if (editor.isMobile) await explorer.row(name).click()
    else await explorer.row(name).dblclick()
  }
  await flow.hover(editor.isMobile ? 'Tap "Research" to open it' : 'Double-click "Research" to open it', explorer.row('Research'))
  await openFolder('Research')
  await page.waitForURL(new RegExp(`/w/${workspaceId}/f/${researchId}`))
  await expect(explorer.row('Customer interview: Acme')).toBeVisible()
  await flow.shot('The folder has its own address; the path above the list shows where you are.', {
    highlights: [{ label: 'Path', selector: '[data-testid="explorer-breadcrumb"]' }]
  })

  const interviewsId = await newFolder('Interviews')
  expect((await apiListFolders(page, ws)).find(f => f.folderId === interviewsId)?.parentId).toBe(researchId)

  await flow.hover(editor.isMobile ? 'Tap "Interviews" to open it' : 'Double-click "Interviews" to open it', explorer.row('Interviews'))
  await openFolder('Interviews')
  await page.waitForURL(new RegExp(`/f/${interviewsId}`))
  await expect(explorer.breadcrumb).toContainText('Interviews')
  await flow.shot('Product team / Research / Interviews.', {
    highlights: [{ label: 'Path', selector: '[data-testid="explorer-breadcrumb"]' }]
  })

  await flow.step('Use the browser\'s Back button', async () => {
    await page.goBack()
    await page.waitForURL(new RegExp(`/f/${researchId}`))
    await expect(explorer.row('Interviews')).toBeVisible()
  })
  await flow.step('And Forward again', async () => {
    await page.goForward()
    await page.waitForURL(new RegExp(`/f/${interviewsId}`))
    await expect(page.getByTestId('explorer-empty')).toBeVisible()
  })

  await flow.click('Click "Product team" in the path to go back to the top', explorer.breadcrumb.getByRole('link', { name: 'Product team' }), {
    result: 'Back at the top of the workspace: three folders and two documents.',
    after: async () => {
      await page.waitForURL(new RegExp(`/w/${workspaceId}(\\?|$)`))
      await expect(explorer.row('Planning')).toBeVisible()
    }
  })

  // ---------- search ----------
  await flow.heading('Find a document by a word in it', 3)
  await flow.narrate('The search box looks at titles and text. It searches the open folder and its subfolders; tick "All folders" to search the whole workspace.')
  if (!editor.isMobile) {
    // Search from Research: neither it nor Interviews mentions pricing, so
    // the result does not depend on how far the search index has got.
    await flow.hover('Double-click "Research" to open it', explorer.row('Research'))
    await openFolder('Research')
    await page.waitForURL(new RegExp(`/w/${workspaceId}/f/${researchId}`))
    await expect(explorer.row('Interviews')).toBeVisible()
  }
  await flow.type('Type "pricing"', explorer.search, 'pricing', {
    result: editor.isMobile ? '"Launch plan" mentions the pricing review.' : 'Nothing in Research mentions it.',
    after: async () => {
      await page.waitForURL(/[?&]q=pricing/)
      if (editor.isMobile) await expect(explorer.row('Launch plan')).toBeVisible()
      else await expect(page.getByTestId('explorer-empty')).toBeVisible()
    }
  })
  if (!editor.isMobile) {
    await flow.click('Tick "All folders"', page.getByRole('checkbox', { name: 'All folders' }), {
      result: '"Launch plan", in Planning, mentions the pricing review.',
      highlights: [{ label: 'Found', selector: '[data-testid="explorer-list"] tbody tr[data-key]' }],
      after: async () => {
        await page.waitForURL(/[?&]in=all/)
        await expect(explorer.row('Launch plan')).toBeVisible()
        await expect(explorer.row('Launch plan').locator('mark')).toContainText(/pricing/i)
      }
    })
  }

  flow.next({
    slug: 'explorer-context-menu',
    why: 'Every action on a document or folder is also a right-click away.'
  })
})
