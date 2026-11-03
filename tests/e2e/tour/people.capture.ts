import type { Page } from '@playwright/test'
import type { EditorFixture } from '../fixtures/flow'
import { test, expect, editorTo, settlePreview, applyTheme, useOwnMistralKey, withCover } from './fixture'
import { demoDocument as demo } from './content/demoDocument'
import { fakeOpenAiBaseUrl } from '../../integration/setup/env'

// Scenes 4, 7 and 9: three people writing in the report at once with a
// comment and a reply, the activity log with a diff and a restore, and the
// AI provider settings ("Connected").

const noCover = withCover(demo.theme, false)

async function openReport(page: Page, editor: EditorFixture): Promise<void> {
  await editor.page.loginAsTestUser(demo.author)
  await useOwnMistralKey(page)
  await editor.silentSetup({ title: demo.title, body: demo.markdown })
  await applyTheme(page, noCover)
  await editor.page.setAccessMode('open-edit')
  await settlePreview(page, 1500)
}

/** Centre the preview on the paragraph that contains `text`. */
async function previewToText(page: Page, text: string): Promise<void> {
  const target = page.frameLocator('iframe').first().locator('#mount :is(p, li, td)', { hasText: text }).first()
  await expect(target).toBeAttached({ timeout: 20_000 })
  await target.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
}

/** Put a spawned actor's caret at the end of the line containing `anchor`. */
async function caretAfter(page: Page, anchor: string): Promise<void> {
  await editorTo(page, anchor)
  await page.locator('.cm-content').getByText(anchor).first().click()
  await page.keyboard.press('End')
}

/** Invite `actor` (signed in as `email`) to the workspace and accept the invite as them. */
async function joinWorkspace(owner: Page, actor: Page, workspaceId: string, email: string): Promise<void> {
  const invite = await owner.request.post(`/api/workspaces/${workspaceId}/members`, { data: { email, role: 'editor' } })
  expect(invite.ok(), await invite.text()).toBe(true)
  const list = await actor.request.get('/api/user/invites')
  const invites: unknown = await list.json()
  const first: unknown = Array.isArray(invites) ? invites[0] : null
  const inviteId = typeof first === 'object' && first !== null ? String(Reflect.get(first, 'inviteId')) : ''
  const accept = await actor.request.post(`/api/user/invites/${inviteId}/accept`)
  expect(accept.ok(), await accept.text()).toBe(true)
}

test('Tour: write together', async ({ page, flow, editor, tour }) => {
  test.setTimeout(600_000)
  // A workspace with the two colleagues as members (mentions list workspace members).
  await editor.page.loginAsTestUser(demo.author)
  await useOwnMistralKey(page)
  await page.goto('/')
  const wsRes = await page.request.post('/api/workspaces', { data: { name: 'Quaybridge finance' } })
  expect(wsRes.ok(), await wsRes.text()).toBe(true)
  const ws: unknown = await wsRes.json()
  const workspaceId = typeof ws === 'object' && ws !== null ? String(Reflect.get(ws, 'workspaceId')) : ''
  const sanne = await flow.spawn('sanne')
  await sanne.editor.loginAsTestUser(demo.collaborator, { email: 'sanne.kuipers@quaybridge.example' })
  const johanna = await flow.spawn('johanna')
  await johanna.editor.loginAsTestUser('Johanna Severin', { email: 'johanna.severin@quaybridge.example' })
  await joinWorkspace(page, sanne.page, workspaceId, 'sanne.kuipers@quaybridge.example')
  await joinWorkspace(page, johanna.page, workspaceId, 'johanna.severin@quaybridge.example')

  const docRes = await page.request.post('/api/docs', { data: { workspaceId, title: demo.title } })
  expect(docRes.ok(), await docRes.text()).toBe(true)
  const doc: unknown = await docRes.json()
  const docId = typeof doc === 'object' && doc !== null ? String(Reflect.get(doc, 'docId')) : ''
  await page.goto(`/d/${docId}`)
  await editor.page.waitForReady()
  await editor.page.setDocText(demo.markdown)
  await editor.page.switchToSplitView()
  await editor.page.waitForPreviewPaginated()
  await applyTheme(page, noCover)
  await settlePreview(page, 1500)
  await editorTo(page, 'Three things drove the quarter')

  await sanne.page.goto(page.url())
  await sanne.editor.waitForReady()
  await johanna.page.goto(page.url())
  await johanna.editor.waitForReady()

  // Both colleagues park their carets in sections near the author's view.
  await caretAfter(sanne.page, demo.collaboratorAnchor)
  await caretAfter(johanna.page, 'We are raising full-year guidance')
  await settlePreview(page)

  const clip = await tour.clip('collab')
  await clip.frame(10)
  // They type at the same time, a few characters each per frame.
  const a = ` ${demo.collaboratorSentence}`
  const b = ' The board approved the revised plan on 21 October.'
  for (let i = 0; i < Math.max(a.length, b.length); i += 3) {
    if (i < a.length) await sanne.page.keyboard.type(a.slice(i, i + 3))
    if (i < b.length) await johanna.page.keyboard.type(b.slice(i, i + 3))
    await page.waitForTimeout(120)
    await clip.frame()
  }
  await expect.poll(() => editor.page.docText()).toContain(demo.collaboratorSentence)
  await clip.frame(8)

  // The author comments on a passage and mentions Sanne.
  const line = page.locator('.cm-line', { hasText: demo.commentAnchor }).first()
  await clip.click(line.getByText(demo.commentAnchor).first())
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await clip.frame(3)
  await clip.click(editor.page.comments.selectionPopupTrigger, {
    after: async () => { await editor.page.comments.composerInput.waitFor({ state: 'visible' }) }
  })
  await clip.type('Can you add the guidance raise here? ', 4)
  await clip.type('@San', 2)
  const mention = page.locator('[data-testid^="mention-typeahead-user-"]', { hasText: 'Sanne' }).first()
  await expect(mention).toBeVisible({ timeout: 10_000 })
  await clip.frame(4)
  await clip.click(mention)
  await clip.frame(3)
  await clip.click(editor.page.comments.composerSubmit)
  const thread = editor.page.comments.thread.first()
  await expect(thread).toBeVisible({ timeout: 10_000 })
  await clip.frame(8)

  // Sanne replies; it arrives on the author's screen.
  await sanne.editor.sidebar.comments.click()
  const sanneThread = sanne.editor.comments.thread.first()
  await expect(sanneThread).toBeVisible({ timeout: 15_000 })
  const reply = sanneThread.locator('[data-testid="comment-composer-input"]').first()
  await reply.click()
  const replyText = 'Done, it is in the second paragraph now.'
  await clip.cursor(false)
  for (let i = 0; i < replyText.length; i += 6) {
    await reply.pressSequentially(replyText.slice(i, i + 6))
    await clip.frame()
  }
  await sanneThread.locator('[data-testid="comment-composer-submit"]').first().click()
  await expect(thread).toContainText('second paragraph', { timeout: 15_000 })
  await clip.frame(10)
  await clip.done({
    description: 'Two colleagues type in different sections of the report at the same time; the author comments, mentions one of them, and the reply arrives.',
    focus: thread
  })
})

