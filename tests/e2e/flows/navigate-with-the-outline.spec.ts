import { test, expect } from '../fixtures/flow'
import { apiCreateDoc, apiCreateFolder, apiCreateWorkspace } from '../fixtures/explorer'
import type { EditorPage } from '../page-objects/Editor'

// "Navigate with the outline".
//
// User-job: a writer deep in a long report wants to get to a chapter
// without scrolling past everything else, and then hop to another document
// of the same project without going back to the workspace page. Job done
// when they have jumped to a heading from the outline (editor and preview
// both there), seen the outline mark the section they are in, and opened
// a neighbouring document from the Workspace tab.
//
// Desktop: the panel button at the left of the toolbar, the panel beside
// the editor. Phone: the same two tabs in a bottom sheet from the menu.

const SECTIONS = [
  ['Summary', 'This was the year the company turned profitable. Revenue grew by a third and the team doubled without slowing down the release schedule.'],
  ['Customers', 'We closed the year with 2,140 paying workspaces. Most of the growth came from teams of ten to fifty people.'],
  ['Product', 'We shipped templates, workspace themes and the new export pipeline. Exports are now twice as fast.'],
  ['People', 'The team grew from 18 to 31 people across three countries. Every new colleague wrote their onboarding notes in the product.'],
  ['Finance', 'Gross margin improved by four points, mostly because hosting costs grew more slowly than revenue.'],
  ['Risks', 'Our largest risk is concentration: the ten biggest customers account for a fifth of revenue.'],
  ['Outlook', 'Next year we focus on faster collaboration on long documents and better templates for recurring reports.']
] as const

const REPORT = [
  '# Annual report',
  '',
  ...SECTIONS.flatMap(([title, text]) => [
    `## ${title}`,
    '',
    text,
    '',
    `${text} ${text}`,
    '',
    '### Key figures',
    '',
    `${text}`,
    '',
    ...(title === 'Product'
      ? ['```bash', '# a shell comment, not a heading', 'markoto export --pdf', '```', '']
      : [])
  ])
].join('\n')

/** Distance of a heading from the top of the preview, in screen pixels. */
function previewHeadingTop(editor: EditorPage, id: string): Promise<number> {
  return editor.previewRoot().evaluate((_html, headingId) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('#mount [id]')).find(e => e.id === headingId)
    return el ? el.getBoundingClientRect().top : Number.POSITIVE_INFINITY
  }, id)
}

