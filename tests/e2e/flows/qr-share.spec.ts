import { test, expect } from '../fixtures/flow'

// Tier 2: "Hand a doc off to your phone with a QR code".
//
// User-job: a writer is at their desk with a doc open, wants to keep
// reading it on the train, and doesn't want to email themselves a
// link or fish their phone's clipboard for it. Job done when they've
// scanned the QR code from the share modal and landed on the doc on
// their phone.
//
// What this flow is NOT: a deep tour of the share modal. The link-
// copy + access-mode tour lives in `quick-share` (Tier 1). This flow
// zooms in on the QR affordance — it's collapsed by default behind a
// small toolbar button next to the link, and most readers never
// notice it exists. A 30-second flow flips that.
//
// Works on desktop AND mobile — the share modal stacks the same way
// on narrow widths and the QR sits cleanly below the link row.
test('Share by QR code', async ({ page, flow, editor }) => {
  test.setTimeout(60_000)

  // The share modal opens from any doc — no login required, no
  // template choice. Use silentSetup so the manifest starts on the
  // share story, not on doc creation.
  await editor.silentSetup({
    title: 'Conference schedule',
    body: '# Conference schedule\n\n## Day one\n\n- 09:00 Keynote, main hall\n- 11:00 Writing for teams, room B\n- 14:00 Live demo: markoto 2.0\n'
  })

  await flow.heading('Share by QR code', 3)
  await flow.narrate(
    'You\'re at your desk with a doc open and want to keep reading '
    + 'it on your phone. The share modal has a QR toggle right next '
    + 'to the link — collapsed by default, opens to a 160-pixel '
    + 'square that any phone camera resolves into the same URL. No '
    + 'app, no clipboard handoff, no "send myself a link" detour.'
  )

  // ─── Open the share modal ───────────────────────────────────────
  await flow.click(
    'Open the share dialog from the lock icon in the header',
    editor.page.accessLockButton,
    {
      annotations: [
        { label: 'lock icon', selector: '[aria-label*="access mode" i]', kind: 'arrow' }
      ],
      result: 'The share modal opens — link at the top, QR toggle to its right.',
      after: () => page.locator('[data-testid="share-qr-toggle"]').waitFor({ state: 'visible', timeout: 5_000 })
    }
  )

  // ASSERTION: the modal opened with the QR toggle present + the QR
  // image is hidden (collapsed default — first click should reveal it).
  await expect(page.locator('[data-testid="share-modal"]')).toBeVisible()
  await expect(page.locator('[data-testid="share-qr-toggle"]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-testid="share-qr-image-wrapper"]')).toHaveCount(0)

  // ─── Reveal the QR ──────────────────────────────────────────────
  await flow.heading('Reveal the QR', 3)
  await flow.narrate(
    'Click the QR icon next to the link. The square renders below '
    + 'the link row, encoding the same URL the link field carries — '
    + 'so changing access mode (or anything else that mutates the '
    + 'link) re-renders the QR automatically. Point your phone '
    + 'camera at it and tap the notification.'
  )

  await flow.click(
    'Click the QR toggle',
    page.locator('[data-testid="share-qr-toggle"]'),
    {
      hero: true,
      result: 'The QR appears below the link — scan it from your phone to land on this doc.',
      annotations: [
        { label: 'QR toggle', selector: '[data-testid="share-qr-toggle"]', kind: 'arrow' }
      ],
      highlights: [
        { label: 'Scan with your phone camera', selector: '[data-testid="share-qr-image-wrapper"]' }
      ],
      after: () => page.locator('[data-testid="share-qr-image-wrapper"] img').waitFor({ state: 'visible', timeout: 3_000 })
    }
  )

  // ASSERTION: the QR image rendered + the toggle's aria-pressed
  // flipped to true (so the next click would dismiss it). The img
  // src is a data URL so the QR itself is in-DOM with no extra
  // request — assert the src starts with `data:image`.
  await expect(page.locator('[data-testid="share-qr-toggle"]')).toHaveAttribute('aria-pressed', 'true')
  const qrImg = page.locator('[data-testid="share-qr-image-wrapper"] img')
  await expect(qrImg).toBeVisible()
  const src = await qrImg.getAttribute('src')
  expect(src).toMatch(/^data:image\//)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Once you and your phone are on the same doc, comment threads make every passage discussable'
  })
})