test('Tour: nothing is lost', async ({ page, flow, editor, tour }) => {
  test.setTimeout(900_000)
  await openReport(page, editor)
  const docId = editor.page.currentDocId()
  const editRows = async (): Promise<number> => {
    const res = await page.request.get(`/api/docs/${docId}/activity`)
    if (!res.ok()) return 0
    const rows: unknown = await res.json()
    return Array.isArray(rows) ? rows.length : 0
  }
  const sanne = await flow.spawn('sanne')
  await sanne.editor.loginAsTestUser(demo.collaborator)
  await sanne.page.goto(page.url())
  await sanne.editor.waitForReady()
  const johanna = await flow.spawn('johanna')
  await johanna.editor.loginAsTestUser('Johanna Severin')
  await johanna.page.goto(page.url())
  await johanna.editor.waitForReady()

  // A realistic history: several people revise the report over time, each
  // edit in its own batch (the sync server groups edits within ~2 s).
  const edits: Array<[Page, string, string]> = [
    [sanne.page, 'Gross revenue retention also slipped one point', ' Both remaining at-risk accounts renewed in October.'],
    [johanna.page, 'We are raising full-year guidance', ' The board approved the revised plan on 21 October.'],
    [page, 'Revenue for the quarter was EUR 6,510 k', ' Seasonality was in line with prior years.'],
    [sanne.page, 'Four customers with combined ARR of EUR 180 k left in the quarter.', ' None of them cited product gaps.'],
    [sanne.page, 'Slot Forecast generally available.', ' Live at 64 sites by the end of September.']
  ]
  for (const [actor, anchor, text] of edits) {
    const before = await editRows()
    await caretAfter(actor, anchor)
    await actor.keyboard.type(text)
    await expect.poll(editRows, { timeout: 20_000 }).toBeGreaterThan(before)
    await page.waitForTimeout(3000)
  }
  // …and the AI, asked by the author to tighten a paragraph.
  const beforeAi = await editRows()
  await editor.page.ai.promptBarInput.fill('Shorten the first paragraph of the "Churn" section to two sentences without changing any figures.')
  await editor.page.ai.promptBarSend.click()
  await editor.page.waitForAiActive()
  await editor.page.waitForAiIdle()
  await expect.poll(editRows, { timeout: 30_000 }).toBeGreaterThan(beforeAi)
  await page.waitForTimeout(3000)
  // One mistake to undo: a sentence that should not have gone in.
  const mistake = ' Preliminary figures, do not circulate.'
  await caretAfter(page, 'Q3 2026 was the quarter in which Quaybridge turned')
  const before = await editRows()
  await page.keyboard.type(mistake)
  await expect.poll(editRows, { timeout: 20_000 }).toBeGreaterThan(before)
  await settlePreview(page)

  const clip = await tour.clip('history')
  await clip.frame(6)
  await clip.click(editor.page.sidebar.activity, {
    after: async () => { await page.locator('[data-activity-id]').first().waitFor({ state: 'visible', timeout: 15_000 }) }
  })
  await clip.frame(6)
  // Scroll through the log, then back to the newest entry.
  const feed = page.locator('[data-activity-id]').first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]')
  for (let i = 0; i < 6; i++) {
    await feed.evaluate((el: HTMLElement) => {
      el.scrollTop += 120
    }).catch(() => {})
    await clip.frame(2)
  }
  await feed.evaluate((el: HTMLElement) => {
    el.scrollTop = 0
  }).catch(() => {})
  await clip.frame(4)
  const newest = page.locator('[data-activity-id]').first()
  await clip.click(newest, {
    after: async () => {
      await expect(newest).toHaveAttribute('data-expanded', 'true', { timeout: 10_000 })
      await page.waitForTimeout(800)
    }
  })
  await clip.frame(14)
  const restore = page.locator('[data-testid^="activity-row-restore-"]').first()
  await clip.click(restore, { after: () => page.locator('[data-testid="restore-confirm"]').waitFor({ state: 'visible', timeout: 5_000 }) })
  await clip.frame(6)
  await clip.click(page.locator('[data-testid="restore-confirm"]'), {
    after: async () => {
      await expect.poll(() => editor.page.docText(), { timeout: 15_000 }).not.toContain(mistake.trim())
    }
  })
  await editorTo(page, 'Q3 2026 was the quarter in which Quaybridge turned')
  await previewToText(page, 'Q3 2026 was the quarter in which Quaybridge turned')
  await clip.frame(8)
  await editor.page.dismissToasts().catch(() => {})
  await clip.frame()
  await clip.done({
    description: 'The activity log of the report: edits by three people over time, one expanded into its diff, then restored.',
    focus: page.locator('[data-activity-id]').first()
  })
})

