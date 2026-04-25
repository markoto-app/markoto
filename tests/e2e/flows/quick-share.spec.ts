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
  // Preamble (2 captured shots): Open YPad → Click "New Document".
  // Setup steps that follow (waitForReady + switch to split view)
  // are silent — they're not user-visible moments.
  await editor.recordPreamble()

  // ─── Name your document ────────────────────────────────────────
  await flow.heading('Name your document', 3)
  await flow.narrate(
    'Documents start untitled. Give yours a name so collaborators see '
    + 'something meaningful when they open the link.'
  )

  // Click placeholder title → input swap. The hover-then-click in
  // flow.click captures the BEFORE-click state with the cursor
  // visibly on the title button.
  await flow.click(
    'Click the placeholder title to rename it',
    editor.page.titleButton
  )
  // ASSERTION (built into commitTitleEdit): the input is focused
  // after the click, and the title button shows the new text after
  // Enter. So the rename is verified end-to-end.
  await flow.step(
    'Type your title and press Enter to save',
    () => editor.page.commitTitleEdit('Project kickoff notes')
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
