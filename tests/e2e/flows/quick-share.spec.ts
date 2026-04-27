import { test, expect } from '../fixtures/flow'

// Tier 1, Flow 1: "Write & share your first document".
//
// User-job: an anonymous visitor needs to write something quickly
// and send it to one person. Job done when they have a shareable
// link in their clipboard.
//
// This flow is also the canonical end-to-end smoke test for the
// anonymous funnel: every assertion verifies a real product
// behaviour, not just that the screenshot looks right.
//
// Captioning rules under the v2 (approach + outcome) model:
//   • Imperative captions on flow.click(...) → "Click X", "Pick Y"
//   • Declarative `result` on the outcome → "X happens", "Y appears"
//   • narrate() = exposition; heading() = chapter break
//   • Highlights live on outcomes only — never on click targets
test('Quick share', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Preamble: open YPad → click "+ New Document" → dialog opens.
  await editor.recordPreamble()

  // ─── Set up your document ───────────────────────────────────────
  await flow.heading('Set up your document', 3)
  await flow.narrate(
    'YPad asks a few quick questions up front: what you\'re writing, who '
    + 'it\'s for, what language. The AI uses these every time it helps '
    + 'you write — so a one-time minute here saves you re-typing context '
    + 'on every prompt later. All optional; skip to a blank doc anytime.'
  )

  await flow.type(
    'Give your document a name',
    editor.page.newDocDialog.titleInput,
    'Project kickoff notes',
    { result: 'The title is set.' }
  )
  await expect(editor.page.newDocDialog.titleInput).toHaveValue('Project kickoff notes')

  await flow.type(
    'Add a one-line description so the AI knows what you\'re writing about',
    editor.page.newDocDialog.descriptionInput,
    'Notes from our team\'s Q3 kickoff meeting',
    { result: 'The description is captured — the AI will see this on every prompt.' }
  )
  await expect(editor.page.newDocDialog.descriptionInput).toHaveValue(
    'Notes from our team\'s Q3 kickoff meeting'
  )

  await flow.click(
    'Pick a template — Meeting notes seeds the right structure',
    editor.page.newDocDialog.templateCard('meeting-notes'),
    { result: '"Meeting notes" is selected — the editor will be pre-filled with its skeleton.' }
  )

  // Submit — navigates to /d/{id}. flow.click awaits the URL change
  // before the outcome screenshot via `after`, so the outcome shot
  // captures the editor (not a half-loaded transition).
  await flow.click(
    'Click "Create document" to open the editor',
    editor.page.newDocDialog.submitCreate,
    {
      result: 'The editor opens — your skeleton is ready to fill in.',
      after: async () => {
        await page.waitForURL(/\/d\/[^/]+/)
        await editor.page.waitForReady()
        await editor.page.switchToSplitView()
        // paged.js paginates async after the preview mounts — without
        // this wait, the outcome screenshot lands on an empty preview
        // pane.
        await editor.page.waitForPreviewPaginated()
      }
    }
  )

  // ─── See the seeded skeleton ────────────────────────────────────
  await flow.heading('Your skeleton is ready', 3)
  await flow.narrate(
    'YPad pre-fills the doc with the template\'s structure — headings, '
    + 'a table layout, and HTML comments hinting what to write in each '
    + 'section. The comments are visible while you edit but hidden from '
    + 'the preview, the PDF, and anyone you share the link with.'
  )

  await flow.shot(
    'Headings, an Action items checklist, comment hints — all ready to fill in.'
  )

  // ─── Share the link ─────────────────────────────────────────────
  await flow.heading('Share the link', 3)
  await flow.narrate(
    'YPad documents share by URL. Anyone with the link can read or edit, '
    + 'depending on the access mode you choose. The default for anonymous '
    + 'documents is "open edit" — anyone with the link can edit.'
  )

  // The lock icon in the header doubles as the share trigger.
  const linkInput = page.locator('[data-testid="share-link-input"]')
  await flow.click(
    'Open the share dialog from the lock icon',
    editor.page.accessLockButton,
    {
      result: 'The share dialog opens — your shareable link is right at the top.',
      highlights: [
        { label: 'The link to share', selector: '[data-testid="share-link-input"]' },
        { label: 'One-click copy', selector: '[data-testid="share-copy-link-button"]' }
      ],
      after: () => linkInput.waitFor({ state: 'visible' })
    }
  )

  // ASSERTION: the share modal actually opened, with the URL filled in.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const linkValue = await linkInput.inputValue()
  expect(linkValue).toContain(`/d/${docId}`)

  await flow.click(
    'Click "Copy link" to copy it to your clipboard',
    page.locator('[data-testid="share-copy-link-button"]'),
    { result: 'Done — your link is on your clipboard. Paste it anywhere to share.' }
  )

  // ASSERTION: the click registered + the clipboard actually has the URL.
  const copyBtn = page.locator('[data-testid="share-copy-link-button"]')
  await expect(copyBtn).toContainText(/copied|kopiert|copié|copiado|コピー|已复制/i)
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboardText).toContain(`/d/${docId}`)
})