/** Deep-replace provider strings in an API payload (fake provider ↔ what the frame shows). */
function mapPayload(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map(v => mapPayload(v, map))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = k === 'allowPrivate' ? false : mapPayload(v, map)
    return out
  }
  return value
}

test('Tour: yours', async ({ page, editor, tour }) => {
  test.setTimeout(240_000)
  await editor.page.loginAsTestUser(demo.author)
  // The stack's fake OpenAI-compatible provider answers the verification;
  // the frames show the provider a reader would actually configure.
  const SHOWN_BASE_URL = 'https://api.mistral.ai/v1'
  const SHOWN_MODEL = 'mistral-small-2603'
  const fakeBaseUrl = fakeOpenAiBaseUrl()
  const toFake = new Map([[SHOWN_BASE_URL, fakeBaseUrl], [SHOWN_MODEL, 'fake-chat']])
  const toShown = new Map([[fakeBaseUrl, SHOWN_BASE_URL], [new URL(fakeBaseUrl).host, 'api.mistral.ai'], [new URL(fakeBaseUrl).hostname, 'api.mistral.ai'], ['fake-chat', SHOWN_MODEL]])
  await page.route('**/api/user/ai-providers**', async (route) => {
    const raw = route.request().postData()
    const postData = raw ? JSON.stringify(mapPayload(JSON.parse(raw), toFake)) : undefined
    const response = await route.fetch({ postData })
    const text = await response.text()
    let body = text
    try {
      body = JSON.stringify(mapPayload(JSON.parse(text), toShown))
    } catch { /* not JSON */ }
    await route.fulfill({ response, body })
  })
  await page.goto('/settings/ai')
  await page.getByTestId('ai-provider-card-chat').waitFor({ state: 'visible', timeout: 15_000 })
  const clip = await tour.clip('yours')
  await clip.frame(8)
  await clip.click(page.getByTestId('ai-provider-edit-chat'), {
    after: () => expect(page.getByTestId('ai-provider-base-url-chat')).toHaveValue(SHOWN_BASE_URL)
  })
  await clip.frame(4)
  await clip.click(page.getByTestId('ai-provider-model-chat'))
  await page.getByTestId('ai-provider-model-chat').fill('')
  await clip.type(SHOWN_MODEL, 3)
  await clip.click(page.getByTestId('ai-provider-api-key-chat'))
  await clip.type('sk-tour-demo-key-7311', 4)
  await clip.frame(4)
  await clip.click(page.getByTestId('ai-provider-save-chat'), {
    after: async () => {
      await expect(page.getByTestId('ai-provider-message-chat')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('ai-provider-key-chat')).toContainText('7311')
    }
  })
  await editor.page.dismissToasts().catch(() => {})
  const card = page.getByTestId('ai-provider-card-chat')
  await clip.moveTo(page.getByTestId('ai-provider-message-chat'))
  await clip.frame(8)
  await clip.done({
    description: 'AI provider settings: the writing assistant connected to the user’s own provider and verified.',
    focus: card
  })
})
