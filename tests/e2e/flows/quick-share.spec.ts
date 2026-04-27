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
// Captioning rule: user-voice only. No "Hocuspocus", no "the
// editor mounts", no "the read-only flag resolves".

test('Quick share', async ({ page, flow, editor }) => {
  // Preamble (2 captured shots): Open YPad → Click "+ New Document".
  // The click now opens a dialog (introduced when we made title /
  // description / language / audience / theme / template first-class
  // creation-time choices) — the preamble stops there and lets the
  // narrative below walk through it.
  await editor.recordPreamble()

  // ─── Set up your document ───────────────────────────────────────
  await flow.heading('Set up your document', 3)
  await flow.narrate(
    'YPad asks a few quick questions up front: what you\'re writing, who '
    + 'it\'s for, what language. The AI uses these every time it helps '
    + 'you write — so a one-time minute here saves you re-typing context '
    + 'on every prompt later. All optional; skip to a blank doc anytime.'
  )

  // First captured frame of the dialog. Highlights the title input
  // (most-impactful field) AND the skip button (so users know there's
  // an escape hatch if they're in a hurry).
  await flow.shot('The new-document dialog asks five quick questions', {
    highlights: [
      { label: 'Most-important field', selector: '[data-testid="newdoc-title-input"]' },
      { label: 'Skip the form entirely', selector: '[data-testid="newdoc-submit-blank"]' }
    ]
  })

  // Type the title. ASSERTION (built into the input): pressSequentially
  // fires real keystroke events that drive the v-model bind, so the
  // input value reflects the typed text.
  await flow.step(
    'Give your document a name',
    () => editor.page.newDocDialog.titleInput.pressSequentially('Project kickoff notes')
  )
  await expect(editor.page.newDocDialog.titleInput).toHaveValue('Project kickoff notes')

  // Type the description. The AI sees this on every prompt, so it's
  // worth taking the moment.
  await flow.step(
    'Add a one-line description so the AI knows what you\'re writing about',
    () => editor.page.newDocDialog.descriptionInput.pressSequentially(
      'Notes from our team\'s Q3 kickoff meeting'
    )
  )
  await expect(editor.page.newDocDialog.descriptionInput).toHaveValue(
    'Notes from our team\'s Q3 kickoff meeting'
  )

  // Pick a template. Meeting notes is the right shape for this flow's
  // story — it'll seed an Agenda / Discussion / Decisions / Action items
  // skeleton with comment hints the AI follows when filling in.
  await flow.click(
    'Pick a template — Meeting notes seeds the right structure',
    editor.page.newDocDialog.templateCard('meeting-notes')
  )

  // Submit. Click-then-navigate, so flow.click hovers FIRST (cursor on
  // the submit button) BEFORE the navigation away from the homepage —
  // otherwise the screenshot would land on the editor with a stale
  // cursor floating over irrelevant geometry. ASSERTION: URL changes
  // to /d/{id} and the editor mounts.
  await Promise.all([
    page.waitForURL(/\/d\/[^/]+/),
    flow.click(
      'Click "Create document" to open the editor',
      editor.page.newDocDialog.submitCreate
    )
  ])

  // Setup, not a step: wait for sync + put the editor in split view
  // so the next captured shot shows source + preview side-by-side.
  await editor.page.waitForReady()
  await editor.page.switchToSplitView()

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
  await flow.click(
    'Open the share dialog from the lock icon',
    editor.page.accessLockButton
  )

  // ASSERTION: the share modal actually opened, with the URL filled in.
  // The modal renders a full origin-absolute URL on the client (so a
  // pasted link works from anywhere), so we substring-match rather
  // than exact-match — the test should pass against any host.
  const linkInput = page.locator('[data-testid="share-link-input"]')
  await expect(linkInput).toBeVisible()
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  expect(docId).toBeTruthy()
  const linkValue = await linkInput.inputValue()
  expect(linkValue).toContain(`/d/${docId}`)

  await flow.shot('Your shareable link is right at the top of the dialog', {
    highlights: [
      { label: 'The link to share', selector: '[data-testid="share-link-input"]' },
      { label: 'One-click copy', selector: '[data-testid="share-copy-link-button"]' }
    ]
  })

  await flow.click(
    'Click "Copy link" to copy it to your clipboard',
    page.locator('[data-testid="share-copy-link-button"]')
  )

  // ASSERTION: the click registered + the clipboard actually has the URL.
  // The button text + icon flip to a "Link copied" success state — that's
  // the user-visible confirmation. We also read the clipboard directly to
  // verify the actual outcome (clipboard permissions pre-granted in
  // playwright.config). If either of these regresses the share flow is
  // broken even if the screenshots still look right.
  const copyBtn = page.locator('[data-testid="share-copy-link-button"]')
  await expect(copyBtn).toContainText(/copied|kopiert|copié|copiado|コピー|已复制/i)
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboardText).toContain(`/d/${docId}`)

  await flow.shot(
    'Done — your link is on your clipboard. Paste it anywhere to share.'
  )
})
