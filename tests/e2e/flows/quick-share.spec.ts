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

  // Title + intro before the preamble captures anything. Every flow
  // opens with a chapter card and a one-paragraph narration so the
  // reader knows what they're about to see before the screenshots
  // start rolling.
  await flow.heading('Write & share your first document', 3)
  await flow.narrate(
    'You don\'t need an account to write something quickly in markoto. '
    + 'Open the homepage, type, copy the link — anyone you send it to '
    + 'sees what you wrote, in real time. About three minutes; by the '
    + 'end you have a named document and a shareable URL on your '
    + 'clipboard.'
  )

  // Preamble: open markoto → click "+ New Document" → dialog opens.
  await editor.recordPreamble()

  // ─── Set up your document ───────────────────────────────────────
  await flow.heading('Set up your document', 3)
  await flow.narrate(
    'Name your document and you can start. Under Details, tell markoto '
    + 'what you\'re writing, who it\'s for and in which language: the AI uses '
    + 'this every time it helps you write, so a minute here saves you '
    + 're-typing context on every prompt later. All optional.'
  )

  await flow.type(
    'Give your document a name',
    editor.page.newDocDialog.titleInput,
    'Project kickoff notes',
    { result: 'The title is set.' }
  )
  await expect(editor.page.newDocDialog.titleInput).toHaveValue('Project kickoff notes')

  await flow.click(
    'Open "Details"',
    editor.page.newDocDialog.section('details'),
    {
      result: 'Description, language and audience open.',
      after: async () => {
        await expect(editor.page.newDocDialog.descriptionInput).toBeVisible()
      }
    }
  )

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
    'Open "Template" to start from a template',
    editor.page.newDocDialog.section('template'),
    {
      result: 'The templates open: each card shows the first page of its text in its design.',
      after: async () => {
        await expect(editor.page.newDocDialog.templateCard('meeting-notes')).toBeVisible()
      }
    }
  )

  await flow.click(
    'Pick a template — Meeting notes seeds the right structure',
    editor.page.newDocDialog.templateCard('meeting-notes'),
    { result: '"Meeting notes" is selected — the editor will be pre-filled with its skeleton, in its design.' }
  )

  // Submit. Without an account, the first document in this browser
  // asks for one confirmation (terms + age); a bot check runs in the
  // background meanwhile.
  await flow.click(
    'Click "Create document"',
    editor.page.newDocDialog.submitCreate,
    {
      result: 'Without an account, markoto asks once: accept the Terms and confirm you\'re at least 16. A quick bot check runs in your browser meanwhile.',
      after: async () => {
        await expect(editor.page.anonGate.dialog).toBeVisible()
      }
    }
  )

  await flow.click(
    'Tick the box to accept the Terms',
    editor.page.anonGate.accept,
    { result: 'Accepted. You won\'t be asked again in this browser.' }
  )

  // Continue — navigates to /d/{id}. flow.click awaits the URL change
  // before the outcome screenshot via `after`, so the outcome shot
  // captures the editor (not a half-loaded transition).
  await flow.click(
    'Click "Accept and create" to open the editor',
    editor.page.anonGate.continue,
    {
      result: 'The editor opens — your skeleton is ready to fill in.',
      after: async () => {
        await page.waitForURL(/\/d\/[^/]+/)
        await editor.page.waitForReady()
        // Desktop: split view + paged.js wait so the outcome shot
        // lands on a populated preview. Mobile: edit-only by design
        // (AGENTS.md §11), so we skip both.
        if (!editor.isMobile) {
          await editor.page.switchToSplitView()
          await editor.page.waitForPreviewPaginated()
        }
      }
    }
  )

  // ─── See the seeded skeleton ────────────────────────────────────
  await flow.heading('Your skeleton is ready', 3)
  await flow.narrate(
    'markoto pre-fills the doc with the template\'s structure — headings, '
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
    'markoto documents share by URL. Anyone with the link can read or edit, '
    + 'depending on the access mode you choose. The default for anonymous '
    + 'documents is "open edit" — anyone with the link can edit.'
  )

  // The lock icon in the header doubles as the share trigger.
  // The icon is small + sits in the topbar — direction-anchor it on
  // the approach frame so a reader can find it even on the first
  // pass (without scanning the whole header).
  const linkInput = page.locator('[data-testid="share-link-input"]')
  await flow.click(
    'Open the share dialog from the lock icon',
    editor.page.accessLockButton,
    {
      result: 'The share dialog opens — your shareable link is right at the top.',
      annotations: [
        { label: 'lock icon', selector: '[aria-label*="access mode" i]', kind: 'arrow' }
      ],
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
    {
      // Hero outcome: the moment the user has done the job. A
      // shareable link sitting in the clipboard with the "copied"
      // confirmation visible is the canonical "I built something
      // someone else can read" payoff.
      hero: true,
      result: 'Done — your link is on your clipboard. Paste it anywhere to share.'
    }
  )

  // ASSERTION: the click registered + the clipboard actually has the URL.
  const copyBtn = page.locator('[data-testid="share-copy-link-button"]')
  await expect(copyBtn).toContainText(/copied|kopiert|copié|copiado|コピー|已复制/i)
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboardText).toContain(`/d/${docId}`)

  // Forward route: the natural next step after sharing a link is to
  // collaborate on the doc — the comments-thread flow picks up where
  // this one ends (someone joins via the link, leaves a thought).
  flow.next({
    slug: 'have-a-discussion',
    why: 'Now invite a teammate — leave a comment on a passage they wrote'
  })
})