test('Navigate with the outline', async ({ page, flow, editor }) => {
  test.setTimeout(180_000)
  const mobile = editor.isMobile

  await editor.page.loginAsTestUser('Maya Chen')
  await page.goto('/')
  const workspaceId = await apiCreateWorkspace(page, 'Product team')
  const folderId = await apiCreateFolder(page, 'Reports', { workspaceId })
  const docId = await apiCreateDoc(page, { workspaceId, folderId, title: 'Annual report', content: REPORT })
  const memoId = await apiCreateDoc(page, { workspaceId, folderId, title: 'Board memo', content: '# Board memo\n\nThree decisions for the next quarter.\n' })
  await apiCreateDoc(page, { workspaceId, title: 'Hiring plan', content: '# Hiring plan\n\nTwo engineers and a designer this quarter.\n' })

  await page.goto(`/d/${docId}`)
  await editor.page.waitForReady(30_000)
  if (!mobile) {
    await editor.page.setCoverEnabled(false)
    await editor.page.switchToSplitView()
    await editor.page.waitForPreviewPaginated(30_000)
  }

  const panel = page.getByTestId('left-panel')
  const entry = (name: string) => panel.getByRole('treeitem', { name, exact: true })
  const menuEntry = page.getByRole('menuitem', { name: /outline and documents/i })
  const openFromMenu = async (caption: string, result: string) => {
    await flow.click('Open the menu at the top right', page.getByRole('button', { name: /^menu$/i }).first(), {
      result: 'Outline and documents is one of the entries.',
      after: () => menuEntry.waitFor({ state: 'visible' })
    })
    await flow.click(caption, menuEntry, {
      result,
      after: () => expect(panel).toBeVisible()
    })
  }

  // ---------- the outline ----------
  await flow.heading('Jump to a heading', 3)
  await flow.narrate(
    'A long document is easier to move around when you can see its structure. '
    + 'The outline lists every heading of the document, with sections nested under their chapters, '
    + 'and takes you to any of them in one click.'
  )

  if (mobile) {
    await openFromMenu('Tap "Outline and documents"', 'A sheet slides up with the outline of the document.')
  } else {
    await flow.click('Click the panel button at the left end of the toolbar', page.getByTestId('left-panel-toggle'), {
      annotations: [{ label: 'outline', selector: '[data-testid="left-panel-toggle"]', kind: 'arrow' }],
      result: 'The outline opens on the left: the chapters of the report, each section under its chapter. The shell comment in the code block is not a heading, so it is not listed.',
      after: async () => {
        await expect(entry('Risks')).toBeVisible()
        await expect(panel.getByRole('treeitem')).toHaveCount(1 + SECTIONS.length * 2)
      }
    })
  }

  await flow.click(mobile ? 'Tap "Risks"' : 'Click "Risks"', entry('Risks'), {
    force: mobile,
    hero: !mobile,
    result: mobile
      ? 'The sheet closes and the editor shows the Risks section, the cursor at the end of its heading.'
      : 'The cursor jumps to the end of the Risks heading, and the editor and the preview both scroll to it.',
    after: async () => {
      await expect(page.locator('.cm-line', { hasText: '## Risks' })).toBeInViewport()
      if (mobile) {
        await expect(page.locator('.mk-sheet-host')).toHaveCount(0)
      } else {
        await expect.poll(() => previewHeadingTop(editor.page, 'risks'), { timeout: 10_000 }).toBeLessThan(200)
        await expect.poll(() => page.evaluate(() => getSelection()?.anchorNode?.textContent ?? '')).toContain('Risks')
      }
    }
  })

  if (!mobile) {
    await editor.page.scrollEditorTo('The team grew from 18 to 31')
    await flow.click('Click into the text of another section', page.locator('.cm-line', { hasText: 'The team grew from 18 to 31' }).first(), {
      result: 'The outline marks the section the cursor is in. It follows you as you write and scroll.',
      after: () => expect(entry('People')).toHaveAttribute('aria-selected', 'true')
    })
  }

  // ---------- the workspace ----------
  await flow.heading('Switch to another document', 3)
  await flow.narrate(
    'The second tab lists the documents of the workspace, in their folders, so you can switch '
    + 'without going back to the workspace page. For a document outside any workspace it lists your own documents.'
  )
  if (mobile) {
    await openFromMenu('Open "Outline and documents" again', 'The outline marks the section the cursor is in.')
    await expect(entry('Risks')).toHaveAttribute('aria-selected', 'true')
  }

  await flow.click(mobile ? 'Tap the "Workspace" tab' : 'Click the "Workspace" tab', page.getByTestId('left-panel-tab-workspace'), {
    force: mobile,
    result: 'The documents of your workspace, in their folders. The one you are in is marked.',
    after: async () => {
      await expect(entry('Annual report')).toHaveAttribute('aria-selected', 'true')
      await expect(entry('Board memo')).toBeVisible()
      await expect(entry('Hiring plan')).toBeVisible()
    }
  })

  await flow.click(mobile ? 'Tap "Board memo"' : 'Click "Board memo"', entry('Board memo'), {
    force: mobile,
    result: mobile
      ? 'Board memo opens.'
      : 'Board memo opens in the same tab, and the panel stays open for the next switch. Ctrl + click opens a document in a new tab.',
    after: async () => {
      await page.waitForURL(url => url.pathname === `/d/${memoId}`)
      await editor.page.waitForReady(30_000)
      if (!mobile) await expect(entry('Board memo')).toHaveAttribute('aria-selected', 'true')
    }
  })

  if (!mobile) {
    await flow.heading('From the keyboard', 3)
    await flow.narrate(
      'Ctrl + Shift + E (Cmd + Shift + E on a Mac) shows and hides the panel and puts you on its tabs. '
      + 'In the outline and the document list, the arrow keys move between entries, Right and Left open and close a section, and Enter jumps to it.'
    )
    const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.locator('.cm-content').click()
    await flow.step('Press Ctrl + Shift + E to hide the panel', async () => {
      await page.keyboard.press(`${accel}+Shift+KeyE`)
      await expect(panel).toHaveCount(0)
    })
  }

  flow.next({
    slug: 'organize-a-workspace',
    why: 'Sort the documents of your workspace into folders'
  })
})
